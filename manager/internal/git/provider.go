package git

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Provider types. They name both the git_providers.provider_type column and the
// services.provider column, so a service sourced from a connection says which
// kind of connection it wants.
const (
	ProviderGitHub    = "github"
	ProviderGitLab    = "gitlab"
	ProviderBitbucket = "bitbucket"
	ProviderGitea     = "gitea"
)

func IsProviderType(s string) bool {
	switch s {
	case ProviderGitHub, ProviderGitLab, ProviderBitbucket, ProviderGitea:
		return true
	}
	return false
}

// Account is one connected provider with its secrets already decrypted and,
// for the OAuth providers, already refreshed. It is what every listing and
// every clone goes through, so the four providers differ in exactly one place:
// how this struct gets filled in.
type Account struct {
	Type string

	// Host is the origin of the instance the account lives on: github.com, a
	// self-hosted GitLab, a Gitea. Both the API root and the clone URL derive
	// from it.
	Host string

	// Token authenticates GitHub (an installation token), GitLab and Gitea (an
	// OAuth access token).
	Token string

	// Username and Password are Bitbucket's credential pair, either a username
	// with an app password or an account email with an API token.
	Username string
	Password string

	// Scope narrows a listing to one GitLab group, one Gitea organization or
	// one Bitbucket workspace. Empty lists everything the credential reaches.
	Scope string
}

type Repository struct {
	Name  string `json:"name"`
	Owner string `json:"owner"`
	URL   string `json:"url"`
}

func (a Account) Credential() Credential {
	if a.Type == ProviderBitbucket {
		return Credential{Kind: KindToken, Value: a.Password, User: a.Username}
	}
	// GitHub, GitLab and Gitea all accept the OAuth token as the password with
	// a placeholder username; oauth2 is the name all three document.
	return Credential{Kind: KindToken, Value: a.Token, User: "oauth2"}
}

// CloneURL is the HTTPS remote for one repository on this account. Credentials
// stay out of it: Repo feeds them to git through askpass instead, so they never
// reach a process listing or a deployment log.
func (a Account) CloneURL(owner, repository string) string {
	return fmt.Sprintf("%s/%s/%s.git", strings.TrimSuffix(a.Host, "/"), owner, repository)
}

// Repositories lists what the account can deploy from. Each provider paginates
// and names its fields differently; the shape returned is the same.
func (a Account) Repositories(ctx context.Context) ([]Repository, error) {
	switch a.Type {
	case ProviderGitHub:
		return a.githubRepositories(ctx)
	case ProviderGitLab:
		return a.gitlabRepositories(ctx)
	case ProviderBitbucket:
		return a.bitbucketRepositories(ctx)
	case ProviderGitea:
		return a.giteaRepositories(ctx)
	}
	return nil, fmt.Errorf("unknown git provider %q", a.Type)
}

func (a Account) Branches(ctx context.Context, owner, repository string) ([]string, error) {
	if owner == "" || repository == "" {
		return nil, fmt.Errorf("owner and repository are required")
	}
	switch a.Type {
	case ProviderGitHub:
		return a.namedBranches(ctx, a.apiURL("/repos/"+owner+"/"+repository+"/branches?per_page=100"))
	case ProviderGitLab:
		project := url.PathEscape(owner + "/" + repository)
		return a.namedBranches(ctx, a.apiURL("/projects/"+project+"/repository/branches?per_page=100"))
	case ProviderBitbucket:
		return a.bitbucketBranches(ctx, owner, repository)
	case ProviderGitea:
		return a.namedBranches(ctx, a.apiURL("/repos/"+owner+"/"+repository+"/branches?limit=100"))
	}
	return nil, fmt.Errorf("unknown git provider %q", a.Type)
}

// apiURL turns a provider-relative path into an absolute one. Every provider
// roots its API somewhere different.
func (a Account) apiURL(path string) string {
	host := strings.TrimSuffix(a.Host, "/")
	switch a.Type {
	case ProviderGitHub:
		return apiRoot(host) + path
	case ProviderGitLab:
		return host + "/api/v4" + path
	case ProviderBitbucket:
		return "https://api.bitbucket.org/2.0" + path
	case ProviderGitea:
		return host + "/api/v1" + path
	}
	return host + path
}

// namedBranches reads the three providers whose branch listing is an array of
// objects with a name.
func (a Account) namedBranches(ctx context.Context, endpoint string) ([]string, error) {
	var payload []struct {
		Name string `json:"name"`
	}
	if err := a.get(ctx, endpoint, &payload); err != nil {
		return nil, err
	}
	branches := make([]string, 0, len(payload))
	for _, b := range payload {
		branches = append(branches, b.Name)
	}
	return branches, nil
}

func (a Account) get(ctx context.Context, endpoint string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	a.authorize(req)
	resp, err := providerHTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return apiError(a.Type, resp)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (a Account) authorize(req *http.Request) {
	switch a.Type {
	case ProviderBitbucket:
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(a.Username+":"+a.Password)))
	case ProviderGitHub:
		req.Header.Set("Authorization", "Bearer "+a.Token)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	default:
		req.Header.Set("Authorization", "Bearer "+a.Token)
	}
	req.Header.Set("User-Agent", "vexdock")
}

// providerHTTP is the client every provider call shares. The timeout is per
// request, and a repository listing of a large organization is several
// requests, so it is generous rather than tight.
var providerHTTP = &http.Client{Timeout: 30 * time.Second}

// apiError turns a provider's error response into a message worth showing. The
// body is capped because a misconfigured self-hosted instance answers an API
// call with an HTML login page.
func apiError(provider string, resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	detail := strings.TrimSpace(string(body))
	if detail == "" {
		return fmt.Errorf("%s api: %s", provider, resp.Status)
	}
	return fmt.Errorf("%s api: %s: %s", provider, resp.Status, detail)
}

// githubRepositories lists what the App installation was granted, which is the
// set the owner ticked when installing. A personal token would see everything
// the person can see; an installation sees only what it was given.
func (a Account) githubRepositories(ctx context.Context) ([]Repository, error) {
	var page struct {
		Repositories []struct {
			Name    string `json:"name"`
			HTMLURL string `json:"html_url"`
			Owner   struct {
				Login string `json:"login"`
			} `json:"owner"`
		} `json:"repositories"`
	}
	if err := a.get(ctx, a.apiURL("/installation/repositories?per_page=100"), &page); err != nil {
		return nil, err
	}
	repos := make([]Repository, 0, len(page.Repositories))
	for _, r := range page.Repositories {
		repos = append(repos, Repository{Name: r.Name, Owner: r.Owner.Login, URL: r.HTMLURL})
	}
	return repos, nil
}

// gitlabRepositories lists the projects the authorising user is a member of,
// narrowed to one group when the connection names one.
func (a Account) gitlabRepositories(ctx context.Context) ([]Repository, error) {
	var projects []struct {
		Name              string `json:"name"`
		PathWithNamespace string `json:"path_with_namespace"`
		WebURL            string `json:"web_url"`
		Namespace         struct {
			FullPath string `json:"full_path"`
		} `json:"namespace"`
	}
	if err := a.get(ctx, a.apiURL("/projects?membership=true&per_page=100&order_by=last_activity_at"), &projects); err != nil {
		return nil, err
	}
	repos := make([]Repository, 0, len(projects))
	for _, p := range projects {
		owner := p.Namespace.FullPath
		if owner == "" {
			// Older GitLab omits the namespace object; the path carries it.
			owner = strings.TrimSuffix(p.PathWithNamespace, "/"+p.Name)
		}
		if a.Scope != "" && !strings.EqualFold(strings.Split(owner, "/")[0], a.Scope) {
			continue
		}
		// path_with_namespace is what clones, so the last segment is the
		// repository slug, not the display name GitLab also returns.
		name := p.PathWithNamespace
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		repos = append(repos, Repository{Name: name, Owner: owner, URL: p.WebURL})
	}
	return repos, nil
}

// bitbucketRepositories lists a workspace's repositories, or every repository
// the credential is a member of when no workspace is named.
func (a Account) bitbucketRepositories(ctx context.Context) ([]Repository, error) {
	endpoint := a.apiURL("/repositories?role=member&pagelen=100")
	if a.Scope != "" {
		endpoint = a.apiURL("/repositories/" + url.PathEscape(a.Scope) + "?pagelen=100")
	}
	var page struct {
		Values []struct {
			Name     string `json:"name"`
			FullName string `json:"full_name"`
			Links    struct {
				HTML struct {
					Href string `json:"href"`
				} `json:"html"`
			} `json:"links"`
		} `json:"values"`
	}
	if err := a.get(ctx, endpoint, &page); err != nil {
		return nil, err
	}
	repos := make([]Repository, 0, len(page.Values))
	for _, r := range page.Values {
		owner, slug, ok := strings.Cut(r.FullName, "/")
		if !ok {
			continue
		}
		repos = append(repos, Repository{Name: slug, Owner: owner, URL: r.Links.HTML.Href})
	}
	return repos, nil
}

// bitbucketBranches reads Bitbucket's paginated refs endpoint, which nests the
// branch name one level deeper than everybody else.
func (a Account) bitbucketBranches(ctx context.Context, owner, repository string) ([]string, error) {
	var page struct {
		Values []struct {
			Name string `json:"name"`
		} `json:"values"`
	}
	endpoint := a.apiURL("/repositories/" + owner + "/" + repository + "/refs/branches?pagelen=100")
	if err := a.get(ctx, endpoint, &page); err != nil {
		return nil, err
	}
	branches := make([]string, 0, len(page.Values))
	for _, b := range page.Values {
		branches = append(branches, b.Name)
	}
	return branches, nil
}

// giteaRepositories lists the authorising user's repositories, or one
// organization's when the connection names one.
func (a Account) giteaRepositories(ctx context.Context) ([]Repository, error) {
	endpoint := a.apiURL("/user/repos?limit=100")
	if a.Scope != "" {
		endpoint = a.apiURL("/orgs/" + url.PathEscape(a.Scope) + "/repos?limit=100")
	}
	var payload []struct {
		Name    string `json:"name"`
		HTMLURL string `json:"html_url"`
		Owner   struct {
			Login string `json:"login"`
		} `json:"owner"`
	}
	if err := a.get(ctx, endpoint, &payload); err != nil {
		return nil, err
	}
	repos := make([]Repository, 0, len(payload))
	for _, r := range payload {
		repos = append(repos, Repository{Name: r.Name, Owner: r.Owner.Login, URL: r.HTMLURL})
	}
	return repos, nil
}

package git

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/internal/security"
)

// listTimeout keeps the repository picker responsive: a slow provider must fail
// the request, not hang the dashboard.
const listTimeout = 10 * time.Second

// repoPathPattern bounds what can be interpolated into a provider's URL path.
// The repository name arrives from the dashboard, so it is held to the shape a
// provider actually uses rather than trusted into a request path.
var repoPathPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$`)

// Repository is one repository a connected account can deploy.
type Repository struct {
	FullName      string `json:"full_name"`
	CloneURL      string `json:"clone_url"`
	DefaultBranch string `json:"default_branch"`
}

// APIBase resolves a provider's REST root. host is empty for the hosted
// services and the origin of a self-hosted instance otherwise, which is the
// only part of the URL a user controls: everything after it is fixed here, so
// a token can never be sent to a path of someone else's choosing.
func APIBase(provider, host string) (string, error) {
	origin := strings.TrimSuffix(strings.TrimSpace(host), "/")
	if origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || u.Scheme != "https" || u.RawQuery != "" || u.Fragment != "" {
			return "", fmt.Errorf("host must be an https origin, as in https://git.example.com")
		}
	}
	switch provider {
	case "github":
		if origin == "" {
			return "https://api.github.com", nil
		}
		return origin + "/api/v3", nil
	case "gitlab":
		return cmp.Or(origin, "https://gitlab.com") + "/api/v4", nil
	case "gitea":
		if origin == "" {
			return "", fmt.Errorf("a Gitea account needs the host of its instance")
		}
		return origin + "/api/v1", nil
	default:
		return "", fmt.Errorf("provider %q cannot list repositories; use a plain git URL", provider)
	}
}

// ListRepositories returns the repositories the token can reach, most recently
// active first. One page only: picking out of a hundred by scrolling is already
// the limit, and a search box is the answer past that.
func ListRepositories(ctx context.Context, provider, host, token string) ([]Repository, error) {
	base, err := APIBase(provider, host)
	if err != nil {
		return nil, err
	}
	return listRepositories(ctx, provider, base, token)
}

func listRepositories(ctx context.Context, provider, base, token string) ([]Repository, error) {
	var endpoint string
	switch provider {
	case "github":
		endpoint = base + "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member"
	case "gitea":
		endpoint = base + "/user/repos?limit=100"
	case "gitlab":
		endpoint = base + "/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at"
	}

	// GitHub and Gitea answer in the same shape; GitLab names the same two
	// things differently. Decoding both at once is cheaper than a type per
	// provider that only differs in its tags.
	var body []struct {
		FullName      string `json:"full_name"`
		CloneURL      string `json:"clone_url"`
		PathNamespace string `json:"path_with_namespace"`
		HTTPURL       string `json:"http_url_to_repo"`
		DefaultBranch string `json:"default_branch"`
	}
	if err := fetchJSON(ctx, provider, endpoint, token, &body); err != nil {
		return nil, err
	}

	out := make([]Repository, 0, len(body))
	for _, r := range body {
		// The URL arrives over the network and ends up in a git clone, so it is
		// held to the same rules as one typed by hand.
		clone, err := security.ValidateGitURL(cmp.Or(r.CloneURL, r.HTTPURL))
		if err != nil {
			continue
		}
		out = append(out, Repository{
			FullName:      cmp.Or(r.FullName, r.PathNamespace),
			CloneURL:      clone,
			DefaultBranch: cmp.Or(r.DefaultBranch, "main"),
		})
	}
	return out, nil
}

// ListBranches returns the branch names of one repository, so a branch is
// picked from what the remote actually has instead of typed from memory. repo
// is the provider's "owner/name".
func ListBranches(ctx context.Context, provider, host, token, repo string) ([]string, error) {
	base, err := APIBase(provider, host)
	if err != nil {
		return nil, err
	}
	if !repoPathPattern.MatchString(repo) {
		return nil, fmt.Errorf("%q is not a repository name", repo)
	}
	return listBranches(ctx, provider, base, token, repo)
}

func listBranches(ctx context.Context, provider, base, token, repo string) ([]string, error) {
	var endpoint string
	switch provider {
	case "github":
		endpoint = base + "/repos/" + repo + "/branches?per_page=100"
	case "gitea":
		endpoint = base + "/repos/" + repo + "/branches?limit=100"
	case "gitlab":
		// GitLab addresses a project by its path, URL-encoded slash and all.
		endpoint = base + "/projects/" + url.PathEscape(repo) + "/repository/branches?per_page=100"
	}

	var body []struct {
		Name string `json:"name"`
	}
	if err := fetchJSON(ctx, provider, endpoint, token, &body); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(body))
	for _, b := range body {
		if _, err := security.ValidateGitRef(b.Name); err != nil {
			continue
		}
		out = append(out, b.Name)
	}
	return out, nil
}

// fetchJSON is the one authenticated GET the provider listings share. The token
// only ever travels in the header the provider expects.
func fetchJSON(ctx context.Context, provider, endpoint, token string, dest any) error {
	ctx, cancel := context.WithTimeout(ctx, listTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	switch provider {
	case "github":
		req.Header.Set("Authorization", "Bearer "+token)
	case "gitea":
		req.Header.Set("Authorization", "token "+token)
	case "gitlab":
		req.Header.Set("PRIVATE-TOKEN", token)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("%s did not answer: %w", provider, err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return fmt.Errorf("%s rejected the token", provider)
	case resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%s does not have that repository", provider)
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("%s returned %s", provider, resp.Status)
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 4<<20)).Decode(dest); err != nil {
		return fmt.Errorf("%s returned an unreadable list: %w", provider, err)
	}
	return nil
}

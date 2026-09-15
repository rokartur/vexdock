package database

import (
	"crypto/rand"
	"time"

	"github.com/oklog/ulid/v2"
)

// NewID returns a lexicographically sortable ULID used as the primary key of
// every record and as the on-disk project directory name.
func NewID() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), rand.Reader).String()
}

// Accounts and sessions belong to the better-auth service and its own database;
// this package does not model them.

// Project groups environments, services and domains under one name. It owns no
// source of its own: where code comes from is a per service decision.
type Project struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Slug               string   `json:"slug"`
	ComposeProjectName string   `json:"compose_project_name"`
	AutoDeploy         bool     `json:"auto_deploy"`
	Tags               []string `json:"tags"`
	WebhookToken       string   `json:"-"`
	CreatedAt          string   `json:"created_at"`
	UpdatedAt          string   `json:"updated_at"`
}

// Git credential kinds accepted for private repositories.
const (
	GitCredentialNone  = "none"
	GitCredentialToken = "token"
	GitCredentialSSH   = "ssh_key"
)

// ProjectSecret is one environment variable. Values are always encrypted at
// rest; IsSecret only controls whether the value is masked in API responses.
type ProjectSecret struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	Key       string `json:"key"`
	Value     string `json:"value"`
	IsSecret  bool   `json:"is_secret"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// ServiceType splits the two things the dashboard treats differently: an
// application is built or pulled and answers on a domain, a database is a
// curated image with a volume and a connection string.
const (
	ServiceApplication = "application"
	ServiceDatabase    = "database"
)

// Provider enumerates where a service's compose definition comes from. The five
// git values all clone over the same code path; which one is set decides how a
// webhook from that host is read and how the repository is labelled. Raw is a
// compose fragment pasted by hand, image is a published reference, and
// unconfigured is a service that is so far only a name and renders into
// nothing until someone settles the question.
const (
	ProviderUnconfigured = "unconfigured"
	ProviderGitHub       = "github"
	ProviderGitLab       = "gitlab"
	ProviderBitbucket    = "bitbucket"
	ProviderGitea        = "gitea"
	ProviderGit          = "git"
	ProviderImage        = "image"
	ProviderRaw          = "raw"
)

// ClonesFromGit reports whether a provider is cloned from a repository.
func ClonesFromGit(provider string) bool {
	switch provider {
	case ProviderGitHub, ProviderGitLab, ProviderBitbucket, ProviderGitea, ProviderGit:
		return true
	}
	return false
}

// ClonesFromConnection reports whether a provider clones through a connected
// account rather than a URL typed by hand. These four are the ones that list
// repositories, mint their own credentials and receive their own webhooks.
func ClonesFromConnection(provider string) bool {
	switch provider {
	case ProviderGitHub, ProviderGitLab, ProviderBitbucket, ProviderGitea:
		return true
	}
	return false
}

type Service struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	// EnvironmentID is the service's real owner: production and staging each
	// have their own row for the same compose service name.
	EnvironmentID      string `json:"environment_id"`
	ComposeServiceName string `json:"compose_service_name"`
	// ContainerName is what docker ps shows. Empty on services created before
	// the column existed, which keeps compose's own name for them rather than
	// recreating a running container to rename it.
	ContainerName string `json:"container_name"`
	DisplayName   string `json:"display_name"`
	Type          string `json:"type"`
	Provider      string `json:"provider"`
	// RepositoryURL is the remote of a plain git source, the only source that
	// still is a URL. A provider-sourced service names its repository the way
	// its provider does, through GitProviderID, Owner and Repository, and its
	// clone URL is built from the connection at deploy time.
	RepositoryURL string `json:"repository_url"`
	Branch        string `json:"branch"`
	BuildPath     string `json:"build_path"`
	// CredentialKind and CredentialEnc authenticate the clone of a plain git
	// repository. The plaintext never leaves the manager.
	CredentialKind string `json:"credential_kind"`
	CredentialEnc  string `json:"-"`
	// GitProviderID points at the connection this service clones through, and
	// Owner and Repository name the repository on it.
	GitProviderID string `json:"git_provider_id"`
	Owner         string `json:"owner"`
	Repository    string `json:"repository"`
	// Image is the reference an image-sourced service runs and the one a
	// database service was created with. Changing the version is an edit of
	// this field followed by a redeploy, which is why it is stored rather than
	// interpolated out of the environment.
	Image string `json:"image"`
	// Engine is the catalog slug backing a database service, empty otherwise.
	Engine string `json:"engine"`
	// DataPath is where a custom database engine's volume mounts. Curated
	// engines carry it in their catalog fragment, so it stays empty for them.
	DataPath string `json:"data_path"`
	// ComposeFragment is the YAML body a raw service contributes,
	// indented to sit under its own key in the overlay.
	ComposeFragment string `json:"compose_fragment"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
}

type Domain struct {
	ID            string `json:"id"`
	ProjectID     string `json:"project_id"`
	EnvironmentID string `json:"environment_id"`
	ServiceID     string `json:"service_id"`
	Hostname      string `json:"hostname"`
	ContainerPort int    `json:"container_port"`
	HTTPSEnabled  bool   `json:"https_enabled"`
	RedirectHTTPS bool   `json:"redirect_https"`
	// CertificateSource is CertLetsEncrypt or CertCustom.
	CertificateSource string `json:"certificate_source"`
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
}

// Certificate statuses.
const (
	CertPending = "pending"
	CertIssued  = "issued"
	CertFailed  = "failed"
)

// Where a domain's certificate comes from.
const (
	CertLetsEncrypt = "letsencrypt"
	CertCustom      = "custom"
)

type Certificate struct {
	ID            string `json:"id"`
	DomainID      string `json:"domain_id"`
	Hostname      string `json:"hostname"`
	Issuer        string `json:"issuer"`
	IssuedAt      string `json:"issued_at"`
	ExpiresAt     string `json:"expires_at"`
	LastRenewedAt string `json:"last_renewed_at"`
	Status        string `json:"status"`
	LastError     string `json:"last_error"`
	Source        string `json:"source"`
}

// Deployment statuses.
const (
	DeploymentQueued    = "queued"
	DeploymentRunning   = "running"
	DeploymentSuccess   = "success"
	DeploymentFailed    = "failed"
	DeploymentCancelled = "cancelled"
)

type Deployment struct {
	ID            string `json:"id"`
	ProjectID     string `json:"project_id"`
	EnvironmentID string `json:"environment_id"`
	// Number counts this service's deploys in this environment, starting at 1.
	Number int `json:"number"`
	// ServiceName is the compose service the pipeline ran for. Empty only on
	// rows written before deploys were scoped to a service.
	ServiceName string `json:"service_name"`
	CommitSHA   string `json:"commit_sha"`
	Branch      string `json:"branch"`
	Status      string `json:"status"`
	Trigger     string `json:"trigger"`
	CreatedBy   string `json:"created_by"`
	Error       string `json:"error"`
	StartedAt   string `json:"started_at"`
	FinishedAt  string `json:"finished_at"`
	CreatedAt   string `json:"created_at"`
}

type DeploymentStep struct {
	ID           string `json:"id"`
	DeploymentID string `json:"deployment_id"`
	Position     int    `json:"position"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	Output       string `json:"output"`
	StartedAt    string `json:"started_at"`
	FinishedAt   string `json:"finished_at"`
}

// GitProvider is one connection to a git host, connected once and reused by
// any service that clones from it. It is what turns "paste a URL" into "pick a
// repository": the same credential lists the repositories and clones them.
//
// The four providers do not authenticate alike, so the row only carries what
// they have in common and exactly one of the four detail structs is set,
// decided by ProviderType.
type GitProvider struct {
	ID           string `json:"git_provider_id"`
	Name         string `json:"name"`
	ProviderType string `json:"provider_type"`
	CreatedAt    string `json:"created_at"`

	// Connected reports whether the connection can actually reach repositories
	// yet. Creating one is only the first half: GitHub still has to be
	// installed and the OAuth providers still have to be authorised. It is a
	// field rather than a method so the dashboard sees it without every handler
	// having to wrap the row.
	Connected bool `json:"connected"`

	GitHub    *GitHubProvider    `json:"github,omitempty"`
	GitLab    *GitLabProvider    `json:"gitlab,omitempty"`
	Bitbucket *BitbucketProvider `json:"bitbucket,omitempty"`
	Gitea     *GiteaProvider     `json:"gitea,omitempty"`
}

func (p *GitProvider) markConnected() {
	switch {
	case p.GitHub != nil:
		p.Connected = p.GitHub.InstallationID != "" && p.GitHub.PrivateKeyEnc != ""
	case p.GitLab != nil:
		p.Connected = p.GitLab.AccessTokenEnc != ""
	case p.Bitbucket != nil:
		p.Connected = p.Bitbucket.PasswordEnc != "" || p.Bitbucket.APITokenEnc != ""
	case p.Gitea != nil:
		p.Connected = p.Gitea.AccessTokenEnc != ""
	}
}

// GitHubProvider is a GitHub App: created through the manifest flow, installed
// by its owner on the repositories it may read, and cloning with an
// installation token minted from the private key. Every secret is encrypted at
// rest and none of them is serialised to the dashboard.
type GitHubProvider struct {
	GitProviderID   string `json:"git_provider_id"`
	AppName         string `json:"github_app_name"`
	AppID           string `json:"github_app_id"`
	ClientID        string `json:"github_client_id"`
	ClientSecretEnc string `json:"-"`
	// InstallationID is empty until the owner finishes the install and picks
	// the repositories the App may reach.
	InstallationID   string `json:"github_installation_id"`
	PrivateKeyEnc    string `json:"-"`
	WebhookSecretEnc string `json:"-"`
	URL              string `json:"github_url"`
}

// GitLabProvider is an OAuth application registered on a GitLab instance. The
// owner pastes the application id and secret, authorises it once, and the
// refresh token keeps it alive from then on.
type GitLabProvider struct {
	GitProviderID  string `json:"git_provider_id"`
	URL            string `json:"gitlab_url"`
	ApplicationID  string `json:"application_id"`
	RedirectURI    string `json:"redirect_uri"`
	SecretEnc      string `json:"-"`
	AccessTokenEnc string `json:"-"`
	RefreshEnc     string `json:"-"`
	// GroupName narrows the repository listing to one group. Empty lists
	// everything the authorising user is a member of.
	GroupName string `json:"group_name"`
	ExpiresAt int64  `json:"expires_at"`
}

// BitbucketProvider is a credential pair rather than an app. Atlassian is
// retiring app passwords in favour of an account email and an API token, so
// both pairs are accepted and the API token wins when it is set.
type BitbucketProvider struct {
	GitProviderID string `json:"git_provider_id"`
	Username      string `json:"bitbucket_username"`
	PasswordEnc   string `json:"-"`
	Email         string `json:"bitbucket_email"`
	APITokenEnc   string `json:"-"`
	WorkspaceName string `json:"bitbucket_workspace_name"`
}

// GiteaProvider is an OAuth application on a Gitea instance, the same shape as
// GitLab's with Gitea's own scope names.
type GiteaProvider struct {
	GitProviderID       string `json:"git_provider_id"`
	URL                 string `json:"gitea_url"`
	RedirectURI         string `json:"redirect_uri"`
	ClientID            string `json:"client_id"`
	ClientSecretEnc     string `json:"-"`
	Username            string `json:"gitea_username"`
	AccessTokenEnc      string `json:"-"`
	RefreshEnc          string `json:"-"`
	ExpiresAt           int64  `json:"expires_at"`
	Scopes              string `json:"scopes"`
	LastAuthenticatedAt int64  `json:"last_authenticated_at"`
	// OrganizationName narrows the repository listing to one organization.
	OrganizationName string `json:"organization_name"`
}

type Registry struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	URL               string `json:"url"`
	Username          string `json:"username"`
	EncryptedPassword string `json:"-"`
	CreatedAt         string `json:"created_at"`
}

// Environment is a deployable copy of a project. It owns the compose project
// name, so the containers, volumes and networks of production and staging never
// meet, and it owns the directory those containers are built from.
//
// Every project has exactly one default environment, created with the project
// and not deletable: deleting the last environment would leave a project with
// nothing to deploy.
type Environment struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	Name      string `json:"name"`
	Slug      string `json:"slug"`
	// Branch overrides the branch of every git service in this environment.
	// Empty means each service deploys its own.
	Branch             string `json:"branch"`
	ComposeProjectName string `json:"compose_project_name"`
	IsDefault          bool   `json:"is_default"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

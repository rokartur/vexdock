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

// SourceType enumerates where a project's compose file comes from.
const (
	SourceGit     = "git"
	SourceCompose = "compose"
)

type Project struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Slug               string   `json:"slug"`
	SourceType         string   `json:"source_type"`
	RepositoryURL      string   `json:"repository_url"`
	Branch             string   `json:"branch"`
	ComposePath        string   `json:"compose_path"`
	ComposeProjectName string   `json:"compose_project_name"`
	AutoDeploy         bool     `json:"auto_deploy"`
	Tags               []string `json:"tags"`
	WebhookToken       string   `json:"-"`
	GitCredentialKind  string   `json:"git_credential_kind"`
	GitCredentialEnc   string   `json:"-"`
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

// ServiceSource enumerates where a service's compose definition comes from.
// Derived is the read-only case: the service exists because the project's own
// compose file declares it, so the dashboard describes it but never writes it.
// Unconfigured is the opposite end: an application that is so far only a name,
// created before anyone decided whether it builds from a repository or runs a
// published image. It renders into nothing until that is settled.
const (
	ServiceDerived      = "derived"
	ServiceUnconfigured = "unconfigured"
	ServiceGit          = "git"
	ServiceImage        = "image"
	ServiceCompose      = "compose"
)

type Service struct {
	ID                 string `json:"id"`
	ProjectID          string `json:"project_id"`
	ComposeServiceName string `json:"compose_service_name"`
	DisplayName        string `json:"display_name"`
	Type               string `json:"type"`
	SourceType         string `json:"source_type"`
	RepositoryURL      string `json:"repository_url"`
	Branch             string `json:"branch"`
	BuildPath          string `json:"build_path"`
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
	// ComposeFragment is the YAML body a compose-sourced service contributes,
	// indented to sit under its own key in the overlay.
	ComposeFragment string `json:"compose_fragment"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
}

// Managed reports whether the manager owns this service's compose definition.
// A derived service is the project's own YAML and is never rewritten.
func (s Service) Managed() bool { return s.SourceType != ServiceDerived && s.SourceType != "" }

type Domain struct {
	ID            string `json:"id"`
	ProjectID     string `json:"project_id"`
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

// Deployment statuses form the state machine described in the plan.
const (
	DeploymentQueued    = "queued"
	DeploymentRunning   = "running"
	DeploymentSuccess   = "success"
	DeploymentFailed    = "failed"
	DeploymentCancelled = "cancelled"
)

type Deployment struct {
	ID         string `json:"id"`
	ProjectID  string `json:"project_id"`
	Number     int    `json:"number"`
	CommitSHA  string `json:"commit_sha"`
	Branch     string `json:"branch"`
	Status     string `json:"status"`
	Trigger    string `json:"trigger"`
	CreatedBy  string `json:"created_by"`
	Error      string `json:"error"`
	StartedAt  string `json:"started_at"`
	FinishedAt string `json:"finished_at"`
	CreatedAt  string `json:"created_at"`
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

type Registry struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	URL               string `json:"url"`
	Username          string `json:"username"`
	EncryptedPassword string `json:"-"`
	CreatedAt         string `json:"created_at"`
}

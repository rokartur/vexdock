// Package projects owns the project lifecycle: on-disk layout, environment
// files and the compose invocation each project resolves to.
package projects

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/vexdock/platform/manager/internal/compose"
	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/git"
	"github.com/vexdock/platform/manager/internal/security"
)

type Service struct {
	db     *database.DB
	cfg    *config.Config
	cipher *security.Cipher
}

func New(db *database.DB, cfg *config.Config, cipher *security.Cipher) *Service {
	return &Service{db: db, cfg: cfg, cipher: cipher}
}

// CreateInput is the validated payload of the New Project wizard.
type CreateInput struct {
	Name          string
	SourceType    string
	RepositoryURL string
	Branch        string
	ComposePath   string
	// ComposeContent is used when SourceType is "compose": the raw file the
	// user pasted, written into the project's repository directory.
	ComposeContent   string
	AutoDeploy       bool
	Tags             []string
	CredentialKind   string
	CredentialSecret string
}

// ServiceInput is the create form of one service inside a project. Which
// fields matter is decided by SourceType, and Database is set only when the
// service is a catalog database.
type ServiceInput struct {
	Name          string
	SourceType    string
	RepositoryURL string
	Branch        string
	BuildPath     string
	// Image is the reference an image-sourced service runs.
	Image string
	// ComposeFragment is the YAML body of a hand-written service.
	ComposeFragment string
	Database        *DatabaseInput
}

// DatabaseInput is the Database branch of the create form.
type DatabaseInput struct {
	Engine   string
	Version  string
	Name     string
	User     string
	Password string
	// Image pins the reference to run and takes precedence over Version for
	// every engine, which is what preserves a version across an import.
	// DataPath only applies to the "other image" engine.
	Image    string
	DataPath string
}

// MaxTags caps how many labels one project can carry; the list is stored in a
// single column and displayed inline, so a long tail helps nobody.
const MaxTags = 20

// StarterCompose is what a project created from nothing but a name contains
// until its source is configured. It is deliberately not deployable.
const StarterCompose = "# Add your services here, or switch this project to a\n# git repository in Settings.\nservices: {}\n"

// NormalizeTags slugifies free-form labels, which keeps them comma-free for
// storage, makes them compare case-insensitively and drops duplicates.
func NormalizeTags(tags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range tags {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		tag := Slugify(raw)
		if seen[tag] {
			continue
		}
		seen[tag] = true
		out = append(out, tag)
		if len(out) == MaxTags {
			break
		}
	}
	return out
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify derives a URL-safe, unique-ish slug from a display name.
func Slugify(name string) string {
	s := nonSlug.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "project"
	}
	if len(s) > 48 {
		s = strings.Trim(s[:48], "-")
	}
	return s
}

// Create validates the input, persists the project and lays out its directory.
func (s *Service) Create(ctx context.Context, in CreateInput) (*database.Project, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("project name is required")
	}
	slug := Slugify(name)
	if err := security.ValidateSlug(slug); err != nil {
		return nil, err
	}

	if in.SourceType == "" {
		in.SourceType = database.SourceCompose
	}

	p := &database.Project{
		ID:                database.NewID(),
		Name:              name,
		Slug:              slug,
		SourceType:        in.SourceType,
		Branch:            "main",
		ComposePath:       "compose.yml",
		AutoDeploy:        in.AutoDeploy,
		Tags:              in.Tags,
		WebhookToken:      security.RandomToken(24),
		GitCredentialKind: database.GitCredentialNone,
	}
	p.ComposeProjectName = ComposeProjectName(p.ID)

	switch in.SourceType {
	case database.SourceGit:
		p.RepositoryURL = in.RepositoryURL
		if in.Branch != "" {
			p.Branch = in.Branch
		}
		if in.ComposePath != "" {
			p.ComposePath = in.ComposePath
		}
		if err := s.setCredential(p, in.CredentialKind, in.CredentialSecret); err != nil {
			return nil, err
		}
	case database.SourceCompose:
		if strings.TrimSpace(in.ComposeContent) == "" {
			in.ComposeContent = StarterCompose
		}
	default:
		return nil, fmt.Errorf("unknown source type %q", in.SourceType)
	}

	if err := s.Validate(p); err != nil {
		return nil, err
	}

	if err := s.db.CreateProject(ctx, p); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, fmt.Errorf("a project named %q already exists", name)
		}
		return nil, err
	}
	if err := s.prepareDirs(p); err != nil {
		_ = s.db.DeleteProject(ctx, p.ID)
		return nil, err
	}
	if in.SourceType == database.SourceCompose {
		if err := s.WriteComposeFile(p, in.ComposeContent); err != nil {
			_ = s.db.DeleteProject(ctx, p.ID)
			return nil, err
		}
	}
	return p, nil
}

// ComposeProjectName namespaces every docker resource of a project.
func ComposeProjectName(id string) string { return "p_" + strings.ToLower(id) }

// Validate normalises and checks a project's mutable fields. Creation and every
// update run through it, so a compose path can never escape the project
// directory and a repository URL can never use a dangerous git transport.
func (s *Service) Validate(p *database.Project) error {
	p.Tags = NormalizeTags(p.Tags)
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return fmt.Errorf("project name is required")
	}
	if p.Slug == "" {
		p.Slug = Slugify(p.Name)
	}
	if err := security.ValidateSlug(p.Slug); err != nil {
		return err
	}

	p.ComposePath = filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(p.ComposePath), "./"))
	if p.ComposePath == "" {
		p.ComposePath = "compose.yml"
	}
	if _, err := security.ResolveInside(s.repositoryDir(p.ID), p.ComposePath); err != nil {
		return err
	}

	switch p.SourceType {
	case database.SourceGit:
		url, err := security.ValidateGitURL(p.RepositoryURL)
		if err != nil {
			return err
		}
		p.RepositoryURL = url
		ref, err := security.ValidateGitRef(p.Branch)
		if err != nil {
			return err
		}
		p.Branch = ref
	case database.SourceCompose:
	default:
		return fmt.Errorf("unknown source type %q", p.SourceType)
	}
	return nil
}

// ResetCheckout empties a project's checkout and seeds the starter file when
// the project is compose. It runs when the source type changes: git clone
// refuses a directory that already holds files, and a leftover checkout would
// shadow a hand-written compose file. Everything under that directory is
// reproducible from the source, so nothing unrecoverable is thrown away.
func (s *Service) ResetCheckout(p *database.Project) error {
	dir := s.repositoryDir(p.ID)
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	if p.SourceType == database.SourceCompose {
		return s.WriteComposeFile(p, StarterCompose)
	}
	return nil
}

func (s *Service) prepareDirs(p *database.Project) error {
	for _, dir := range []string{s.repositoryDir(p.ID), filepath.Join(s.cfg.ProjectDir(p.ID), "metadata")} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) repositoryDir(id string) string {
	return filepath.Join(s.cfg.ProjectDir(id), "repository")
}

// RepositoryDir is the checkout root of a project.
func (s *Service) RepositoryDir(p *database.Project) string { return s.repositoryDir(p.ID) }

// EnvFilePath is the generated .env consumed by docker compose.
func (s *Service) EnvFilePath(p *database.Project) string {
	return filepath.Join(s.cfg.ProjectDir(p.ID), ".env")
}

// WriteComposeFile stores a pasted compose file inside the project repository.
func (s *Service) WriteComposeFile(p *database.Project, content string) error {
	target, err := security.ResolveInside(s.repositoryDir(p.ID), p.ComposePath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return err
	}
	return os.WriteFile(target, []byte(content), 0o640)
}

// ReadComposeFile returns the compose file currently on disk, if any.
func (s *Service) ReadComposeFile(p *database.Project) (string, error) {
	target, err := security.ResolveInside(s.repositoryDir(p.ID), p.ComposePath)
	if err != nil {
		return "", err
	}
	body, err := os.ReadFile(target)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// ComposeProject builds the compose invocation for a project, writing the .env
// file first so compose and the containers see the same values.
func (s *Service) ComposeProject(ctx context.Context, p *database.Project) (compose.Project, error) {
	repoDir := s.repositoryDir(p.ID)
	file, err := security.ResolveInside(repoDir, p.ComposePath)
	if err != nil {
		return compose.Project{}, err
	}
	envFile, err := s.WriteEnvFile(ctx, p)
	if err != nil {
		return compose.Project{}, err
	}
	// Services the dashboard owns arrive as a second file layered over the
	// project's own, which is why an imported compose keeps working untouched
	// and can still gain a database next to it.
	overlay, err := s.WriteOverlay(ctx, p)
	if err != nil {
		return compose.Project{}, err
	}
	files := []string{file}
	if overlay != "" {
		files = append(files, overlay)
	}
	return compose.Project{
		Name:    p.ComposeProjectName,
		Dir:     repoDir,
		Files:   files,
		EnvFile: envFile,
	}, nil
}

// WriteEnvFile materialises the project environment at 0600 and returns its
// path, or "" when the project has no variables (so compose omits --env-file).
// The file itself is always written, even empty: a compose env_file: .env has
// to open something.
func (s *Service) WriteEnvFile(ctx context.Context, p *database.Project) (string, error) {
	vars, err := s.Environment(ctx, p.ID, false)
	if err != nil {
		return "", err
	}
	path := s.EnvFilePath(p)
	if err := writeEnvFile(path, vars); err != nil {
		return "", err
	}
	if len(vars) == 0 {
		return "", nil
	}
	return path, nil
}

// writeEnvFile renders vars to an env file at 0600. Both the project file and
// each managed service's file go through here so their escaping cannot drift.
func writeEnvFile(path string, vars []EnvVar) error {
	var b strings.Builder
	b.WriteString("# generated by the platform - edit through the dashboard\n")
	for _, v := range vars {
		fmt.Fprintf(&b, "%s=%s\n", v.Key, escapeEnvValue(v.Value))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(b.String()), 0o600)
}

// escapeEnvValue quotes values so newlines and spaces survive compose parsing.
func escapeEnvValue(v string) string {
	if v == "" {
		return `""`
	}
	if strings.ContainsAny(v, " \t\n\"'$#") {
		replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
		return `"` + replacer.Replace(v) + `"`
	}
	return v
}

// EnvVar is one environment entry as returned to the API.
type EnvVar struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	IsSecret  bool   `json:"is_secret"`
	UpdatedAt string `json:"updated_at"`
}

// Environment returns the project variables, the set every service in the
// project sees. With mask=true secret values are replaced by dots, which is
// what every API response uses.
func (s *Service) Environment(ctx context.Context, projectID string, mask bool) ([]EnvVar, error) {
	return s.environment(ctx, database.ProjectScope, projectID, mask)
}

// ServiceEnvironment returns the variables only one service sees.
func (s *Service) ServiceEnvironment(ctx context.Context, serviceID string, mask bool) ([]EnvVar, error) {
	return s.environment(ctx, database.ServiceScope, serviceID, mask)
}

func (s *Service) environment(ctx context.Context, scope database.SecretScope, ownerID string, mask bool) ([]EnvVar, error) {
	rows, err := s.db.ListSecrets(ctx, scope, ownerID)
	if err != nil {
		return nil, err
	}
	out := make([]EnvVar, 0, len(rows))
	for _, row := range rows {
		value, err := s.cipher.Decrypt(row.Encrypted)
		if err != nil {
			return nil, fmt.Errorf("decrypt %s: %w", row.Key, err)
		}
		if mask && row.IsSecret {
			value = security.MaskSecret(value)
		}
		out = append(out, EnvVar{Key: row.Key, Value: value, IsSecret: row.IsSecret, UpdatedAt: row.UpdatedAt})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// SetEnvironment replaces the whole variable set of a project.
func (s *Service) SetEnvironment(ctx context.Context, projectID string, vars []EnvVar) error {
	return s.setEnvironment(ctx, database.ProjectScope, projectID, vars)
}

// SetServiceEnvironment replaces the whole variable set of a single service.
func (s *Service) SetServiceEnvironment(ctx context.Context, serviceID string, vars []EnvVar) error {
	return s.setEnvironment(ctx, database.ServiceScope, serviceID, vars)
}

func (s *Service) setEnvironment(ctx context.Context, scope database.SecretScope, ownerID string, vars []EnvVar) error {
	existing, err := s.db.ListSecrets(ctx, scope, ownerID)
	if err != nil {
		return err
	}
	incoming := map[string]bool{}
	for _, v := range vars {
		key := strings.TrimSpace(v.Key)
		if err := security.ValidateEnvKey(key); err != nil {
			return err
		}
		incoming[key] = true
		// A masked value means "unchanged": never overwrite a real secret with dots.
		if v.Value == security.MaskSecret("x") {
			continue
		}
		enc, err := s.cipher.Encrypt(v.Value)
		if err != nil {
			return err
		}
		if err := s.db.UpsertSecret(ctx, scope, ownerID, key, enc, v.IsSecret); err != nil {
			return err
		}
	}
	for _, row := range existing {
		if !incoming[row.Key] {
			if err := s.db.DeleteSecret(ctx, scope, ownerID, row.Key); err != nil {
				return err
			}
		}
	}
	return nil
}

// Credential decrypts the git credential attached to a project.
func (s *Service) Credential(p *database.Project) (git.Credential, error) {
	if p.GitCredentialKind == "" || p.GitCredentialKind == database.GitCredentialNone || p.GitCredentialEnc == "" {
		return git.Credential{Kind: git.KindNone}, nil
	}
	value, err := s.cipher.Decrypt(p.GitCredentialEnc)
	if err != nil {
		return git.Credential{}, err
	}
	return git.Credential{Kind: p.GitCredentialKind, Value: value}, nil
}

// SetCredential encrypts and attaches a git credential to a project.
func (s *Service) SetCredential(ctx context.Context, p *database.Project, kind, secret string) error {
	if err := s.setCredential(p, kind, secret); err != nil {
		return err
	}
	return s.db.UpdateProject(ctx, p)
}

func (s *Service) setCredential(p *database.Project, kind, secret string) error {
	switch kind {
	case "", database.GitCredentialNone:
		p.GitCredentialKind, p.GitCredentialEnc = database.GitCredentialNone, ""
		return nil
	case database.GitCredentialToken, database.GitCredentialSSH:
		if strings.TrimSpace(secret) == "" {
			// Empty secret with an existing credential means "keep current".
			if p.GitCredentialEnc != "" && p.GitCredentialKind == kind {
				return nil
			}
			return fmt.Errorf("a credential value is required for %s", kind)
		}
		enc, err := s.cipher.Encrypt(secret)
		if err != nil {
			return err
		}
		p.GitCredentialKind, p.GitCredentialEnc = kind, enc
		return nil
	default:
		return fmt.Errorf("unknown credential kind %q", kind)
	}
}

// RemoveDirectory deletes a project's on-disk state after it is torn down.
func (s *Service) RemoveDirectory(id string) error {
	dir := s.cfg.ProjectDir(id)
	// Defensive: only ever remove a path inside the projects root.
	if _, err := security.ResolveInside(s.cfg.ProjectsDir, id); err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

// WebhookURL is the auto-deploy endpoint shown in the UI.
func (s *Service) WebhookURL(p *database.Project) string {
	base := s.cfg.PublicURL
	return base + "/api/webhooks/projects/" + p.WebhookToken
}

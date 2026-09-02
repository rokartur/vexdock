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

// CreateInput is the validated payload of the New Project wizard. A project is
// a grouping, so this is a name and its labels; what gets deployed is decided
// per service.
type CreateInput struct {
	Name       string
	AutoDeploy bool
	Tags       []string
}

// ServiceInput is the create form of one service inside a project. Which
// fields matter is decided by Provider, and Database is set only when the
// service is a catalog database.
type ServiceInput struct {
	Name          string
	Provider      string
	RepositoryURL string
	Branch        string
	BuildPath     string
	// CredentialKind and CredentialSecret authenticate a private clone.
	CredentialKind   string
	CredentialSecret string
	// Image is the reference an image service runs.
	Image string
	// ComposeFragment is the YAML body of a raw service.
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

	p := &database.Project{
		ID:           database.NewID(),
		Name:         name,
		Slug:         slug,
		AutoDeploy:   in.AutoDeploy,
		Tags:         in.Tags,
		WebhookToken: security.RandomToken(24),
	}
	p.ComposeProjectName = ComposeProjectName(p.ID)

	if err := s.Validate(p); err != nil {
		return nil, err
	}

	if err := s.db.CreateProject(ctx, p); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, fmt.Errorf("a project named %q already exists", name)
		}
		return nil, err
	}
	// The default environment carries the project's own id and namespace. That
	// is what migration 0010 backfilled for projects that predate environments,
	// and keeping the rule here means new projects look identical to old ones.
	env := &database.Environment{
		ID:                 p.ID,
		ProjectID:          p.ID,
		Name:               "Production",
		Slug:               "production",
		ComposeProjectName: p.ComposeProjectName,
		IsDefault:          true,
	}
	if err := s.db.CreateEnvironment(ctx, env); err != nil {
		_ = s.db.DeleteProject(ctx, p.ID)
		return nil, err
	}
	if err := s.prepareDirs(env); err != nil {
		_ = s.db.DeleteProject(ctx, p.ID)
		return nil, err
	}
	return p, nil
}

// ComposeProjectName namespaces every docker resource of one environment, which
// is what keeps production and staging from sharing a container or a volume.
func ComposeProjectName(id string) string { return "p_" + strings.ToLower(id) }

// Validate normalises and checks a project's mutable fields. Creation and every
// update run through it.
func (s *Service) Validate(p *database.Project) error {
	p.Tags = NormalizeTags(p.Tags)
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return fmt.Errorf("project name is required")
	}
	if p.Slug == "" {
		p.Slug = Slugify(p.Name)
	}
	return security.ValidateSlug(p.Slug)
}

func (s *Service) prepareDirs(env *database.Environment) error {
	for _, dir := range []string{s.repositoryDir(env.ID), filepath.Join(s.cfg.ProjectDir(env.ID), "metadata")} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) repositoryDir(id string) string {
	return filepath.Join(s.cfg.ProjectDir(id), "repository")
}

// EnvFilePath is the generated .env consumed by docker compose.
func (s *Service) EnvFilePath(env *database.Environment) string {
	return filepath.Join(s.cfg.ProjectDir(env.ID), ".env")
}

// ComposeProject builds the compose invocation for an environment, writing the
// .env file first so compose and the containers see the same values. Every
// service the environment owns is rendered into one generated file; nothing
// else is read from disk.
func (s *Service) ComposeProject(ctx context.Context, p *database.Project, env *database.Environment) (compose.Project, error) {
	envFile, err := s.WriteEnvFile(ctx, p, env)
	if err != nil {
		return compose.Project{}, err
	}
	overlay, err := s.WriteOverlay(ctx, env)
	if err != nil {
		return compose.Project{}, err
	}
	if overlay == "" {
		return compose.Project{}, fmt.Errorf("environment %s has no configured service to deploy", env.Slug)
	}
	return compose.Project{
		Name:    env.ComposeProjectName,
		Dir:     s.repositoryDir(env.ID),
		Files:   []string{overlay},
		EnvFile: envFile,
	}, nil
}

// WriteEnvFile materialises what an environment's containers see at 0600 and
// returns its path, or "" when there are no variables (so compose omits
// --env-file). The file itself is always written, even empty: a compose
// env_file: .env has to open something.
//
// The environment's own variables are layered over the project's shared set, so
// staging can override a shared value without copying the rest.
func (s *Service) WriteEnvFile(ctx context.Context, p *database.Project, env *database.Environment) (string, error) {
	shared, err := s.ProjectVariables(ctx, p.ID)
	if err != nil {
		return "", err
	}
	own, err := s.EnvironmentVariables(ctx, env.ID)
	if err != nil {
		return "", err
	}
	vars := mergeVariables(shared, own)
	path := s.EnvFilePath(env)
	if err := writeEnvFile(path, vars); err != nil {
		return "", err
	}
	if len(vars) == 0 {
		return "", nil
	}
	return path, nil
}

// mergeVariables layers narrower sets over wider ones, last wins, and keeps the
// result sorted so a regenerated .env only changes when a value did.
func mergeVariables(sets ...[]EnvVar) []EnvVar {
	byKey := map[string]EnvVar{}
	for _, set := range sets {
		for _, v := range set {
			byKey[v.Key] = v
		}
	}
	out := make([]EnvVar, 0, len(byKey))
	for _, v := range byKey {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// writeEnvFile renders vars to an env file at 0600. Both the environment file
// and each managed service's file go through here so their escaping cannot drift.
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
// A dollar becomes $$ because compose interpolates variables inside the double
// quotes as well as outside them, so a raw $ would silently eat the rest of the
// value: a password of p$ssw0rd reaches the container as p.
func escapeEnvValue(v string) string {
	if v == "" {
		return `""`
	}
	if strings.ContainsAny(v, " \t\n\"'$#") {
		replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, `$`, `$$`)
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

// Variables come in three layers. A project's are shared by every environment,
// an environment's belong to that copy of the project alone, and a service's
// reach only itself. They are read separately and merged at deploy time by
// WriteEnvFile, narrowest last.
//
// None of these mask. The editor is the one place a secret is meant to be
// legible (docs/security.md); what protects it is the write side, where a value
// that arrives already masked means "unchanged".

// ProjectVariables returns the set shared by every environment of a project.
func (s *Service) ProjectVariables(ctx context.Context, projectID string) ([]EnvVar, error) {
	return s.variables(ctx, database.ProjectScope, projectID)
}

// EnvironmentVariables returns the set that makes production differ from staging.
func (s *Service) EnvironmentVariables(ctx context.Context, environmentID string) ([]EnvVar, error) {
	return s.variables(ctx, database.EnvironmentScope, environmentID)
}

// ServiceVariables returns the variables only one service sees.
func (s *Service) ServiceVariables(ctx context.Context, serviceID string) ([]EnvVar, error) {
	return s.variables(ctx, database.ServiceScope, serviceID)
}

func (s *Service) variables(ctx context.Context, scope database.SecretScope, ownerID string) ([]EnvVar, error) {
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
		out = append(out, EnvVar{Key: row.Key, Value: value, IsSecret: row.IsSecret, UpdatedAt: row.UpdatedAt})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// SetProjectVariables replaces the whole set shared across environments.
func (s *Service) SetProjectVariables(ctx context.Context, projectID string, vars []EnvVar) error {
	return s.setVariables(ctx, database.ProjectScope, projectID, vars)
}

// SetEnvironmentVariables replaces the whole set of one environment.
func (s *Service) SetEnvironmentVariables(ctx context.Context, environmentID string, vars []EnvVar) error {
	return s.setVariables(ctx, database.EnvironmentScope, environmentID, vars)
}

// SetServiceVariables replaces the whole variable set of a single service.
func (s *Service) SetServiceVariables(ctx context.Context, serviceID string, vars []EnvVar) error {
	return s.setVariables(ctx, database.ServiceScope, serviceID, vars)
}

func (s *Service) setVariables(ctx context.Context, scope database.SecretScope, ownerID string, vars []EnvVar) error {
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
		if v.Value == security.MaskedValue {
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

// Credential decrypts the git credential attached to a service.
func (s *Service) Credential(svc *database.Service) (git.Credential, error) {
	if svc.CredentialKind == "" || svc.CredentialKind == database.GitCredentialNone || svc.CredentialEnc == "" {
		return git.Credential{Kind: git.KindNone}, nil
	}
	value, err := s.cipher.Decrypt(svc.CredentialEnc)
	if err != nil {
		return git.Credential{}, err
	}
	return git.Credential{Kind: svc.CredentialKind, Value: value}, nil
}

// SetCredential encrypts a git credential onto a service. An empty secret with
// a credential already stored means "keep current".
func (s *Service) SetCredential(svc *database.Service, kind, secret string) error {
	switch kind {
	case "", database.GitCredentialNone:
		svc.CredentialKind, svc.CredentialEnc = database.GitCredentialNone, ""
		return nil
	case database.GitCredentialToken, database.GitCredentialSSH:
		if strings.TrimSpace(secret) == "" {
			if svc.CredentialEnc != "" && svc.CredentialKind == kind {
				return nil
			}
			return fmt.Errorf("a credential value is required for %s", kind)
		}
		enc, err := s.cipher.Encrypt(secret)
		if err != nil {
			return err
		}
		svc.CredentialKind, svc.CredentialEnc = kind, enc
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

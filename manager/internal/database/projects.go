package database

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

const projectColumns = `id, name, slug, compose_project_name,
	auto_deploy, webhook_token, created_at, updated_at, tags`

func (db *DB) CreateProject(ctx context.Context, p *Project) error {
	p.CreatedAt, p.UpdatedAt = Now(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO projects (`+projectColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.Slug, p.ComposeProjectName,
		boolToInt(p.AutoDeploy), p.WebhookToken, p.CreatedAt, p.UpdatedAt,
		strings.Join(p.Tags, ","))
	return err
}

func (db *DB) UpdateProject(ctx context.Context, p *Project) error {
	p.UpdatedAt = Now()
	_, err := db.ExecContext(ctx,
		`UPDATE projects SET name=?, slug=?, auto_deploy=?, updated_at=?, tags=? WHERE id=?`,
		p.Name, p.Slug, boolToInt(p.AutoDeploy), p.UpdatedAt, strings.Join(p.Tags, ","), p.ID)
	return err
}

func (db *DB) DeleteProject(ctx context.Context, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM projects WHERE id = ?`, id)
	return err
}

func (db *DB) ListProjects(ctx context.Context) ([]Project, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+projectColumns+` FROM projects ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

func (db *DB) ProjectByID(ctx context.Context, id string) (*Project, error) {
	return scanProject(db.QueryRowContext(ctx, `SELECT `+projectColumns+` FROM projects WHERE id = ?`, id))
}

// ProjectByWebhookToken backs the auto-deploy endpoint; the token is the only
// credential the caller presents, so it must be long and random.
func (db *DB) ProjectByWebhookToken(ctx context.Context, token string) (*Project, error) {
	return scanProject(db.QueryRowContext(ctx,
		`SELECT `+projectColumns+` FROM projects WHERE webhook_token = ? AND webhook_token != ''`, token))
}

type scanner interface{ Scan(dest ...any) error }

func scanProject(row scanner) (*Project, error) {
	var p Project
	var autoDeploy int
	var tags string
	err := row.Scan(&p.ID, &p.Name, &p.Slug,
		&p.ComposeProjectName, &autoDeploy, &p.WebhookToken,
		&p.CreatedAt, &p.UpdatedAt, &tags)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	p.AutoDeploy = autoDeploy != 0
	p.Tags = []string{}
	if tags != "" {
		p.Tags = strings.Split(tags, ",")
	}
	return &p, nil
}

// UpsertSecret stores an already-encrypted environment value.
// SecretScope selects which environment a secret belongs to. A project's set is
// shared by everything it runs; a service's set is seen by that container
// alone, which is what lets two databases in one project both define
// POSTGRES_PASSWORD. Both are fixed strings, never caller input.
type SecretScope struct{ table, owner string }

var (
	ProjectScope     = SecretScope{"project_secrets", "project_id"}
	EnvironmentScope = SecretScope{"environment_secrets", "environment_id"}
	ServiceScope     = SecretScope{"service_secrets", "service_id"}
)

func (db *DB) UpsertSecret(ctx context.Context, sc SecretScope, ownerID, key, encrypted string, isSecret bool) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO `+sc.table+` (id, `+sc.owner+`, key, encrypted_value, is_secret, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (`+sc.owner+`, key) DO UPDATE SET encrypted_value = excluded.encrypted_value,
		     is_secret = excluded.is_secret, updated_at = excluded.updated_at`,
		NewID(), ownerID, key, encrypted, boolToInt(isSecret), Now(), Now())
	return err
}

func (db *DB) DeleteSecret(ctx context.Context, sc SecretScope, ownerID, key string) error {
	_, err := db.ExecContext(ctx,
		`DELETE FROM `+sc.table+` WHERE `+sc.owner+` = ? AND key = ?`, ownerID, key)
	return err
}

// EncryptedSecret is the raw row; callers decrypt through the security cipher.
type EncryptedSecret struct {
	Key       string
	Encrypted string
	IsSecret  bool
	UpdatedAt string
}

func (db *DB) ListSecrets(ctx context.Context, sc SecretScope, ownerID string) ([]EncryptedSecret, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT key, encrypted_value, is_secret, updated_at FROM `+sc.table+
			` WHERE `+sc.owner+` = ? ORDER BY key`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []EncryptedSecret{}
	for rows.Next() {
		var s EncryptedSecret
		var isSecret int
		if err := rows.Scan(&s.Key, &s.Encrypted, &isSecret, &s.UpdatedAt); err != nil {
			return nil, err
		}
		s.IsSecret = isSecret != 0
		out = append(out, s)
	}
	return out, rows.Err()
}

// The container id is deliberately not stored: it changes on every recreate.
const serviceColumns = `id, project_id, environment_id, compose_service_name, display_name, type, provider,
	repository_url, branch, build_path, credential_kind, credential_enc, git_account_id, image, engine, data_path,
	compose_fragment, created_at, updated_at`

// CreateService records a service the dashboard owns. Its definition is
// rendered into the environment's compose file rather than read out of one.
func (db *DB) CreateService(ctx context.Context, s *Service) error {
	s.CreatedAt, s.UpdatedAt = Now(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO services (`+serviceColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.ProjectID, s.EnvironmentID, s.ComposeServiceName, s.DisplayName, s.Type, s.Provider,
		s.RepositoryURL, s.Branch, s.BuildPath, s.CredentialKind, s.CredentialEnc, s.GitAccountID, s.Image, s.Engine,
		s.DataPath, s.ComposeFragment, s.CreatedAt, s.UpdatedAt)
	return err
}

func (db *DB) UpdateService(ctx context.Context, s *Service) error {
	s.UpdatedAt = Now()
	_, err := db.ExecContext(ctx,
		`UPDATE services SET display_name = ?, type = ?, provider = ?, repository_url = ?, branch = ?,
		 build_path = ?, credential_kind = ?, credential_enc = ?, git_account_id = ?, image = ?, engine = ?,
		 data_path = ?, compose_fragment = ?, updated_at = ? WHERE id = ?`,
		s.DisplayName, s.Type, s.Provider, s.RepositoryURL, s.Branch, s.BuildPath, s.CredentialKind,
		s.CredentialEnc, s.GitAccountID, s.Image, s.Engine, s.DataPath, s.ComposeFragment, s.UpdatedAt, s.ID)
	return err
}

func (db *DB) DeleteService(ctx context.Context, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM services WHERE id = ?`, id)
	return err
}

func (db *DB) ServiceByName(ctx context.Context, environmentID, name string) (*Service, error) {
	return scanService(db.QueryRowContext(ctx,
		`SELECT `+serviceColumns+` FROM services WHERE environment_id = ? AND compose_service_name = ?`, environmentID, name))
}

func (db *DB) ServiceByID(ctx context.Context, id string) (*Service, error) {
	return scanService(db.QueryRowContext(ctx,
		`SELECT `+serviceColumns+` FROM services WHERE id = ?`, id))
}

func scanService(row scanner) (*Service, error) {
	var s Service
	err := row.Scan(&s.ID, &s.ProjectID, &s.EnvironmentID, &s.ComposeServiceName, &s.DisplayName, &s.Type, &s.Provider,
		&s.RepositoryURL, &s.Branch, &s.BuildPath, &s.CredentialKind, &s.CredentialEnc, &s.GitAccountID, &s.Image,
		&s.Engine, &s.DataPath, &s.ComposeFragment, &s.CreatedAt, &s.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// ListServices returns one environment's services. Anything that needs every
// service a project owns wants ListProjectServices instead.
func (db *DB) ListServices(ctx context.Context, environmentID string) ([]Service, error) {
	return db.services(ctx, `WHERE environment_id = ? ORDER BY compose_service_name`, environmentID)
}

// ListProjectServices spans every environment, which is what reconciliation and
// anything counting a project's footprint needs.
func (db *DB) ListProjectServices(ctx context.Context, projectID string) ([]Service, error) {
	return db.services(ctx, `WHERE project_id = ? ORDER BY environment_id, compose_service_name`, projectID)
}

// AllServices spans every project, for the views that list something owned by a
// service without knowing which one first.
func (db *DB) AllServices(ctx context.Context) ([]Service, error) {
	return db.services(ctx, ``)
}

func (db *DB) services(ctx context.Context, where string, args ...any) ([]Service, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+serviceColumns+` FROM services `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Service{}
	for rows.Next() {
		s, err := scanService(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

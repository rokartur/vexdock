package database

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

const projectColumns = `id, name, slug, source_type, repository_url, branch, compose_path, compose_project_name,
	auto_deploy, webhook_token, git_credential_kind, git_credential_enc, created_at, updated_at, tags`

func (db *DB) CreateProject(ctx context.Context, p *Project) error {
	p.CreatedAt, p.UpdatedAt = Now(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO projects (`+projectColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.Slug, p.SourceType, p.RepositoryURL, p.Branch, p.ComposePath, p.ComposeProjectName,
		boolToInt(p.AutoDeploy), p.WebhookToken, p.GitCredentialKind, p.GitCredentialEnc, p.CreatedAt, p.UpdatedAt,
		strings.Join(p.Tags, ","))
	return err
}

func (db *DB) UpdateProject(ctx context.Context, p *Project) error {
	p.UpdatedAt = Now()
	_, err := db.ExecContext(ctx,
		`UPDATE projects SET name=?, slug=?, source_type=?, repository_url=?, branch=?, compose_path=?,
		 auto_deploy=?, git_credential_kind=?, git_credential_enc=?, updated_at=?, tags=? WHERE id=?`,
		p.Name, p.Slug, p.SourceType, p.RepositoryURL, p.Branch, p.ComposePath,
		boolToInt(p.AutoDeploy), p.GitCredentialKind, p.GitCredentialEnc, p.UpdatedAt, strings.Join(p.Tags, ","), p.ID)
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
	err := row.Scan(&p.ID, &p.Name, &p.Slug, &p.SourceType, &p.RepositoryURL, &p.Branch, &p.ComposePath,
		&p.ComposeProjectName, &autoDeploy, &p.WebhookToken, &p.GitCredentialKind, &p.GitCredentialEnc,
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
	ProjectScope = SecretScope{"project_secrets", "project_id"}
	ServiceScope = SecretScope{"service_secrets", "service_id"}
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

// UpsertService records a compose service discovered during deployment. The
// container id is deliberately not stored: it changes on every recreate.
const serviceColumns = `id, project_id, compose_service_name, display_name, type, source_type,
	repository_url, branch, build_path, image, engine, data_path, compose_fragment, created_at, updated_at`

// UpsertService records a service a deployment found in the project's own
// compose file. It never touches a row that already exists, so a service the
// dashboard created and then saw in the compose output keeps its own source.
func (db *DB) UpsertService(ctx context.Context, projectID, composeServiceName string) (*Service, error) {
	_, err := db.ExecContext(ctx,
		`INSERT INTO services (id, project_id, compose_service_name, display_name, type, source_type, created_at, updated_at)
		 VALUES (?, ?, ?, '', ?, ?, ?, ?) ON CONFLICT (project_id, compose_service_name) DO NOTHING`,
		NewID(), projectID, composeServiceName, ServiceApplication, ServiceDerived, Now(), Now())
	if err != nil {
		return nil, err
	}
	return db.ServiceByName(ctx, projectID, composeServiceName)
}

// CreateService records a service the dashboard owns. Its definition is
// rendered into the project's overlay compose file rather than read out of one.
func (db *DB) CreateService(ctx context.Context, s *Service) error {
	s.CreatedAt, s.UpdatedAt = Now(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO services (`+serviceColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.ProjectID, s.ComposeServiceName, s.DisplayName, s.Type, s.SourceType,
		s.RepositoryURL, s.Branch, s.BuildPath, s.Image, s.Engine, s.DataPath, s.ComposeFragment,
		s.CreatedAt, s.UpdatedAt)
	return err
}

func (db *DB) UpdateService(ctx context.Context, s *Service) error {
	s.UpdatedAt = Now()
	_, err := db.ExecContext(ctx,
		`UPDATE services SET display_name = ?, type = ?, source_type = ?, repository_url = ?, branch = ?,
		 build_path = ?, image = ?, engine = ?, data_path = ?, compose_fragment = ?, updated_at = ? WHERE id = ?`,
		s.DisplayName, s.Type, s.SourceType, s.RepositoryURL, s.Branch, s.BuildPath, s.Image,
		s.Engine, s.DataPath, s.ComposeFragment, s.UpdatedAt, s.ID)
	return err
}

func (db *DB) DeleteService(ctx context.Context, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM services WHERE id = ?`, id)
	return err
}

func (db *DB) ServiceByName(ctx context.Context, projectID, name string) (*Service, error) {
	return scanService(db.QueryRowContext(ctx,
		`SELECT `+serviceColumns+` FROM services WHERE project_id = ? AND compose_service_name = ?`, projectID, name))
}

func (db *DB) ServiceByID(ctx context.Context, id string) (*Service, error) {
	return scanService(db.QueryRowContext(ctx,
		`SELECT `+serviceColumns+` FROM services WHERE id = ?`, id))
}

func scanService(row scanner) (*Service, error) {
	var s Service
	err := row.Scan(&s.ID, &s.ProjectID, &s.ComposeServiceName, &s.DisplayName, &s.Type, &s.SourceType,
		&s.RepositoryURL, &s.Branch, &s.BuildPath, &s.Image, &s.Engine, &s.DataPath, &s.ComposeFragment,
		&s.CreatedAt, &s.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (db *DB) ListServices(ctx context.Context, projectID string) ([]Service, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT `+serviceColumns+` FROM services WHERE project_id = ? ORDER BY compose_service_name`, projectID)
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

// PruneServices drops derived services that disappeared from the compose file.
// Managed services survive: they are the reason the overlay exists, and a
// deploy that failed before rendering it must not delete them.
func (db *DB) PruneServices(ctx context.Context, projectID string, keep []string) error {
	existing, err := db.ListServices(ctx, projectID)
	if err != nil {
		return err
	}
	kept := make(map[string]bool, len(keep))
	for _, k := range keep {
		kept[k] = true
	}
	for _, s := range existing {
		if kept[s.ComposeServiceName] || s.Managed() {
			continue
		}
		if _, err := db.ExecContext(ctx, `DELETE FROM services WHERE id = ?`, s.ID); err != nil {
			return err
		}
	}
	return nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

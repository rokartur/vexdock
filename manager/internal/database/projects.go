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
func (db *DB) UpsertSecret(ctx context.Context, projectID, key, encrypted string, isSecret bool) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO project_secrets (id, project_id, key, encrypted_value, is_secret, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (project_id, key) DO UPDATE SET encrypted_value = excluded.encrypted_value,
		     is_secret = excluded.is_secret, updated_at = excluded.updated_at`,
		NewID(), projectID, key, encrypted, boolToInt(isSecret), Now(), Now())
	return err
}

func (db *DB) DeleteSecret(ctx context.Context, projectID, key string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM project_secrets WHERE project_id = ? AND key = ?`, projectID, key)
	return err
}

// EncryptedSecret is the raw row; callers decrypt through the security cipher.
type EncryptedSecret struct {
	Key       string
	Encrypted string
	IsSecret  bool
	UpdatedAt string
}

func (db *DB) ListSecrets(ctx context.Context, projectID string) ([]EncryptedSecret, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT key, encrypted_value, is_secret, updated_at FROM project_secrets WHERE project_id = ? ORDER BY key`, projectID)
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
func (db *DB) UpsertService(ctx context.Context, projectID, composeServiceName string) (*Service, error) {
	_, err := db.ExecContext(ctx,
		`INSERT INTO services (id, project_id, compose_service_name, display_name, created_at)
		 VALUES (?, ?, ?, '', ?) ON CONFLICT (project_id, compose_service_name) DO NOTHING`,
		NewID(), projectID, composeServiceName, Now())
	if err != nil {
		return nil, err
	}
	return db.ServiceByName(ctx, projectID, composeServiceName)
}

func (db *DB) ServiceByName(ctx context.Context, projectID, name string) (*Service, error) {
	return scanService(db.QueryRowContext(ctx,
		`SELECT id, project_id, compose_service_name, display_name, created_at
		 FROM services WHERE project_id = ? AND compose_service_name = ?`, projectID, name))
}

func (db *DB) ServiceByID(ctx context.Context, id string) (*Service, error) {
	return scanService(db.QueryRowContext(ctx,
		`SELECT id, project_id, compose_service_name, display_name, created_at FROM services WHERE id = ?`, id))
}

func scanService(row scanner) (*Service, error) {
	var s Service
	err := row.Scan(&s.ID, &s.ProjectID, &s.ComposeServiceName, &s.DisplayName, &s.CreatedAt)
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
		`SELECT id, project_id, compose_service_name, display_name, created_at
		 FROM services WHERE project_id = ? ORDER BY compose_service_name`, projectID)
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

// PruneServices drops services that disappeared from the compose file.
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
		if kept[s.ComposeServiceName] {
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

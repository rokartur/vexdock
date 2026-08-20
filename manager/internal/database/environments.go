package database

import (
	"context"
	"database/sql"
	"errors"
)

const environmentColumns = `id, project_id, name, slug, branch, compose_project_name, is_default, created_at, updated_at`

func (db *DB) CreateEnvironment(ctx context.Context, e *Environment) error {
	e.CreatedAt, e.UpdatedAt = Now(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO environments (`+environmentColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ID, e.ProjectID, e.Name, e.Slug, e.Branch, e.ComposeProjectName, boolToInt(e.IsDefault),
		e.CreatedAt, e.UpdatedAt)
	return err
}

func (db *DB) UpdateEnvironment(ctx context.Context, e *Environment) error {
	e.UpdatedAt = Now()
	_, err := db.ExecContext(ctx,
		`UPDATE environments SET name = ?, slug = ?, branch = ?, updated_at = ? WHERE id = ?`,
		e.Name, e.Slug, e.Branch, e.UpdatedAt, e.ID)
	return err
}

func (db *DB) DeleteEnvironment(ctx context.Context, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM environments WHERE id = ?`, id)
	return err
}

func (db *DB) EnvironmentByID(ctx context.Context, id string) (*Environment, error) {
	return scanEnvironment(db.QueryRowContext(ctx,
		`SELECT `+environmentColumns+` FROM environments WHERE id = ?`, id))
}

// DefaultEnvironment is where a project opens and where anything that names a
// project but no environment lands.
func (db *DB) DefaultEnvironment(ctx context.Context, projectID string) (*Environment, error) {
	return scanEnvironment(db.QueryRowContext(ctx,
		`SELECT `+environmentColumns+` FROM environments WHERE project_id = ? ORDER BY is_default DESC, created_at LIMIT 1`,
		projectID))
}

// EnvironmentOrDefault resolves an explicit environment against the project it
// must belong to, and falls back to the default one when the caller only knows
// a project. The ownership check is what stops an id from another project being
// passed in to reach across the boundary.
func (db *DB) EnvironmentOrDefault(ctx context.Context, projectID, environmentID string) (*Environment, error) {
	if environmentID == "" {
		return db.DefaultEnvironment(ctx, projectID)
	}
	env, err := db.EnvironmentByID(ctx, environmentID)
	if err != nil {
		return nil, err
	}
	if env.ProjectID != projectID {
		return nil, ErrNotFound
	}
	return env, nil
}

func (db *DB) ListEnvironments(ctx context.Context, projectID string) ([]Environment, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT `+environmentColumns+` FROM environments WHERE project_id = ? ORDER BY is_default DESC, name`,
		projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Environment{}
	for rows.Next() {
		e, err := scanEnvironment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

func scanEnvironment(row scanner) (*Environment, error) {
	var e Environment
	var isDefault int
	err := row.Scan(&e.ID, &e.ProjectID, &e.Name, &e.Slug, &e.Branch, &e.ComposeProjectName, &isDefault,
		&e.CreatedAt, &e.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	e.IsDefault = isDefault == 1
	return &e, nil
}

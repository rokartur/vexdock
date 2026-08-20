package database

import (
	"context"
	"database/sql"
	"errors"
)

const deploymentColumns = `id, project_id, number, service_name, commit_sha, branch, status, trigger, created_by, error, started_at, finished_at, created_at`

// CreateDeployment allocates the next per-project deployment number.
func (db *DB) CreateDeployment(ctx context.Context, d *Deployment) error {
	var next int
	if err := db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(number), 0) + 1 FROM deployments WHERE project_id = ?`, d.ProjectID).Scan(&next); err != nil {
		return err
	}
	d.ID, d.Number, d.CreatedAt = NewID(), next, Now()
	if d.Status == "" {
		d.Status = DeploymentQueued
	}
	_, err := db.ExecContext(ctx,
		`INSERT INTO deployments (`+deploymentColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.ID, d.ProjectID, d.Number, d.ServiceName, d.CommitSHA, d.Branch, d.Status, d.Trigger, d.CreatedBy, d.Error,
		d.StartedAt, d.FinishedAt, d.CreatedAt)
	return err
}

func (db *DB) UpdateDeployment(ctx context.Context, d *Deployment) error {
	_, err := db.ExecContext(ctx,
		`UPDATE deployments SET commit_sha=?, branch=?, status=?, error=?, started_at=?, finished_at=? WHERE id=?`,
		d.CommitSHA, d.Branch, d.Status, d.Error, d.StartedAt, d.FinishedAt, d.ID)
	return err
}

func (db *DB) DeploymentByID(ctx context.Context, id string) (*Deployment, error) {
	return scanDeployment(db.QueryRowContext(ctx, `SELECT `+deploymentColumns+` FROM deployments WHERE id = ?`, id))
}

func (db *DB) ListDeployments(ctx context.Context, projectID string, limit int) ([]Deployment, error) {
	if limit <= 0 {
		limit = 50
	}
	return db.queryDeployments(ctx,
		`SELECT `+deploymentColumns+` FROM deployments WHERE project_id = ? ORDER BY number DESC LIMIT ?`, projectID, limit)
}

// RecentDeployments powers the dashboard activity list across all projects.
func (db *DB) RecentDeployments(ctx context.Context, limit int) ([]Deployment, error) {
	if limit <= 0 {
		limit = 10
	}
	return db.queryDeployments(ctx, `SELECT `+deploymentColumns+` FROM deployments ORDER BY created_at DESC LIMIT ?`, limit)
}

// UnfinishedDeployments are rows left running when the manager restarted; the
// engine marks them failed on boot so the UI never shows a phantom pipeline.
func (db *DB) UnfinishedDeployments(ctx context.Context) ([]Deployment, error) {
	return db.queryDeployments(ctx,
		`SELECT `+deploymentColumns+` FROM deployments WHERE status IN (?, ?)`, DeploymentQueued, DeploymentRunning)
}

func (db *DB) queryDeployments(ctx context.Context, query string, args ...any) ([]Deployment, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Deployment{}
	for rows.Next() {
		d, err := scanDeployment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

func scanDeployment(row scanner) (*Deployment, error) {
	var d Deployment
	err := row.Scan(&d.ID, &d.ProjectID, &d.Number, &d.ServiceName, &d.CommitSHA, &d.Branch, &d.Status, &d.Trigger,
		&d.CreatedBy, &d.Error, &d.StartedAt, &d.FinishedAt, &d.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (db *DB) CreateStep(ctx context.Context, s *DeploymentStep) error {
	s.ID = NewID()
	_, err := db.ExecContext(ctx,
		`INSERT INTO deployment_steps (id, deployment_id, position, name, status, output, started_at, finished_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.DeploymentID, s.Position, s.Name, s.Status, s.Output, s.StartedAt, s.FinishedAt)
	return err
}

func (db *DB) UpdateStep(ctx context.Context, s *DeploymentStep) error {
	_, err := db.ExecContext(ctx,
		`UPDATE deployment_steps SET status=?, output=?, started_at=?, finished_at=? WHERE id=?`,
		s.Status, s.Output, s.StartedAt, s.FinishedAt, s.ID)
	return err
}

func (db *DB) ListSteps(ctx context.Context, deploymentID string) ([]DeploymentStep, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, deployment_id, position, name, status, output, started_at, finished_at
		 FROM deployment_steps WHERE deployment_id = ? ORDER BY position`, deploymentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeploymentStep{}
	for rows.Next() {
		var s DeploymentStep
		if err := rows.Scan(&s.ID, &s.DeploymentID, &s.Position, &s.Name, &s.Status, &s.Output,
			&s.StartedAt, &s.FinishedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// CountDeploymentsByStatus feeds the dashboard summary.
func (db *DB) CountDeploymentsByStatus(ctx context.Context, status string) (int, error) {
	var n int
	err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM deployments WHERE status = ?`, status).Scan(&n)
	return n, err
}

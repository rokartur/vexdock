package database

import (
	"context"
	"database/sql"
	"errors"
)

// ScheduledTask is a cron job that runs inside a service's container.
type ScheduledTask struct {
	ID          string `json:"id"`
	ServiceID   string `json:"service_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Schedule    string `json:"schedule"`
	// Timezone is the IANA zone whose wall clock the schedule is read against.
	Timezone string `json:"timezone"`
	Command  string `json:"command"`
	// Shell is "sh" or "bash", whichever the image actually ships.
	Shell     string `json:"shell"`
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	// LastRun is the newest execution, absent until the task has run once. Its
	// output is left empty here; a list of tasks should not carry a megabyte of
	// console noise nobody asked for.
	LastRun *TaskRun `json:"last_run,omitempty"`
	// NextRun is when the schedule fires next. Computed on read rather than
	// stored, since it is a function of the expression and the current time.
	NextRun string `json:"next_run,omitempty"`
}

// TaskRun is one execution of a scheduled task.
type TaskRun struct {
	ID         string `json:"id"`
	TaskID     string `json:"task_id"`
	StartedAt  string `json:"started_at"`
	FinishedAt string `json:"finished_at"`
	ExitCode   int    `json:"exit_code"`
	Output     string `json:"output"`
}

const taskColumns = `id, service_id, name, description, schedule, timezone, command, shell, enabled, created_at, updated_at`

func scanTask(row interface{ Scan(...any) error }) (*ScheduledTask, error) {
	var t ScheduledTask
	err := row.Scan(&t.ID, &t.ServiceID, &t.Name, &t.Description, &t.Schedule, &t.Timezone,
		&t.Command, &t.Shell, &t.Enabled, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// ScheduledTasksByService lists a service's tasks, newest run attached.
func (db *DB) ScheduledTasksByService(ctx context.Context, serviceID string) ([]ScheduledTask, error) {
	return db.listTasks(ctx, `WHERE service_id = ?`, serviceID)
}

// AllScheduledTasks lists every task on the server, newest run attached.
func (db *DB) AllScheduledTasks(ctx context.Context) ([]ScheduledTask, error) {
	return db.listTasks(ctx, ``)
}

func (db *DB) listTasks(ctx context.Context, where string, args ...any) ([]ScheduledTask, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT `+taskColumns+` FROM scheduled_tasks `+where+` ORDER BY created_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ScheduledTask{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	last, err := db.lastRunPerTask(ctx, where, args...)
	if err != nil {
		return nil, err
	}
	for i := range out {
		if run, ok := last[out[i].ID]; ok {
			out[i].LastRun = run
		}
	}
	return out, nil
}

// lastRunPerTask fetches the newest run of every task matching the same clause
// in one query, keyed by task id.
func (db *DB) lastRunPerTask(ctx context.Context, where string, args ...any) (map[string]*TaskRun, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, task_id, started_at, finished_at, exit_code FROM (
			SELECT id, task_id, started_at, finished_at, exit_code,
			       ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rank
			FROM scheduled_task_runs
			WHERE task_id IN (SELECT id FROM scheduled_tasks `+where+`)
		) WHERE rank = 1`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*TaskRun{}
	for rows.Next() {
		var r TaskRun
		if err := rows.Scan(&r.ID, &r.TaskID, &r.StartedAt, &r.FinishedAt, &r.ExitCode); err != nil {
			return nil, err
		}
		out[r.TaskID] = &r
	}
	return out, rows.Err()
}

// EnabledScheduledTasks returns every task the runner should consider on a tick.
func (db *DB) EnabledScheduledTasks(ctx context.Context) ([]ScheduledTask, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+taskColumns+` FROM scheduled_tasks WHERE enabled = 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ScheduledTask{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

func (db *DB) ScheduledTaskByID(ctx context.Context, id string) (*ScheduledTask, error) {
	return scanTask(db.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM scheduled_tasks WHERE id = ?`, id))
}

func (db *DB) CreateScheduledTask(ctx context.Context, t *ScheduledTask) error {
	t.ID, t.CreatedAt, t.UpdatedAt = NewID(), Now(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO scheduled_tasks (`+taskColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.ServiceID, t.Name, t.Description, t.Schedule, t.Timezone,
		t.Command, t.Shell, t.Enabled, t.CreatedAt, t.UpdatedAt)
	return err
}

func (db *DB) UpdateScheduledTask(ctx context.Context, t *ScheduledTask) error {
	t.UpdatedAt = Now()
	_, err := db.ExecContext(ctx,
		`UPDATE scheduled_tasks SET name = ?, description = ?, schedule = ?, timezone = ?,
		        command = ?, shell = ?, enabled = ?, updated_at = ? WHERE id = ?`,
		t.Name, t.Description, t.Schedule, t.Timezone, t.Command, t.Shell, t.Enabled, t.UpdatedAt, t.ID)
	return err
}

func (db *DB) DeleteScheduledTask(ctx context.Context, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM scheduled_tasks WHERE id = ?`, id)
	return err
}

// StartTaskRun records an execution that is under way. The run it returns is
// what FinishTaskRun completes, so no caller has to read the row back.
func (db *DB) StartTaskRun(ctx context.Context, taskID string) (*TaskRun, error) {
	run := &TaskRun{ID: NewID(), TaskID: taskID, StartedAt: Now(), ExitCode: -1}
	_, err := db.ExecContext(ctx,
		`INSERT INTO scheduled_task_runs (id, task_id, started_at) VALUES (?, ?, ?)`,
		run.ID, run.TaskID, run.StartedAt)
	if err != nil {
		return nil, err
	}
	return run, nil
}

// maxRunOutput caps what one run can write into SQLite. The tail is what
// matters when a command fails, so the head is what gets dropped.
const maxRunOutput = 64 << 10

// FinishTaskRun stores the result and updates run to match what was written.
func (db *DB) FinishTaskRun(ctx context.Context, run *TaskRun, exitCode int, output string) error {
	if len(output) > maxRunOutput {
		output = "[output truncated]\n" + output[len(output)-maxRunOutput:]
	}
	run.FinishedAt, run.ExitCode, run.Output = Now(), exitCode, output
	_, err := db.ExecContext(ctx,
		`UPDATE scheduled_task_runs SET finished_at = ?, exit_code = ?, output = ? WHERE id = ?`,
		run.FinishedAt, run.ExitCode, run.Output, run.ID)
	return err
}

// RecoverInterruptedTaskRuns closes out runs that were in flight when the
// manager stopped, so the UI never shows an execution nothing is running.
func (db *DB) RecoverInterruptedTaskRuns(ctx context.Context) error {
	_, err := db.ExecContext(ctx,
		`UPDATE scheduled_task_runs SET finished_at = ?, output = ?
		 WHERE finished_at = ''`, Now(), "interrupted by a manager restart")
	return err
}

// TaskRuns returns a task's executions, newest first.
func (db *DB) TaskRuns(ctx context.Context, taskID string, limit int) ([]TaskRun, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	rows, err := db.QueryContext(ctx,
		`SELECT id, task_id, started_at, finished_at, exit_code, output
		 FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`, taskID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TaskRun{}
	for rows.Next() {
		var r TaskRun
		if err := rows.Scan(&r.ID, &r.TaskID, &r.StartedAt, &r.FinishedAt, &r.ExitCode, &r.Output); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PruneTaskRuns keeps the newest n runs per task.
func (db *DB) PruneTaskRuns(ctx context.Context, keepPerTask int) error {
	_, err := db.ExecContext(ctx,
		`DELETE FROM scheduled_task_runs WHERE id IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rank
				FROM scheduled_task_runs
			) WHERE rank > ?
		)`, keepPerTask)
	return err
}

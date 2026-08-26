-- Cron jobs that run inside a service's container. The manager ticks once a
-- minute and execs the command; there is no per-task daemon and no catch-up for
-- ticks missed while the manager was down.
CREATE TABLE scheduled_tasks (
    id         TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    -- Five field cron expression, matched against UTC.
    schedule   TEXT NOT NULL,
    command    TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_scheduled_tasks_service ON scheduled_tasks(service_id);

-- One row per execution, pruned to the newest few per task.
CREATE TABLE scheduled_task_runs (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    -- -1 when the command never started (no container, exec refused).
    exit_code   INTEGER NOT NULL DEFAULT -1,
    output      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_scheduled_task_runs_task ON scheduled_task_runs(task_id, started_at);

-- vexdock:rebuild
--
-- A deploy runs for one service, so its number is that service's. The counter
-- used to be per project, which made the first deploy of a new service read
-- #16 because fifteen of its neighbours had deployed before it.
--
-- deployment_steps references deployments(id), and ids do not change here, so
-- the rebuild only moves the UNIQUE constraint.

CREATE TABLE deployments_new (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id TEXT NOT NULL DEFAULT '',
    number         INTEGER NOT NULL,
    service_name   TEXT NOT NULL DEFAULT '',
    commit_sha     TEXT NOT NULL DEFAULT '',
    branch         TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL,
    trigger        TEXT NOT NULL,
    created_by     TEXT NOT NULL DEFAULT '',
    error          TEXT NOT NULL DEFAULT '',
    started_at     TEXT NOT NULL DEFAULT '',
    finished_at    TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    UNIQUE (environment_id, service_name, number)
);

-- Renumbered by age, so a service's history keeps its order and starts at 1.
-- Deploys from before a deployment named its service share the empty name and
-- so keep one sequence per environment.
INSERT INTO deployments_new
SELECT id, project_id, environment_id,
       ROW_NUMBER() OVER (PARTITION BY environment_id, service_name ORDER BY created_at, id),
       service_name, commit_sha, branch, status, trigger, created_by, error, started_at, finished_at, created_at
FROM deployments;

DROP TABLE deployments;
ALTER TABLE deployments_new RENAME TO deployments;

CREATE INDEX idx_deployments_project ON deployments(project_id, created_at DESC);
CREATE INDEX idx_deployments_environment ON deployments(environment_id, created_at DESC);

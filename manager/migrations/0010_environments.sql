-- vexdock:rebuild
--
-- Environments split a project into independently deployed copies: production
-- and staging run their own containers, their own variables and their own
-- domains out of one project record.
--
-- The upgrade has to be invisible to a running install. Two choices make it so:
-- the backfilled production environment takes the project's own id, so its
-- directory under projects/ is the directory that is already there, and it
-- takes the project's compose_project_name, so the containers, volumes and
-- networks it owns are the ones already running. Nothing moves and nothing
-- redeploys; only the metadata changes shape.

CREATE TABLE environments (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    slug                 TEXT NOT NULL,
    -- Empty means "whatever the project deploys"; set it to deploy a branch of
    -- your own, which is what a staging environment is usually for.
    branch               TEXT NOT NULL DEFAULT '',
    compose_project_name TEXT NOT NULL UNIQUE,
    -- The environment a project opens on, and the one that cannot be deleted.
    is_default           INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    UNIQUE (project_id, slug)
);

CREATE INDEX idx_environments_project ON environments(project_id);

INSERT INTO environments (id, project_id, name, slug, branch, compose_project_name, is_default, created_at, updated_at)
SELECT id, id, 'Production', 'production', '', compose_project_name, 1, created_at, updated_at
FROM projects;

-- Project variables stay project wide, shared by every environment. These are
-- the ones that differ between them.
CREATE TABLE environment_secrets (
    id              TEXT PRIMARY KEY,
    environment_id  TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    is_secret       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (environment_id, key)
);

-- services carries UNIQUE (project_id, compose_service_name), which would stop
-- production and staging from both having a service called web. A table level
-- constraint cannot be dropped in place, hence the rebuild and hence the
-- vexdock:rebuild marker on line one: dropping the old table with foreign keys
-- enforced would cascade into service_secrets and domains and delete every row
-- this migration is preserving.
CREATE TABLE services_rebuilt (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id       TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    compose_service_name TEXT NOT NULL,
    display_name         TEXT NOT NULL DEFAULT '',
    created_at           TEXT NOT NULL,
    type                 TEXT NOT NULL DEFAULT 'application',
    source_type          TEXT NOT NULL DEFAULT 'derived',
    repository_url       TEXT NOT NULL DEFAULT '',
    branch               TEXT NOT NULL DEFAULT '',
    build_path           TEXT NOT NULL DEFAULT '',
    image                TEXT NOT NULL DEFAULT '',
    engine               TEXT NOT NULL DEFAULT '',
    data_path            TEXT NOT NULL DEFAULT '',
    compose_fragment     TEXT NOT NULL DEFAULT '',
    updated_at           TEXT NOT NULL DEFAULT '',
    UNIQUE (environment_id, compose_service_name)
);

INSERT INTO services_rebuilt (id, project_id, environment_id, compose_service_name, display_name, created_at,
    type, source_type, repository_url, branch, build_path, image, engine, data_path, compose_fragment, updated_at)
SELECT id, project_id, project_id, compose_service_name, display_name, created_at,
    type, source_type, repository_url, branch, build_path, image, engine, data_path, compose_fragment, updated_at
FROM services;

DROP TABLE services;
ALTER TABLE services_rebuilt RENAME TO services;

CREATE INDEX idx_services_environment ON services(environment_id);

-- domains and deployments only gain a column, so they are spared a rebuild.
-- Neither declares a foreign key on it: domains already cascades to an
-- environment through service_id, and deleting an environment has to walk its
-- deployments in Go anyway to stop containers and reclaim the directory.
ALTER TABLE domains ADD COLUMN environment_id TEXT NOT NULL DEFAULT '';
UPDATE domains SET environment_id = project_id;
CREATE INDEX idx_domains_environment ON domains(environment_id);

ALTER TABLE deployments ADD COLUMN environment_id TEXT NOT NULL DEFAULT '';
UPDATE deployments SET environment_id = project_id;
CREATE INDEX idx_deployments_environment ON deployments(environment_id, number DESC);

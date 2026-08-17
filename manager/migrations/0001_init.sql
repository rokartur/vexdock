CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE projects (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    slug                 TEXT NOT NULL UNIQUE,
    source_type          TEXT NOT NULL,
    repository_url       TEXT NOT NULL DEFAULT '',
    branch               TEXT NOT NULL DEFAULT 'main',
    compose_path         TEXT NOT NULL DEFAULT 'compose.yml',
    compose_project_name TEXT NOT NULL UNIQUE,
    auto_deploy          INTEGER NOT NULL DEFAULT 0,
    webhook_token        TEXT NOT NULL DEFAULT '',
    git_credential_kind  TEXT NOT NULL DEFAULT 'none',
    git_credential_enc   TEXT NOT NULL DEFAULT '',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

CREATE TABLE project_secrets (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    is_secret       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (project_id, key)
);

CREATE TABLE services (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    compose_service_name TEXT NOT NULL,
    display_name         TEXT NOT NULL DEFAULT '',
    created_at           TEXT NOT NULL,
    UNIQUE (project_id, compose_service_name)
);

CREATE TABLE domains (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    service_id     TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    hostname       TEXT NOT NULL UNIQUE,
    container_port INTEGER NOT NULL,
    https_enabled  INTEGER NOT NULL DEFAULT 0,
    redirect_https INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE INDEX idx_domains_project ON domains(project_id);

CREATE TABLE certificates (
    id              TEXT PRIMARY KEY,
    domain_id       TEXT NOT NULL UNIQUE REFERENCES domains(id) ON DELETE CASCADE,
    hostname        TEXT NOT NULL,
    issuer          TEXT NOT NULL DEFAULT '',
    issued_at       TEXT NOT NULL DEFAULT '',
    expires_at      TEXT NOT NULL DEFAULT '',
    last_renewed_at TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending',
    last_error      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE deployments (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,
    commit_sha  TEXT NOT NULL DEFAULT '',
    branch      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL,
    trigger     TEXT NOT NULL,
    created_by  TEXT NOT NULL DEFAULT '',
    error       TEXT NOT NULL DEFAULT '',
    started_at  TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    UNIQUE (project_id, number)
);
CREATE INDEX idx_deployments_project ON deployments(project_id, number DESC);

CREATE TABLE deployment_steps (
    id            TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    name          TEXT NOT NULL,
    status        TEXT NOT NULL,
    output        TEXT NOT NULL DEFAULT '',
    started_at    TEXT NOT NULL DEFAULT '',
    finished_at   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_steps_deployment ON deployment_steps(deployment_id, position);

CREATE TABLE registries (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL UNIQUE,
    url                TEXT NOT NULL,
    username           TEXT NOT NULL,
    encrypted_password TEXT NOT NULL,
    created_at         TEXT NOT NULL
);

CREATE TABLE system_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

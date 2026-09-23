-- Per-service rules nginx applies on every domain of the service, and host
-- ports the compose overlay publishes.

CREATE TABLE service_redirects (
    id          TEXT PRIMARY KEY,
    service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    regex       TEXT NOT NULL,
    replacement TEXT NOT NULL,
    permanent   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_service_redirects_service ON service_redirects(service_id);

-- password_hash is an nginx {SSHA} hash; the password itself is never stored.
CREATE TABLE service_basic_auth (
    id            TEXT PRIMARY KEY,
    service_id    TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (service_id, username)
);

-- One host port and protocol can be bound by one service only.
CREATE TABLE service_ports (
    id         TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    published  INTEGER NOT NULL,
    target     INTEGER NOT NULL,
    protocol   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (published, protocol)
);
CREATE INDEX idx_service_ports_service ON service_ports(service_id);

-- Every state-changing API call is recorded, so "who restarted production at
-- 3am" has an answer that does not depend on container logs still existing.
CREATE TABLE audit_log (
    id          TEXT PRIMARY KEY,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    status      INTEGER NOT NULL,
    client_ip   TEXT NOT NULL DEFAULT '',
    credential  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_log_at ON audit_log(at DESC);

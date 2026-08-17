-- Authentication moved to the better-auth service, which owns users and
-- sessions in its own database. The manager only validates them, so its own
-- credential tables are dropped and API tokens keep the better-auth user id as
-- a plain value rather than a foreign key into a table that no longer exists.
CREATE TABLE api_tokens_new (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    last_used_at TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
);

INSERT INTO api_tokens_new (id, user_id, name, token_hash, prefix, last_used_at, created_at)
SELECT id, user_id, name, token_hash, prefix, last_used_at, created_at FROM api_tokens;

DROP TABLE api_tokens;
ALTER TABLE api_tokens_new RENAME TO api_tokens;
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

DROP TABLE sessions;
DROP TABLE users;

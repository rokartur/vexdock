-- MCP clients that register themselves (RFC 7591). Registration is open, so a
-- client nobody authorized is pruned after a day.
CREATE TABLE oauth_clients (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

-- An OAuth grant is an api_tokens row with a client: its project scopes stay
-- put while the access token rotates hourly and the refresh token on every use.
-- The expiries use second-precision RFC 3339, so they compare as text.
ALTER TABLE api_tokens ADD COLUMN client_id TEXT REFERENCES oauth_clients(id) ON DELETE CASCADE;
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT NOT NULL DEFAULT '';
ALTER TABLE api_tokens ADD COLUMN refresh_hash TEXT;
ALTER TABLE api_tokens ADD COLUMN previous_refresh_hash TEXT;
ALTER TABLE api_tokens ADD COLUMN refresh_expires_at TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_api_tokens_refresh ON api_tokens(refresh_hash);
CREATE INDEX idx_api_tokens_previous_refresh ON api_tokens(previous_refresh_hash);
CREATE INDEX idx_api_tokens_client ON api_tokens(client_id);

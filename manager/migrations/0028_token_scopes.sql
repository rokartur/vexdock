-- A token is either the administrator's (every route, as before) or limited to
-- the projects listed here. Tokens that existed before scopes keep full access.
ALTER TABLE api_tokens ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
UPDATE api_tokens SET admin = 1;

CREATE TABLE api_token_projects (
    token_id   TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    level      TEXT NOT NULL CHECK (level IN ('read', 'write')),
    PRIMARY KEY (token_id, project_id)
);
CREATE INDEX idx_api_token_projects_project ON api_token_projects(project_id);

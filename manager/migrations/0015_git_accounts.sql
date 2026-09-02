-- A git account is one provider token stored once and reused by every service
-- that clones from that provider. It exists so a repository can be picked from
-- a list instead of pasted as a URL with its own copy of the credential.
--
-- No rebuild marker: both statements add, they never rewrite a table.

CREATE TABLE git_accounts (
    id         TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    name       TEXT NOT NULL UNIQUE,
    -- Empty for the hosted providers; a self-hosted GitLab or Gitea origin
    -- otherwise, e.g. https://git.example.com.
    host       TEXT NOT NULL DEFAULT '',
    token_enc  TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Empty means the service carries its own credential, which is still how a
-- plain git URL is cloned.
ALTER TABLE services ADD COLUMN git_account_id TEXT NOT NULL DEFAULT '';

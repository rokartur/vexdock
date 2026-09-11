-- vexdock:rebuild
--
-- Git providers, modelled the way Dokploy models them: one parent row naming
-- the connection and one child row per provider holding the credentials that
-- provider actually uses. The old single git_accounts table pretended a
-- personal access token was the shape of every provider, which is only true of
-- none of them: GitHub connects as an App, GitLab and Gitea as OAuth
-- applications, Bitbucket as a workspace app password.
--
-- Rebuild marker: git_accounts goes away and services loses the column that
-- pointed at it, so foreign keys stay off while the tables are reshaped.

DROP TABLE IF EXISTS git_accounts;

-- The parent. Everything a connection has in common lives here, and the
-- provider_type says which child table holds the rest.
CREATE TABLE git_providers (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK (provider_type IN ('github', 'gitlab', 'bitbucket', 'gitea')),
    created_at    TEXT NOT NULL
);

-- A GitHub App: created through the manifest flow, installed on the
-- repositories its owner picks, and cloning with an installation token minted
-- from the private key. Nothing here is typed by hand.
CREATE TABLE github (
    git_provider_id        TEXT PRIMARY KEY REFERENCES git_providers (id) ON DELETE CASCADE,
    github_app_name        TEXT NOT NULL DEFAULT '',
    github_app_id          TEXT NOT NULL DEFAULT '',
    github_client_id       TEXT NOT NULL DEFAULT '',
    -- Encrypted at rest, as are every private key, secret and token below.
    github_client_secret   TEXT NOT NULL DEFAULT '',
    -- Empty until the owner finishes the install and picks repositories.
    github_installation_id TEXT NOT NULL DEFAULT '',
    github_private_key     TEXT NOT NULL DEFAULT '',
    github_webhook_secret  TEXT NOT NULL DEFAULT '',
    -- GitHub Enterprise Server points this at its own host.
    github_url             TEXT NOT NULL DEFAULT 'https://github.com'
);

-- A GitLab OAuth application. The owner registers it in GitLab, pastes the
-- application id and secret, and authorises it once; the refresh token keeps
-- the connection alive after that.
CREATE TABLE gitlab (
    git_provider_id TEXT PRIMARY KEY REFERENCES git_providers (id) ON DELETE CASCADE,
    gitlab_url      TEXT NOT NULL DEFAULT 'https://gitlab.com',
    application_id  TEXT NOT NULL DEFAULT '',
    redirect_uri    TEXT NOT NULL DEFAULT '',
    secret          TEXT NOT NULL DEFAULT '',
    access_token    TEXT NOT NULL DEFAULT '',
    refresh_token   TEXT NOT NULL DEFAULT '',
    -- Optional: narrows the repository list to one group.
    group_name      TEXT NOT NULL DEFAULT '',
    expires_at      INTEGER NOT NULL DEFAULT 0
);

-- Bitbucket has no app to install; a credential pair is the whole connection,
-- and it both lists and clones. Atlassian is retiring app passwords in favour
-- of an account email and an API token, so both pairs are accepted and the API
-- token wins when it is set.
CREATE TABLE bitbucket (
    git_provider_id          TEXT PRIMARY KEY REFERENCES git_providers (id) ON DELETE CASCADE,
    bitbucket_username       TEXT NOT NULL DEFAULT '',
    app_password             TEXT NOT NULL DEFAULT '',
    bitbucket_email          TEXT NOT NULL DEFAULT '',
    api_token                TEXT NOT NULL DEFAULT '',
    bitbucket_workspace_name TEXT NOT NULL DEFAULT ''
);

-- A Gitea OAuth application, same shape as GitLab's but with Gitea's own token
-- endpoint and scope names.
CREATE TABLE gitea (
    git_provider_id       TEXT PRIMARY KEY REFERENCES git_providers (id) ON DELETE CASCADE,
    gitea_url             TEXT NOT NULL DEFAULT 'https://gitea.com',
    redirect_uri          TEXT NOT NULL DEFAULT '',
    client_id             TEXT NOT NULL DEFAULT '',
    client_secret         TEXT NOT NULL DEFAULT '',
    gitea_username        TEXT NOT NULL DEFAULT '',
    access_token          TEXT NOT NULL DEFAULT '',
    refresh_token         TEXT NOT NULL DEFAULT '',
    expires_at            INTEGER NOT NULL DEFAULT 0,
    scopes                TEXT NOT NULL DEFAULT 'repo repo:status read:user read:org',
    last_authenticated_at INTEGER NOT NULL DEFAULT 0,
    organization_name     TEXT NOT NULL DEFAULT ''
);

-- A provider-sourced service names its repository the way its provider does,
-- as an owner and a repository name, and the clone URL is built from the
-- connection at deploy time. repository_url stays for the plain git source,
-- which is the only one that still is a URL.
ALTER TABLE services DROP COLUMN git_account_id;
ALTER TABLE services ADD COLUMN git_provider_id TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN owner TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN repository TEXT NOT NULL DEFAULT '';

-- A service that cloned through a connected account has no connection any
-- more. It keeps its repository URL and falls back to the plain git source,
-- which fails loudly on the next deploy if the repository was private.
UPDATE services SET provider = 'git'
WHERE provider IN ('github', 'gitlab', 'bitbucket', 'gitea') AND repository_url != '';
UPDATE services SET provider = 'unconfigured'
WHERE provider IN ('github', 'gitlab', 'bitbucket', 'gitea');

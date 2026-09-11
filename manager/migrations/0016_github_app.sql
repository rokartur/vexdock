-- A GitHub App is the second way to connect an account. A personal token can
-- read everything its owner can; an app is installed on the repositories its
-- owner picks, all of them or a few, and the manager mints a token that lives
-- an hour from the app's private key every time it needs one.
--
-- It is still one row in git_accounts, so services, the repository picker and
-- the branch picker never learn which kind connected them. For an app account
-- token_enc holds the private key rather than a token, and webhook_secret_enc
-- verifies the push events the app delivers.
--
-- No rebuild marker: every statement adds a column.

ALTER TABLE git_accounts ADD COLUMN app_id TEXT NOT NULL DEFAULT '';
ALTER TABLE git_accounts ADD COLUMN app_slug TEXT NOT NULL DEFAULT '';
-- Empty until the owner finishes the install on GitHub and picks repositories.
ALTER TABLE git_accounts ADD COLUMN installation_id TEXT NOT NULL DEFAULT '';
ALTER TABLE git_accounts ADD COLUMN webhook_secret_enc TEXT NOT NULL DEFAULT '';

-- A service becomes the deployable unit inside a project.
--
-- Rows written by a deployment stay 'derived': they mirror whatever the
-- project's own compose file declares and the dashboard shows them read-only.
-- Rows the dashboard creates carry their own source and are rendered into an
-- overlay compose file the manager owns, layered over the project's file with
-- a second --file flag. That is why nothing here rewrites existing projects:
-- an imported compose keeps working untouched and can still gain a database.
ALTER TABLE services ADD COLUMN type TEXT NOT NULL DEFAULT 'application';
ALTER TABLE services ADD COLUMN source_type TEXT NOT NULL DEFAULT 'derived';
ALTER TABLE services ADD COLUMN repository_url TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN branch TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN build_path TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN image TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN engine TEXT NOT NULL DEFAULT '';
-- Only the custom engine needs this: its fragment mounts the data volume at a
-- path the catalog cannot know. Re-rendering the overlay needs it back, so it
-- has to survive the create request.
ALTER TABLE services ADD COLUMN data_path TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN compose_fragment TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

-- Per-service environment. Project secrets stay where they are and remain the
-- shared set; these are the variables only one service sees, which is what
-- lets two Postgres services in one project both use POSTGRES_PASSWORD.
CREATE TABLE service_secrets (
    id              TEXT PRIMARY KEY,
    service_id      TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    is_secret       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (service_id, key)
);

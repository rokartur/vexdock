-- Where code comes from is a property of the service, not of the project. A
-- project used to own a source, a repository and a compose path, and its
-- services were derived from the file that produced. Now each service names its
-- own provider and carries its own git credential, and the project is just the
-- thing they are grouped under.
--
-- No rebuild marker: SQLite drops plain columns in place, and none of these are
-- part of an index or a table level constraint.

ALTER TABLE services ADD COLUMN provider TEXT NOT NULL DEFAULT 'unconfigured';
ALTER TABLE services ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'none';
ALTER TABLE services ADD COLUMN credential_enc TEXT NOT NULL DEFAULT '';

-- 'derived' has no equivalent: the project compose file it was read from is no
-- longer loaded, so those services have no definition and come back
-- unconfigured for their owner to point at a provider.
UPDATE services SET provider = CASE source_type
    WHEN 'git' THEN 'git'
    WHEN 'image' THEN 'image'
    WHEN 'compose' THEN 'raw'
    ELSE 'unconfigured'
END;

-- A git service used to clone with its project's credential. Hand it down
-- before the column holding it disappears.
UPDATE services SET
    credential_kind = COALESCE((SELECT p.git_credential_kind FROM projects p WHERE p.id = services.project_id), 'none'),
    credential_enc  = COALESCE((SELECT p.git_credential_enc  FROM projects p WHERE p.id = services.project_id), '')
WHERE provider = 'git';

ALTER TABLE services DROP COLUMN source_type;

ALTER TABLE projects DROP COLUMN source_type;
ALTER TABLE projects DROP COLUMN repository_url;
ALTER TABLE projects DROP COLUMN branch;
ALTER TABLE projects DROP COLUMN compose_path;
ALTER TABLE projects DROP COLUMN git_credential_kind;
ALTER TABLE projects DROP COLUMN git_credential_enc;

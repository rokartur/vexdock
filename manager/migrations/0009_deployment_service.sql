-- Optional compose service a deployment targets. Empty means the whole project.
ALTER TABLE deployments ADD COLUMN service_name TEXT NOT NULL DEFAULT '';

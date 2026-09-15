-- A push deploys one service, so the switch that arms it belongs to the
-- service. Every service of a project that had auto deploy on keeps it on.

ALTER TABLE services ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 0;

UPDATE services SET auto_deploy = 1
WHERE project_id IN (SELECT id FROM projects WHERE auto_deploy = 1);

ALTER TABLE projects DROP COLUMN auto_deploy;

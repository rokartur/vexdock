-- A service that rebuilds on every push leaves build cache behind. The switch
-- that sweeps it after a build belongs to the service, like auto deploy.

ALTER TABLE services ADD COLUMN prune_build_cache INTEGER NOT NULL DEFAULT 0;

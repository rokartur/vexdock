-- Site analytics is gone: no beacon, no ingest endpoint, no panel.
DROP INDEX IF EXISTS idx_analytics_host_at;
DROP TABLE IF EXISTS analytics_events;
ALTER TABLE domains DROP COLUMN analytics;

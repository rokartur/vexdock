-- Web analytics for the sites this server proxies. Opt-in per domain: with the
-- flag on, the generated vhost injects a beacon and routes it back here.
ALTER TABLE domains ADD COLUMN analytics INTEGER NOT NULL DEFAULT 0;

-- One row per event. Everything the panel shows is aggregated at query time and
-- rows fall out of the table on retention, so there is nothing to keep in sync.
-- ponytail: no rollup tables. Add them if a 30-day query stops being instant.
CREATE TABLE analytics_events (
    at       INTEGER NOT NULL,
    hostname TEXT NOT NULL,
    -- Salted daily hash of ip+user agent. Not reversible, not stable across
    -- days, so no cookie and no consent banner.
    visitor  TEXT NOT NULL,
    -- pageview, ping, or a custom event name.
    kind     TEXT NOT NULL,
    path     TEXT NOT NULL DEFAULT '',
    referrer TEXT NOT NULL DEFAULT '',
    country  TEXT NOT NULL DEFAULT '',
    device   TEXT NOT NULL DEFAULT '',
    browser  TEXT NOT NULL DEFAULT '',
    os       TEXT NOT NULL DEFAULT '',
    props    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_analytics_host_at ON analytics_events(hostname, at);

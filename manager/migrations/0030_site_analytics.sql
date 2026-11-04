-- Site analytics: what the /_vx/script.js beacon on a proxied hostname reports,
-- plus the payments a site's backend attributes to a visitor. Everything the
-- panel shows is aggregated at read time from these rows.
CREATE TABLE analytics_events (
    domain_id    TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    at           INTEGER NOT NULL,
    -- Random ids the script keeps in first-party cookies: vx_vid for a year,
    -- vx_sid for thirty idle minutes.
    visitor      TEXT NOT NULL,
    session      TEXT NOT NULL,
    -- pageview, ping or goal.
    kind         TEXT NOT NULL,
    -- The goal's name; empty for the other kinds.
    name         TEXT NOT NULL DEFAULT '',
    path         TEXT NOT NULL DEFAULT '',
    referrer     TEXT NOT NULL DEFAULT '',
    utm_source   TEXT NOT NULL DEFAULT '',
    utm_medium   TEXT NOT NULL DEFAULT '',
    utm_campaign TEXT NOT NULL DEFAULT '',
    -- An ISO country code when Cloudflare sends CF-IPCountry, otherwise the
    -- browser's IANA timezone. No IP address is stored or looked up.
    location     TEXT NOT NULL DEFAULT '',
    device       TEXT NOT NULL DEFAULT '',
    browser      TEXT NOT NULL DEFAULT '',
    os           TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_analytics_events_domain_at ON analytics_events(domain_id, at);

CREATE TABLE analytics_payments (
    domain_id  TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    -- The payment provider's id, so a retried webhook records it once.
    payment_id TEXT NOT NULL,
    at         INTEGER NOT NULL,
    visitor    TEXT NOT NULL DEFAULT '',
    -- Minor units: 4900 is 49.00.
    amount     INTEGER NOT NULL,
    currency   TEXT NOT NULL,
    PRIMARY KEY (domain_id, payment_id)
);

CREATE INDEX idx_analytics_payments_domain_at ON analytics_payments(domain_id, at);

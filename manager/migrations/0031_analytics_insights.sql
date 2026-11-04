-- Region and city come from the DB-IP Lite database at collection time; the
-- address itself is still neither stored nor logged.
ALTER TABLE analytics_events ADD COLUMN region TEXT NOT NULL DEFAULT '';
ALTER TABLE analytics_events ADD COLUMN city   TEXT NOT NULL DEFAULT '';
-- A goal's parameters as a JSON object of short strings; empty for the rest.
ALTER TABLE analytics_events ADD COLUMN props  TEXT NOT NULL DEFAULT '';

-- A visitor's journey and the cookieless session lookup read one visitor at a time.
CREATE INDEX idx_analytics_events_domain_visitor ON analytics_events(domain_id, visitor, at);
CREATE INDEX idx_analytics_payments_domain_visitor ON analytics_payments(domain_id, visitor);
-- The site list's 24 hour totals and the retention prune read every domain by time.
CREATE INDEX idx_analytics_events_at ON analytics_events(at);

-- One row per site that changed a setting. Every *_enc column is sealed with
-- the master key; share_token_hash is the SHA-256 the public route looks up.
CREATE TABLE analytics_sites (
    domain_id               TEXT PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
    share_token_hash        TEXT NOT NULL DEFAULT '',
    share_token_enc         TEXT NOT NULL DEFAULT '',
    notify_url_enc          TEXT NOT NULL DEFAULT '',
    -- When the weekly digest last went out, unix seconds.
    digest_sent_at          INTEGER NOT NULL DEFAULT 0,
    -- Newline-separated addresses whose hits are dropped.
    excluded_ips            TEXT NOT NULL DEFAULT '',
    x_token_enc             TEXT NOT NULL DEFAULT '',
    reddit                  INTEGER NOT NULL DEFAULT 0,
    stripe_secret_enc       TEXT NOT NULL DEFAULT '',
    lemonsqueezy_secret_enc TEXT NOT NULL DEFAULT '',
    paddle_secret_enc       TEXT NOT NULL DEFAULT '',
    polar_secret_enc        TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_analytics_sites_share ON analytics_sites(share_token_hash) WHERE share_token_hash != '';

CREATE TABLE analytics_funnels (
    id        TEXT PRIMARY KEY,
    domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    -- JSON array of {"kind": "page" | "goal" | "payment", "value": "..."}.
    steps     TEXT NOT NULL
);
CREATE INDEX idx_analytics_funnels_domain ON analytics_funnels(domain_id);

-- Marks on the traffic chart: notes typed in the panel and mentions found on
-- X and Reddit. external_id keeps a mention from being added twice.
CREATE TABLE analytics_annotations (
    id          TEXT PRIMARY KEY,
    domain_id   TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    at          INTEGER NOT NULL,
    -- note, x or reddit.
    source      TEXT NOT NULL,
    text        TEXT NOT NULL,
    url         TEXT NOT NULL DEFAULT '',
    author      TEXT NOT NULL DEFAULT '',
    -- Space-separated t.co links a tweet carries, so a t.co referrer finds its tweet.
    links       TEXT NOT NULL DEFAULT '',
    external_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_analytics_annotations_domain_at ON analytics_annotations(domain_id, at);
CREATE UNIQUE INDEX idx_analytics_annotations_external ON analytics_annotations(domain_id, source, external_id) WHERE external_id != '';

-- /_vx/l/{slug} on the site's own hostname redirects to target with the UTM
-- parameters added, so a shared link shows up as its campaign.
CREATE TABLE analytics_links (
    domain_id    TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    slug         TEXT NOT NULL,
    target       TEXT NOT NULL,
    utm_source   TEXT NOT NULL DEFAULT '',
    utm_medium   TEXT NOT NULL DEFAULT '',
    utm_campaign TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (domain_id, slug)
);

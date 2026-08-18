-- Sampled CPU/RAM/disk and per-container usage, so the panel can draw history
-- instead of only what arrived since the page was opened.
--
-- Timestamps are unix seconds, not the RFC3339 text used elsewhere: charts
-- bucket by integer division on `at`, which text timestamps cannot do.
CREATE TABLE host_metrics (
    at           INTEGER NOT NULL,
    cpu_percent  REAL    NOT NULL,
    memory_used  INTEGER NOT NULL,
    memory_total INTEGER NOT NULL,
    disk_used    INTEGER NOT NULL,
    disk_total   INTEGER NOT NULL
);
CREATE INDEX idx_host_metrics_at ON host_metrics(at);

-- service_id is empty for containers the platform does not manage. Keying on
-- it rather than on container_id keeps a service's history across redeploys,
-- which replace the container.
CREATE TABLE container_metrics (
    at           INTEGER NOT NULL,
    container_id TEXT    NOT NULL,
    service_id   TEXT    NOT NULL DEFAULT '',
    cpu_percent  REAL    NOT NULL,
    memory_usage INTEGER NOT NULL,
    memory_limit INTEGER NOT NULL,
    network_rx   INTEGER NOT NULL,
    network_tx   INTEGER NOT NULL,
    block_read   INTEGER NOT NULL,
    block_write  INTEGER NOT NULL
);
CREATE INDEX idx_container_metrics_service ON container_metrics(service_id, at);
CREATE INDEX idx_container_metrics_at ON container_metrics(at);

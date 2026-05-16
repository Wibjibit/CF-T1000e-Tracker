-- Generic key/value config so non-secret settings (forwarder URL, toggles)
-- can be edited from the dashboard without redeploying the worker.
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT    NOT NULL PRIMARY KEY,
    value       TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL  -- unix epoch ms
);

-- Seed the forwarder with sensible defaults. Disabled by default so a fresh
-- install never silently forwards user data to a third party.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('ttnmapper_enabled', '0', 0),
    ('ttnmapper_url',     'https://integrations.ttnmapper.org/tts/v3/uplink-message', 0);

-- Audit / debugging log for the outbound forward calls. Bounded only by the
-- 100k D1 writes/day quota; at 720 uplinks/day a year of history is ~260k
-- rows, well within free-tier storage. We can add a nightly cron to prune
-- when this actually matters.
CREATE TABLE IF NOT EXISTS forward_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,           -- unix epoch ms
    f_cnt       INTEGER NOT NULL,           -- which uplink this forward is for
    target_url  TEXT    NOT NULL,
    status      INTEGER NOT NULL,           -- HTTP status code, or 0 on network/timeout error
    duration_ms INTEGER NOT NULL,
    error       TEXT                        -- nullable; populated on non-2xx or fetch failure
);

CREATE INDEX IF NOT EXISTS idx_forward_log_ts ON forward_log (ts DESC);

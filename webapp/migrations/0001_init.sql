-- One row per LoRaWAN uplink. Idempotent on (dev_eui, f_cnt) so retries or
-- replays don't duplicate. Decoded columns drive the UI; raw_json keeps the
-- original TTN ApplicationUp payload for re-parsing if the decoder changes.

CREATE TABLE IF NOT EXISTS uplinks (
    dev_eui            TEXT    NOT NULL,
    f_cnt              INTEGER NOT NULL,
    received_at        INTEGER NOT NULL,  -- unix epoch ms, UTC

    -- Decoded fields (see docs/payload.md for the v9 byte layout).
    latitude           REAL,
    longitude          REAL,
    altitude_m         INTEGER,
    hdop               REAL,
    sats_tracked       INTEGER,
    sats_in_view       INTEGER,
    fix_quality        INTEGER NOT NULL,
    speed_kmh          INTEGER,
    uart_bytes_rx      INTEGER,
    uart_lines_parsed  INTEGER,
    battery_pct        INTEGER,
    battery_mv         INTEGER,
    temp_c             REAL,
    lux_pct            INTEGER,
    motion             INTEGER NOT NULL DEFAULT 0,  -- 0/1

    -- Radio metadata pulled from TTN rx_metadata[0] (best gateway).
    rssi               INTEGER,
    snr                REAL,
    gateway_id         TEXT,

    -- Full TTN ApplicationUp JSON. Lets us replay decoding if v10 lands.
    raw_json           TEXT NOT NULL,

    PRIMARY KEY (dev_eui, f_cnt)
);

-- Time-range scans for the timeline view and "latest position" lookups.
CREATE INDEX IF NOT EXISTS idx_uplinks_received_at ON uplinks (received_at DESC);

-- Per-device time-range scans (when we eventually support multiple devices).
CREATE INDEX IF NOT EXISTS idx_uplinks_dev_eui_received_at ON uplinks (dev_eui, received_at DESC);

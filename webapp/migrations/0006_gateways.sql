-- Per-gateway cache: TTN-registered metadata (name, location) for every
-- gateway_id we've seen in an uplink's rx_metadata. Drives /beams (we need
-- gateway coordinates to draw the lines) and /gateways (management table).
--
-- We discover gateway_ids lazily from incoming uplinks (ingest hook upserts
-- a sighting row with status='never_refreshed', then waitUntil fetches the
-- real metadata from the TTN gateway API).
--
-- Manual override columns let the user pin a location for hobby gateways
-- whose owner never set a location in TTN; `hidden` excludes a gateway from
-- /beams entirely (e.g. misconfigured location).

CREATE TABLE IF NOT EXISTS gateways (
    gateway_id          TEXT    NOT NULL PRIMARY KEY,

    -- Fetched from TTN /api/v3/gateways/{id}. Nullable until first refresh.
    name                TEXT,
    description         TEXT,
    latitude            REAL,
    longitude           REAL,
    altitude            REAL,

    -- User-pinned location. When NOT NULL, overrides the TTN values for
    -- /beams drawing. Lets us draw beams for gateways the TTN registry
    -- doesn't have a location for.
    latitude_manual     REAL,
    longitude_manual    REAL,
    altitude_manual     REAL,

    -- Excludes this gateway's beams from /beams when 1.
    hidden              INTEGER NOT NULL DEFAULT 0,

    -- Last refresh outcome:
    --   never_refreshed - sighting recorded, TTN not queried yet
    --   ok              - TTN returned data, location present
    --   no_location     - TTN returned data but antennas[0].location is missing
    --   not_found       - TTN returned 404
    --   error           - everything else; details in status_error
    status              TEXT    NOT NULL DEFAULT 'never_refreshed',
    status_error        TEXT,

    first_seen_at       INTEGER NOT NULL,         -- unix epoch ms (first rx_metadata sighting)
    last_refreshed_at   INTEGER,                  -- unix epoch ms of last successful or attempted TTN fetch

    -- Full TTN gateway response (or error body) for debugging.
    raw_json            TEXT
);

CREATE INDEX IF NOT EXISTS idx_gateways_status ON gateways (status);

-- Settings keys for the TTN gateway API client. Stored alongside the
-- forwarder config so they're editable from /settings without redeploying.
-- ttn_ns_host defaults to the EU community network address; ttn_api_key
-- starts empty (gateway lookups skip entirely without it).
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('ttn_api_key', '',                                0),
    ('ttn_ns_host', 'eu1.cloud.thethings.network',     0);

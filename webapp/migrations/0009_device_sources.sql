-- Per-device attachments: one row per (device, mechanism) combination. A
-- T1000-E tracked via LoRa AND Find Hub is two rows; both write to reports
-- independently. LoRa rows always have account_id = NULL (TTN auth lives in
-- the webhook's Basic-Auth header, not a per-device credential).
--
-- The UNIQUE(device_id, source_type, source_ref) constraint makes the
-- get-or-create in src/lib/reports.ts (ensureLoraSource) and the 0011 backfill
-- idempotent: re-running either can only ever find or ignore, never duplicate.

CREATE TABLE IF NOT EXISTS device_sources (
    source_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id        TEXT    NOT NULL REFERENCES devices(device_id),
    source_type      TEXT    NOT NULL
        CHECK (source_type IN ('lora', 'findhub', 'findmy', 'google_maps_sharing')),
    source_ref       TEXT    NOT NULL,  -- LoRa DevEUI, FMDN canonic_id, Apple key id, kid's email, ...
    account_id       INTEGER REFERENCES accounts(account_id),  -- NULL for 'lora'
    config_json      TEXT,                                     -- non-secret per-source config
    enabled          INTEGER NOT NULL DEFAULT 1,
    added_at         INTEGER NOT NULL,                         -- unix epoch ms, UTC
    last_report_at   INTEGER,                                  -- bookkeeping; set by writers when reports arrive

    UNIQUE (device_id, source_type, source_ref)
);

-- The polling-worker pattern (Find Hub etc.) scans for enabled sources of a
-- given type each tick: WHERE source_type = ? AND enabled = 1.
CREATE INDEX IF NOT EXISTS idx_device_sources_type_enabled ON device_sources (source_type, enabled);

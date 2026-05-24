-- The unified position timeline. Every mechanism's decoded output lands here
-- and the map UI reads exclusively from this table. source_type is
-- denormalised from device_sources (spares a JOIN on every pin render / colour
-- lookup); the CHECK mirrors device_sources so the two enums can't drift.
--
-- latitude/longitude are nullable: some "semantic location" reports (Find Hub)
-- arrive with a label and no coordinates, and a LoRa no-fix uplink still files
-- a report (battery/diagnostics) with null coords.
--
-- raw_payload is kept on every row for replay if a decoder bug ships and for
-- forensics when a source_metadata_json schema changes.

CREATE TABLE IF NOT EXISTS reports (
    report_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id             TEXT    NOT NULL REFERENCES devices(device_id),
    source_id             INTEGER NOT NULL REFERENCES device_sources(source_id),
    source_type           TEXT    NOT NULL
        CHECK (source_type IN ('lora', 'findhub', 'findmy', 'google_maps_sharing')),
    received_at           INTEGER NOT NULL,  -- unix epoch ms, UTC
    latitude              REAL,
    longitude             REAL,
    altitude_m            INTEGER,
    accuracy_m            REAL,
    source_metadata_json  TEXT,              -- RSSI/SNR/gateway for LoRa, EID/owner-version for FMDN, ...
    raw_payload           TEXT               -- original payload JSON, kept for replay
);

-- Per-device time-range scans (timeline + "latest position").
CREATE INDEX IF NOT EXISTS idx_reports_device_received ON reports (device_id, received_at DESC);

-- Per-source-type scans (pin-colour filtering, coverage stats).
CREATE INDEX IF NOT EXISTS idx_reports_type_received ON reports (source_type, received_at DESC);

-- Dedup anchor: each (source, instant) maps to exactly one report. Both the
-- ingest dual-write and the polling workers INSERT OR IGNORE against this, so
-- replays and re-running the backfill are no-ops rather than duplicates
-- (docs/architecture.md "Polling sources": dedup on (source_id, received_at)).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_source_received ON reports (source_id, received_at);

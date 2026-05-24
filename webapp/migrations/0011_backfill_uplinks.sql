-- One-shot backfill: every historical `uplinks` row gets an equivalent
-- `reports` row, so the unified timeline (Phase 2 UI) sees the full history,
-- not just uplinks that arrive after this migration.
--
-- This is the SQL mirror of src/lib/reports.ts (ensureLoraSource +
-- loraSourceMetadata + loraReportInsert). The device_id slug
-- ('t1000e-' || lower(dev_eui)), the display name ('T1000-E ' || dev_eui), and
-- the source_metadata_json key set MUST stay identical to that module, so a
-- row written by live ingest and a row written here are equivalent. If you
-- change one side, change the other.
--
-- Idempotent: all three steps are INSERT OR IGNORE. Devices key on their PK,
-- sources on UNIQUE(device_id, source_type, source_ref), and reports on
-- UNIQUE(source_id, received_at) — so re-running (or overlap with live
-- dual-writes that already landed some rows) can only no-op, never duplicate.

-- 1. One device per distinct DevEUI ever seen in uplinks.
INSERT OR IGNORE INTO devices (device_id, display_name, added_at)
SELECT 't1000e-' || lower(dev_eui),
       'T1000-E ' || dev_eui,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM (SELECT DISTINCT dev_eui FROM uplinks);

-- 2. A LoRa source for each (account_id NULL — TTN auth is in the webhook).
INSERT OR IGNORE INTO device_sources (device_id, source_type, source_ref, account_id, enabled, added_at)
SELECT 't1000e-' || lower(dev_eui),
       'lora',
       dev_eui,
       NULL,
       1,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM (SELECT DISTINCT dev_eui FROM uplinks);

-- 3. A unified report per uplink. latitude/longitude/altitude come straight
-- from the columns the decoder already populated (null on a no-fix uplink).
-- accuracy_m is NULL for LoRa. motion is emitted as a JSON boolean (json('...')
-- carries the JSON subtype so json_object embeds it as true/false, matching
-- decoder.ts's boolean) rather than 0/1.
INSERT OR IGNORE INTO reports (
    device_id, source_id, source_type, received_at,
    latitude, longitude, altitude_m, accuracy_m,
    source_metadata_json, raw_payload
)
SELECT
    ds.device_id,
    ds.source_id,
    'lora',
    u.received_at,
    u.latitude,
    u.longitude,
    u.altitude_m,
    NULL,
    json_object(
        'f_cnt', u.f_cnt,
        'rssi', u.rssi,
        'snr', u.snr,
        'gateway_id', u.gateway_id,
        'spreading_factor', u.spreading_factor,
        'hdop', u.hdop,
        'sats_tracked', u.sats_tracked,
        'sats_in_view', u.sats_in_view,
        'fix_quality', u.fix_quality,
        'speed_kmh', u.speed_kmh,
        'battery_pct', u.battery_pct,
        'battery_mv', u.battery_mv,
        'temp_c', u.temp_c,
        'lux_pct', u.lux_pct,
        'motion', CASE WHEN u.motion = 1 THEN json('true') ELSE json('false') END
    ),
    u.raw_json
FROM uplinks u
JOIN device_sources ds
  ON ds.source_type = 'lora' AND ds.source_ref = u.dev_eui;

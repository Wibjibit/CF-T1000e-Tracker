-- Phase 2 regression: prove the new read path (reports) matches the old one
-- (uplinks) row-for-row, catching backfill / decoder drift.
--
-- READ-ONLY (SELECT only) — safe to run against the live remote D1:
--   wrangler d1 execute tracker --local  --file=scripts/regression_reports_vs_uplinks.sql
--   wrangler d1 execute tracker --remote --file=scripts/regression_reports_vs_uplinks.sql
--
-- Each statement prints its own result set. Read them top to bottom:
--   (1) row counts must match (one report per uplink),
--   (2) the mismatch query must return ZERO rows.
-- If (1) differs or (2) returns rows, the backfill (migration 0011) and the
-- live mapping (src/lib/reports.ts) have drifted — fix before relying on the
-- unified read.

-- (1) Counts. uplinks total vs lora reports total. These must be equal.
SELECT 'uplinks_total'      AS metric, COUNT(*) AS n FROM uplinks
UNION ALL
SELECT 'reports_lora_total' AS metric, COUNT(*) AS n FROM reports WHERE source_type = 'lora';

-- (2) Field-level diff. For every uplink, find its backfilled report (joined by
-- the LoRa source for that DevEUI + the received_at instant) and compare every
-- field the read path surfaces. `IS NOT` is null-safe, so a null on one side
-- and a value on the other counts as a mismatch. Expect ZERO rows.
SELECT
  u.dev_eui,
  u.f_cnt,
  u.received_at,
  CASE WHEN r.report_id IS NULL THEN 'no matching report' ELSE 'field mismatch' END AS problem,
  u.latitude        AS u_lat,    r.latitude                                          AS r_lat,
  u.longitude       AS u_lon,    r.longitude                                         AS r_lon,
  u.altitude_m      AS u_alt,    r.altitude_m                                        AS r_alt,
  u.fix_quality     AS u_fix,    json_extract(r.source_metadata_json, '$.fix_quality')      AS r_fix,
  u.sats_tracked    AS u_st,     json_extract(r.source_metadata_json, '$.sats_tracked')     AS r_st,
  u.sats_in_view    AS u_sv,     json_extract(r.source_metadata_json, '$.sats_in_view')     AS r_sv,
  u.hdop            AS u_hdop,   json_extract(r.source_metadata_json, '$.hdop')             AS r_hdop,
  u.speed_kmh       AS u_spd,    json_extract(r.source_metadata_json, '$.speed_kmh')        AS r_spd,
  u.battery_pct     AS u_bat,    json_extract(r.source_metadata_json, '$.battery_pct')      AS r_bat,
  u.battery_mv      AS u_mv,     json_extract(r.source_metadata_json, '$.battery_mv')       AS r_mv,
  u.temp_c          AS u_temp,   json_extract(r.source_metadata_json, '$.temp_c')           AS r_temp,
  u.lux_pct         AS u_lux,    json_extract(r.source_metadata_json, '$.lux_pct')          AS r_lux,
  u.motion          AS u_motion, json_extract(r.source_metadata_json, '$.motion')           AS r_motion,
  u.rssi            AS u_rssi,   json_extract(r.source_metadata_json, '$.rssi')             AS r_rssi,
  u.snr             AS u_snr,    json_extract(r.source_metadata_json, '$.snr')              AS r_snr,
  u.spreading_factor AS u_sf,    json_extract(r.source_metadata_json, '$.spreading_factor') AS r_sf,
  u.gateway_id      AS u_gw,     json_extract(r.source_metadata_json, '$.gateway_id')       AS r_gw,
  u.f_cnt           AS u_fcnt,   json_extract(r.source_metadata_json, '$.f_cnt')            AS r_fcnt
FROM uplinks u
LEFT JOIN device_sources ds
  ON ds.source_type = 'lora' AND ds.source_ref = u.dev_eui
LEFT JOIN reports r
  ON r.source_id = ds.source_id AND r.received_at = u.received_at
WHERE r.report_id IS NULL
   OR u.latitude         IS NOT r.latitude
   OR u.longitude        IS NOT r.longitude
   OR u.altitude_m       IS NOT r.altitude_m
   OR u.fix_quality      IS NOT json_extract(r.source_metadata_json, '$.fix_quality')
   OR u.sats_tracked     IS NOT json_extract(r.source_metadata_json, '$.sats_tracked')
   OR u.sats_in_view     IS NOT json_extract(r.source_metadata_json, '$.sats_in_view')
   OR u.hdop             IS NOT json_extract(r.source_metadata_json, '$.hdop')
   OR u.speed_kmh        IS NOT json_extract(r.source_metadata_json, '$.speed_kmh')
   OR u.battery_pct      IS NOT json_extract(r.source_metadata_json, '$.battery_pct')
   OR u.battery_mv       IS NOT json_extract(r.source_metadata_json, '$.battery_mv')
   OR u.temp_c           IS NOT json_extract(r.source_metadata_json, '$.temp_c')
   OR u.lux_pct          IS NOT json_extract(r.source_metadata_json, '$.lux_pct')
   OR u.motion           IS NOT json_extract(r.source_metadata_json, '$.motion')
   OR u.rssi             IS NOT json_extract(r.source_metadata_json, '$.rssi')
   OR u.snr              IS NOT json_extract(r.source_metadata_json, '$.snr')
   OR u.spreading_factor IS NOT json_extract(r.source_metadata_json, '$.spreading_factor')
   OR u.gateway_id       IS NOT json_extract(r.source_metadata_json, '$.gateway_id')
   OR u.f_cnt            IS NOT json_extract(r.source_metadata_json, '$.f_cnt')
ORDER BY u.received_at DESC
LIMIT 100;

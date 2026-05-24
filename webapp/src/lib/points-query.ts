// SQL builder for /api/points — shared by the map and the timeline table.
//
// Pulled out of the route handler so the filter matrix (time window, device,
// source types, with-fix) is unit-tested without a live D1. The SELECT reads
// the unified `reports` table; the LoRa telemetry that used to be flat columns
// is json_extract'd back out of source_metadata_json (key set owned by
// lib/reports.ts / migration 0011). `meta`/`raw` are the verbatim JSON blobs the
// timeline accordion renders in full.

import { SOURCE_TYPES } from './sources-display';

export interface PointsFilter {
  /** Lower bound (received_at >= sinceMs), unix epoch ms. */
  sinceMs: number;
  /** Optional upper bound (received_at <= untilMs) — the table's custom range. */
  untilMs?: number | null;
  /** Restrict to one device_id. */
  deviceId?: string | null;
  /** Restrict to these source types (invalid ones are dropped). */
  sourceTypes?: string[] | null;
  /** Only rows with a position (latitude IS NOT NULL). */
  onlyWithFix?: boolean;
  /** Row cap. */
  limit: number;
}

export interface BuiltQuery {
  sql: string;
  binds: (string | number)[];
}

const SELECT = `
  SELECT r.report_id AS report_id,
         r.received_at AS ts,
         r.device_id AS device_id, r.source_type AS source_type,
         r.latitude AS lat, r.longitude AS lon, r.altitude_m AS alt,
         r.accuracy_m AS accuracy_m,
         r.pinned_latitude AS pinned_lat, r.pinned_longitude AS pinned_lon,
         ds.pin_no_fix AS pin_no_fix,
         r.source_metadata_json AS meta,
         r.raw_payload AS raw,
         json_extract(r.source_metadata_json, '$.f_cnt')            AS f_cnt,
         json_extract(r.source_metadata_json, '$.fix_quality')      AS fix,
         json_extract(r.source_metadata_json, '$.sats_tracked')     AS sats_tracked,
         json_extract(r.source_metadata_json, '$.sats_in_view')     AS sats_in_view,
         json_extract(r.source_metadata_json, '$.hdop')             AS hdop,
         json_extract(r.source_metadata_json, '$.speed_kmh')        AS speed,
         json_extract(r.source_metadata_json, '$.battery_pct')      AS battery_pct,
         json_extract(r.source_metadata_json, '$.battery_mv')       AS battery_mv,
         json_extract(r.source_metadata_json, '$.temp_c')           AS temp_c,
         json_extract(r.source_metadata_json, '$.lux_pct')          AS lux_pct,
         json_extract(r.source_metadata_json, '$.motion')           AS motion,
         json_extract(r.source_metadata_json, '$.rssi')             AS rssi,
         json_extract(r.source_metadata_json, '$.snr')              AS snr,
         json_extract(r.source_metadata_json, '$.spreading_factor') AS sf
    FROM reports r
    LEFT JOIN device_sources ds ON ds.source_id = r.source_id`;

/** Build the parameterised /api/points query for a filter. Bind order is
 *  deterministic: since, [until], [device], [sourceTypes...], limit. */
export function buildPointsQuery(f: PointsFilter): BuiltQuery {
  const binds: (string | number)[] = [f.sinceMs];
  const clauses = ['r.received_at >= ?'];

  if (f.untilMs != null) {
    clauses.push('r.received_at <= ?');
    binds.push(f.untilMs);
  }
  if (f.deviceId) {
    clauses.push('r.device_id = ?');
    binds.push(f.deviceId);
  }
  const types = (f.sourceTypes ?? []).filter((t) => (SOURCE_TYPES as readonly string[]).includes(t));
  if (types.length > 0) {
    clauses.push(`r.source_type IN (${types.map(() => '?').join(', ')})`);
    binds.push(...types);
  }
  if (f.onlyWithFix) {
    // "Has an effective position": a real fix, an already-pinned snapshot, or a
    // findhub source opted in to Home-pinning (the handler drops the last group
    // if no Home is set). Keeps no-fix-but-pinnable rows in the result so they
    // can surface on the map.
    clauses.push("(r.latitude IS NOT NULL OR r.pinned_latitude IS NOT NULL OR (r.source_type = 'findhub' AND ds.pin_no_fix = 1))");
  }

  const sql = `${SELECT}
   WHERE ${clauses.join(' AND ')}
   ORDER BY r.received_at DESC
   LIMIT ?`;
  binds.push(f.limit);

  return { sql, binds };
}

// ── Home-pinning (no-fix Find Hub → Home) ──────────────────────────────────

export interface EffectiveInputRow {
  lat: number | null;
  lon: number | null;
  pinned_lat: number | null;
  pinned_lon: number | null;
  source_type: string;
  pin_no_fix: number | null;
}

export interface EffectivePosition {
  lat: number | null;
  lon: number | null;
  /** Position came from Home, not a real fix. */
  pinned: boolean;
  /** This row should be persisted (stamped) with the Home snapshot now. */
  needsStamp: boolean;
}

/**
 * Resolve a report's effective position under Home-pinning (master decision:
 * keep the true value, snapshot Home per-report once so moving Home later never
 * moves already-pinned markers):
 *   1. real fix          → used verbatim.
 *   2. already pinned     → reuse the stored snapshot (immune to Home changes).
 *   3. eligible no-fix    → findhub + opted-in + Home set → apply Home + stamp.
 *   4. otherwise          → no position.
 */
export function resolveEffectivePosition(
  row: EffectiveInputRow,
  home: { lat: number | null; lon: number | null },
): EffectivePosition {
  if (row.lat != null && row.lon != null) {
    return { lat: row.lat, lon: row.lon, pinned: false, needsStamp: false };
  }
  if (row.pinned_lat != null && row.pinned_lon != null) {
    return { lat: row.pinned_lat, lon: row.pinned_lon, pinned: true, needsStamp: false };
  }
  if (row.source_type === 'findhub' && row.pin_no_fix === 1 && home.lat != null && home.lon != null) {
    return { lat: home.lat, lon: home.lon, pinned: true, needsStamp: true };
  }
  return { lat: null, lon: null, pinned: false, needsStamp: false };
}

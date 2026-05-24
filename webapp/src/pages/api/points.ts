import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isRange, rangeToSinceMs, type Range } from '../../lib/timeRange';

export const prerender = false;

// Cap returned rows to keep the JSON payload bounded and the map responsive.
// 5000 points = ~7 days at our 2-minute cadence, or longer once the firmware
// adds motion-triggered uplinks.
const MAX_POINTS = 5000;

interface PointRow {
  ts: number;
  device_id: string;
  source_type: string;
  lat: number | null;
  lon: number | null;
  alt: number | null;
  fix: number | null;
  sats_tracked: number | null;
  sats_in_view: number | null;
  hdop: number | null;
  speed: number | null;
  battery_pct: number | null;
  battery_mv: number | null;
  temp_c: number | null;
  lux_pct: number | null;
  motion: 0 | 1 | null;
  rssi: number | null;
  snr: number | null;
  sf: number | null;
}

export const GET: APIRoute = async ({ url }) => {
  const params = url.searchParams;
  const rangeParam = params.get('range');
  const sinceParam = params.get('since');

  let sinceMs: number;
  if (sinceParam !== null) {
    const parsed = Number(sinceParam);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return new Response(JSON.stringify({ ok: false, error: 'Bad "since" param' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    sinceMs = parsed;
  } else {
    const range: Range = isRange(rangeParam) ? rangeParam : '24h';
    sinceMs = rangeToSinceMs(range);
  }

  const onlyWithFix = params.get('with_fix') === '1';
  // Optional device filter. Empty / absent = all devices (one device today,
  // but the map's device selector passes this through for the multi-device
  // future — docs/architecture.md "UI").
  const deviceId = params.get('device_id')?.trim() || null;

  // Read from the unified `reports` timeline, NOT `uplinks` — every mechanism's
  // decoded output lands there. The LoRa telemetry that used to be flat columns
  // now lives in source_metadata_json (the key set is owned by lib/reports.ts /
  // migration 0011); json_extract pulls it back into the flat shape the map and
  // timeline already consume. A JSON boolean `motion` extracts as 1/0, matching
  // the old column. Non-LoRa rows simply yield null telemetry — the position
  // columns (lat/lon/alt/source_type) are source-agnostic.
  //
  // `with_fix` filters on `latitude IS NOT NULL`: decoder.ts nulls latitude
  // exactly when there's no usable fix, so this reproduces the old
  // `fix_quality > 0 AND latitude IS NOT NULL` filter row-for-row for LoRa,
  // while staying correct for sources that have no fix_quality concept.
  const binds: (string | number)[] = [sinceMs];
  let where = 'received_at >= ?';
  if (deviceId) {
    where += ' AND device_id = ?';
    binds.push(deviceId);
  }
  if (onlyWithFix) {
    where += ' AND latitude IS NOT NULL';
  }

  const sql = `
    SELECT received_at AS ts,
           device_id, source_type,
           latitude AS lat, longitude AS lon, altitude_m AS alt,
           json_extract(source_metadata_json, '$.fix_quality')       AS fix,
           json_extract(source_metadata_json, '$.sats_tracked')      AS sats_tracked,
           json_extract(source_metadata_json, '$.sats_in_view')      AS sats_in_view,
           json_extract(source_metadata_json, '$.hdop')              AS hdop,
           json_extract(source_metadata_json, '$.speed_kmh')         AS speed,
           json_extract(source_metadata_json, '$.battery_pct')       AS battery_pct,
           json_extract(source_metadata_json, '$.battery_mv')        AS battery_mv,
           json_extract(source_metadata_json, '$.temp_c')            AS temp_c,
           json_extract(source_metadata_json, '$.lux_pct')           AS lux_pct,
           json_extract(source_metadata_json, '$.motion')            AS motion,
           json_extract(source_metadata_json, '$.rssi')              AS rssi,
           json_extract(source_metadata_json, '$.snr')               AS snr,
           json_extract(source_metadata_json, '$.spreading_factor')  AS sf
      FROM reports
     WHERE ${where}
     ORDER BY received_at DESC
     LIMIT ?
  `;
  binds.push(MAX_POINTS);

  const result = await env.DB.prepare(sql).bind(...binds).all<PointRow>();
  // The query is DESC for index efficiency; flip to ASC for the timeline / polyline.
  const points = (result.results ?? []).slice().reverse();

  return new Response(
    JSON.stringify({
      ok: true,
      since_ms: sinceMs,
      device_id: deviceId,
      count: points.length,
      truncated: points.length === MAX_POINTS,
      points,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Always un-cacheable: the map view should reflect new reports
        // immediately, and this includes per-report RSSI/SNR/gateway
        // metadata that callers should never see stale.
        'Cache-Control': 'no-store',
      },
    },
  );
};

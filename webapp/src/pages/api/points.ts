import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isRange, rangeToSinceMs, type Range } from '../../lib/timeRange';
import { buildPointsQuery, resolveEffectivePosition } from '../../lib/points-query';
import { readHomeLocation } from '../../lib/settings';

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
  // Source-agnostic extras for the map's per-report pins + popups. accuracy_m
  // is the position-accuracy column (Find Hub carries it; LoRa is null); `meta`
  // is the verbatim source_metadata_json string so a popup can render EVERY key
  // a source emits without this API hardcoding per-source fields. The flat
  // columns above stay for the timeline charts (which read LoRa telemetry).
  accuracy_m: number | null;
  meta: string | null;
  // The verbatim raw_payload (decoded frame / report blob) + LoRa frame counter,
  // for the timeline table's expandable detail. f_cnt keys the lazy per-gateway
  // lookup (/api/uplink-detail).
  raw: string | null;
  f_cnt: number | null;
  // Home-pinning internals (migration 0015). report_id keys the one-time stamp;
  // pinned_lat/lon are the per-report Home snapshot; pin_no_fix is the source's
  // opt-in. `pinned` is the resolved output flag (position came from Home).
  report_id: number;
  pinned_lat: number | null;
  pinned_lon: number | null;
  pin_no_fix: number | null;
  pinned?: boolean;
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

  // Optional upper bound (the timeline table's custom end date/time).
  let untilMs: number | null = null;
  const untilParam = params.get('until');
  if (untilParam !== null) {
    const parsed = Number(untilParam);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return new Response(JSON.stringify({ ok: false, error: 'Bad "until" param' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    untilMs = parsed;
  }

  const onlyWithFix = params.get('with_fix') === '1';
  // Optional device filter. Empty / absent = all devices.
  const deviceId = params.get('device_id')?.trim() || null;
  // Optional source-type (network) filter: comma-separated, e.g. "lora,findhub".
  // Invalid types are dropped by the builder; empty = all sources.
  const sourceTypes = (params.get('source_type') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // The query reads the unified `reports` table; see lib/points-query.ts for the
  // column set + the json_extract of the LoRa telemetry. `with_fix` →
  // `latitude IS NOT NULL` (decoder.ts nulls latitude exactly when there's no
  // usable fix, so this is the old fix_quality filter row-for-row for LoRa, and
  // correct for sources with no fix_quality concept).
  const { sql, binds } = buildPointsQuery({
    sinceMs,
    untilMs,
    deviceId,
    sourceTypes,
    onlyWithFix,
    limit: MAX_POINTS,
  });

  const result = await env.DB.prepare(sql).bind(...binds).all<PointRow>();

  // Home-pinning: resolve each row's effective position (true ?? snapshot ??
  // Home for opted-in no-fix findhub), stamping the snapshot once so moving Home
  // later never moves already-pinned markers (migration 0015 / settings Home).
  const home = await readHomeLocation(env.DB);
  const stamps: D1PreparedStatement[] = [];
  const kept: PointRow[] = [];
  for (const row of result.results ?? []) {
    const eff = resolveEffectivePosition(row, home);
    if (eff.needsStamp && eff.lat != null && eff.lon != null) {
      stamps.push(
        env.DB
          .prepare(`UPDATE reports SET pinned_latitude = ?, pinned_longitude = ? WHERE report_id = ?`)
          .bind(eff.lat, eff.lon, row.report_id),
      );
    }
    // with_fix means "has an effective position" — drop the still-locationless.
    if (onlyWithFix && eff.lat == null) continue;
    row.lat = eff.lat;
    row.lon = eff.lon;
    row.pinned = eff.pinned;
    kept.push(row);
  }
  // Persist the one-time snapshots (idempotent — only un-stamped rows reach here).
  if (stamps.length) await env.DB.batch(stamps);

  // The query is DESC for index efficiency; flip to ASC for the timeline / polyline.
  const points = kept.slice().reverse();

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

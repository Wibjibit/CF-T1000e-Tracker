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
  lat: number | null;
  lon: number | null;
  alt: number | null;
  fix: number;
  sats: number | null;
  hdop: number | null;
  speed: number | null;
  battery_pct: number | null;
  battery_mv: number | null;
  temp_c: number | null;
  lux_pct: number | null;
  motion: 0 | 1;
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

  const sql = `
    SELECT received_at AS ts,
           latitude AS lat, longitude AS lon, altitude_m AS alt,
           fix_quality AS fix, sats_tracked AS sats, hdop, speed_kmh AS speed,
           battery_pct, battery_mv, temp_c, lux_pct, motion,
           rssi, snr, spreading_factor AS sf
      FROM uplinks
     WHERE received_at >= ?
       ${onlyWithFix ? 'AND fix_quality > 0 AND latitude IS NOT NULL' : ''}
     ORDER BY received_at DESC
     LIMIT ?
  `;

  const result = await env.DB.prepare(sql).bind(sinceMs, MAX_POINTS).all<PointRow>();
  // The query is DESC for index efficiency; flip to ASC for the timeline / polyline.
  const points = (result.results ?? []).slice().reverse();

  return new Response(
    JSON.stringify({
      ok: true,
      since_ms: sinceMs,
      count: points.length,
      truncated: points.length === MAX_POINTS,
      points,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Phase 4 will gate this behind a session cookie; until then keep
        // it un-cacheable so the map view is always fresh.
        'Cache-Control': 'no-store',
      },
    },
  );
};

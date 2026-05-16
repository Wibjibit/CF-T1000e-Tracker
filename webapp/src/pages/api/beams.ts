import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isRange, rangeToSinceMs, type Range } from '../../lib/timeRange';

export const prerender = false;

// Each beam is one (uplink × gateway-that-heard-it) row. A single uplink
// usually produces 1–4 beams (one per receiving gateway). Cap to keep the
// payload bounded even at SF12 spam levels.
const MAX_BEAMS = 10_000;

interface BeamRow {
  f_cnt: number;
  ts: number;
  dev_lat: number;
  dev_lon: number;
  gw_id: string;
  gw_name: string | null;
  gw_lat: number;
  gw_lon: number;
  rssi: number | null;
  snr: number | null;
}

export const GET: APIRoute = async ({ url }) => {
  const params = url.searchParams;
  const rangeParam = params.get('range');
  const range: Range = isRange(rangeParam) ? rangeParam : '24h';
  const sinceMs = rangeToSinceMs(range);

  // Fan rx_metadata out into one row per beam, join against the gateway
  // cache for an effective lat/lon (manual override beats TTN value), and
  // drop beams from hidden / unlocated / null-island gateways.
  //
  // We require a real device fix too — beams from no-fix uplinks have no
  // device end, so they'd be invisible anyway.
  const sql = `
    SELECT
      u.f_cnt                                                AS f_cnt,
      u.received_at                                          AS ts,
      u.latitude                                             AS dev_lat,
      u.longitude                                            AS dev_lon,
      json_extract(rx.value, '$.gateway_ids.gateway_id')     AS gw_id,
      g.name                                                 AS gw_name,
      COALESCE(g.latitude_manual,  g.latitude)               AS gw_lat,
      COALESCE(g.longitude_manual, g.longitude)              AS gw_lon,
      CAST(json_extract(rx.value, '$.rssi') AS INTEGER)      AS rssi,
      CAST(json_extract(rx.value, '$.snr')  AS REAL)         AS snr
    FROM uplinks u,
         json_each(json_extract(u.raw_json, '$.uplink_message.rx_metadata')) rx
    LEFT JOIN gateways g
      ON g.gateway_id = json_extract(rx.value, '$.gateway_ids.gateway_id')
    WHERE u.received_at >= ?1
      AND u.fix_quality > 0
      AND u.latitude  IS NOT NULL
      AND u.longitude IS NOT NULL
      AND COALESCE(g.hidden, 0) = 0
      AND COALESCE(g.latitude_manual,  g.latitude)  IS NOT NULL
      AND COALESCE(g.longitude_manual, g.longitude) IS NOT NULL
      AND NOT (
            COALESCE(g.latitude_manual,  g.latitude)  = 0
        AND COALESCE(g.longitude_manual, g.longitude) = 0
      )
    ORDER BY u.received_at DESC
    LIMIT ?2
  `;

  const result = await env.DB.prepare(sql).bind(sinceMs, MAX_BEAMS).all<BeamRow>();
  const beams = result.results ?? [];

  return new Response(
    JSON.stringify({
      ok: true,
      since_ms: sinceMs,
      count: beams.length,
      truncated: beams.length === MAX_BEAMS,
      beams,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
};

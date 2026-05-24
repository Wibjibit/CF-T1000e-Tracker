// Lazy per-gateway radio detail for one LoRa report (timeline accordion).
//
// Keyed by (device_id, f_cnt): resolve the device's LoRa DevEUI, look up the
// matching uplink, and parse its stored TTN ApplicationUp rx_metadata[]. Only
// LoRa reports have this; other sources return an empty list.

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { parseRxMetadata } from '../../lib/uplink-detail';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const deviceId = url.searchParams.get('device_id')?.trim();
  const fCntRaw = url.searchParams.get('f_cnt');
  const fCnt = Number(fCntRaw);

  if (!deviceId || fCntRaw === null || !Number.isInteger(fCnt) || fCnt < 0) {
    return json({ ok: false, error: 'device_id and a non-negative integer f_cnt are required' }, 400);
  }

  // device_id → LoRa DevEUI (the source_ref). No LoRa source ⇒ nothing to show.
  const src = await env.DB.prepare(
    `SELECT source_ref FROM device_sources WHERE device_id = ? AND source_type = 'lora' LIMIT 1`,
  )
    .bind(deviceId)
    .first<{ source_ref: string }>();
  if (!src) return json({ ok: true, gateways: [] });

  const row = await env.DB.prepare(`SELECT raw_json FROM uplinks WHERE dev_eui = ? AND f_cnt = ?`)
    .bind(src.source_ref, fCnt)
    .first<{ raw_json: string }>();

  return json({ ok: true, gateways: row ? parseRxMetadata(row.raw_json) : [] });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

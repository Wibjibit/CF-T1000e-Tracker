import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

// Powers the map / timeline device selector. One device today, but the schema
// is multi-device (docs/architecture.md: device identity is primary, tracking
// mechanisms are attachments), so the selector enumerates every device and the
// set of source_types attached to it — enough to drive per-source pin colours.

interface DeviceQueryRow {
  device_id: string;
  display_name: string;
  source_types: string | null; // json_group_array(...) text, or NULL if no sources
  report_count: number;
  last_report_at: number | null;
}

export const GET: APIRoute = async () => {
  const sql = `
    SELECT d.device_id,
           d.display_name,
           (SELECT json_group_array(source_type)
              FROM (SELECT DISTINCT source_type
                      FROM device_sources
                     WHERE device_id = d.device_id
                     ORDER BY source_type)) AS source_types,
           COUNT(r.report_id) AS report_count,
           MAX(r.received_at) AS last_report_at
      FROM devices d
      LEFT JOIN reports r ON r.device_id = d.device_id
     GROUP BY d.device_id, d.display_name
     ORDER BY d.display_name
  `;

  const result = await env.DB.prepare(sql).all<DeviceQueryRow>();
  const devices = (result.results ?? []).map((row) => ({
    device_id: row.device_id,
    display_name: row.display_name,
    source_types: JSON.parse(row.source_types ?? '[]') as string[],
    report_count: row.report_count,
    last_report_at: row.last_report_at,
  }));

  return new Response(
    JSON.stringify({ ok: true, count: devices.length, devices }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
};

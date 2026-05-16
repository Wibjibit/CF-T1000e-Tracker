import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { base64ToBytes, decodeUplink } from '../../lib/decoder';

export const prerender = false;

// TTN's ApplicationUp shape — only the fields we touch.
interface ApplicationUp {
  end_device_ids?: { dev_eui?: string };
  uplink_message?: {
    f_port?: number;
    f_cnt?: number;
    frm_payload?: string;
    received_at?: string;
    rx_metadata?: Array<{
      gateway_ids?: { gateway_id?: string };
      rssi?: number;
      snr?: number;
    }>;
  };
  received_at?: string;
}

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Basic realm="ttn-ingest"',
    },
  });
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Constant-time string comparison to keep auth from leaking length / prefix
// info through timing side-channels. Personal-tracker overkill, but cheap.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !header.toLowerCase().startsWith('basic ')) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export const POST: APIRoute = async ({ request }) => {
  // 1. Basic auth.
  const creds = parseBasicAuth(request.headers.get('Authorization'));
  if (
    !creds ||
    !timingSafeEqual(creds.user, env.TTN_BASIC_AUTH_USER) ||
    !timingSafeEqual(creds.pass, env.TTN_BASIC_AUTH_PASS)
  ) {
    return unauthorized('Invalid credentials');
  }

  // 2. Parse the TTN envelope.
  let body: ApplicationUp;
  try {
    body = (await request.json()) as ApplicationUp;
  } catch {
    return badRequest('Body is not valid JSON');
  }

  const devEui = body.end_device_ids?.dev_eui?.toUpperCase();
  const fCnt = body.uplink_message?.f_cnt;
  const fPort = body.uplink_message?.f_port;
  const frmPayload = body.uplink_message?.frm_payload;
  if (!devEui || typeof fCnt !== 'number' || !frmPayload) {
    return badRequest('Missing dev_eui / f_cnt / frm_payload');
  }

  // 3. DevEUI allowlist (single device for now).
  if (devEui !== env.EXPECTED_DEV_EUI.toUpperCase()) {
    return badRequest(`Unexpected dev_eui ${devEui}`);
  }

  // 4. Decode. fPort 2 is our app data; anything else is operational chatter
  // (e.g. fPort 224 LoRa Cloud) which we acknowledge but don't store.
  if (fPort !== 2) {
    return new Response(JSON.stringify({ ok: true, skipped: `fPort ${fPort}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const bytes = base64ToBytes(frmPayload);
  const result = decodeUplink(bytes);
  if (!result.ok) {
    return badRequest(`Decode failed: ${result.error}`);
  }
  const d = result.data;

  // 5. Pick the best gateway (highest RSSI) for radio metadata columns.
  const rxs = body.uplink_message?.rx_metadata ?? [];
  const best = rxs.reduce<(typeof rxs)[number] | null>((acc, cur) => {
    if (!cur) return acc;
    if (!acc) return cur;
    return (cur.rssi ?? -999) > (acc.rssi ?? -999) ? cur : acc;
  }, null);

  // 6. Timestamps: prefer the uplink's received_at, fall back to envelope, then now.
  const receivedAtIso =
    body.uplink_message?.received_at ?? body.received_at ?? new Date().toISOString();
  const receivedAtMs = Date.parse(receivedAtIso);

  // 7. Idempotent insert. Duplicate (dev_eui, f_cnt) -> no-op.
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO uplinks (
       dev_eui, f_cnt, received_at,
       latitude, longitude, altitude_m, hdop,
       sats_tracked, sats_in_view, fix_quality, speed_kmh,
       uart_bytes_rx, uart_lines_parsed,
       battery_pct, battery_mv, temp_c, lux_pct, motion,
       rssi, snr, gateway_id,
       raw_json
     ) VALUES (?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?,  ?)`,
  )
    .bind(
      devEui,
      fCnt,
      receivedAtMs,
      d.latitude,
      d.longitude,
      d.altitude_m,
      d.hdop,
      d.sats_tracked,
      d.sats_in_view,
      d.fix_quality,
      d.speed_kmh,
      d.uart_bytes_rx,
      d.uart_lines_parsed,
      d.battery_pct,
      d.battery_mv,
      d.temp_c,
      d.lux_pct,
      d.motion ? 1 : 0,
      best?.rssi ?? null,
      best?.snr ?? null,
      best?.gateway_ids?.gateway_id ?? null,
      JSON.stringify(body),
    )
    .run();

  return new Response(
    JSON.stringify({
      ok: true,
      inserted: insert.meta.changes > 0,
      f_cnt: fCnt,
      warnings: result.warnings,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

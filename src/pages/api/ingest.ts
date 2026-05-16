import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { base64ToBytes, decodeUplink } from '../../lib/decoder';
import { readForwarderConfig, appendForwardLog } from '../../lib/settings';

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
    settings?: {
      data_rate?: {
        lora?: {
          spreading_factor?: number;
        };
      };
    };
    network_ids?: {
      cluster_address?: string;
    };
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

// Per-forward wall-clock cap. Workers free wall budget is ~30 s including
// waitUntil work; TTN Mapper's v3 endpoint occasionally hangs, so bound it.
const FORWARD_TIMEOUT_MS = 25_000;

/**
 * Fire-and-forget POST to the configured forwarder. Records every attempt
 * (success or failure) to forward_log. Must never throw — the ingest path
 * already returned 200 by the time we run.
 */
async function forwardToTtnMapper(
  url: string,
  body: string,
  fCnt: number,
  email: string,
  experiment: string,
  ttsDomain: string,
): Promise<void> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  let status = 0;
  let error: string | null = null;
  // TTN Mapper's TTS v3 integration requires three headers when TTN isn't
  // the direct sender (see ttnmapper/ingress-api tts_handlers.go):
  //   - TTNMAPPERORG-USER:  contributor email; 403 "email address is empty" without
  //   - X-TTS-DOMAIN:       cluster address; 400 "Originating network server header
  //                         not set" without. TTN sets this when forwarding directly;
  //                         we mirror it here from uplink_message.network_ids.cluster_address.
  //   - TTNMAPPERORG-EXPERIMENT: optional. Tags traffic as test data.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (email) headers['TTNMAPPERORG-USER'] = email;
  if (ttsDomain) headers['X-TTS-DOMAIN'] = ttsDomain;
  if (experiment) headers['TTNMAPPERORG-EXPERIMENT'] = experiment;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    status = res.status;
    if (!res.ok) {
      // Capture a snippet of the response body for diagnostics.
      const text = await res.text().catch(() => '');
      error = text ? text.slice(0, 240) : `HTTP ${res.status}`;
    }
  } catch (e) {
    // Distinguish abort/timeout (the common case with TTN Mapper's jammed
    // publish channel) from genuine network errors. Surface 504 in the log
    // so the badge is informative rather than generic.
    if (e instanceof Error && e.name === 'AbortError') {
      status = 504;
      error = `Upstream did not respond within ${FORWARD_TIMEOUT_MS / 1000}s (TTN Mapper queue jammed; known TTS v3 upstream issue)`;
    } else {
      error = e instanceof Error ? e.message : String(e);
    }
  } finally {
    clearTimeout(timer);
  }

  try {
    await appendForwardLog(env.DB, {
      ts: started,
      f_cnt: fCnt,
      target_url: url,
      status,
      duration_ms: Date.now() - started,
      error,
    });
  } catch {
    // Logging failures shouldn't crash anything; swallow.
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
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

  const spreadingFactor = body.uplink_message?.settings?.data_rate?.lora?.spreading_factor ?? null;

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
       rssi, snr, gateway_id, spreading_factor,
       raw_json
     ) VALUES (?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?)`,
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
      spreadingFactor,
      JSON.stringify(body),
    )
    .run();

  const inserted = insert.meta.changes > 0;

  // 8. Optional fan-out to TTN Mapper (or any configured forwarder). Only on
  // first insert — replays would double-feed downstream. Detached via
  // waitUntil so a slow TTN Mapper can never time us out from TTN's side.
  if (inserted) {
    const forwarder = await readForwarderConfig(env.DB);
    if (forwarder.enabled && forwarder.url) {
      const forwardBody = JSON.stringify(body);
      const ttsDomain = body.uplink_message?.network_ids?.cluster_address ?? '';
      locals.cfContext.waitUntil(
        forwardToTtnMapper(
          forwarder.url,
          forwardBody,
          fCnt,
          forwarder.email,
          forwarder.experiment,
          ttsDomain,
        ),
      );
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      inserted,
      f_cnt: fCnt,
      warnings: result.warnings,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

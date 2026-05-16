import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readTtnApiConfig } from '../../lib/settings';
import {
  listGateways,
  refreshGateway,
  refreshAllGateways,
  setManualLocation,
  setHidden,
} from '../../lib/gateways';

export const prerender = false;

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ok(payload: unknown): Response {
  return new Response(JSON.stringify({ ok: true, ...((payload as object) ?? {}) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const GET: APIRoute = async () => {
  const gateways = await listGateways(env.DB);
  return ok({ gateways, count: gateways.length });
};

interface PostBody {
  action?: string;
  gateway_id?: string;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
}

export const POST: APIRoute = async ({ request }) => {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return badRequest('Body is not valid JSON');
  }
  const action = body.action;
  if (!action) return badRequest('Missing action');

  if (action === 'refresh_all') {
    const config = await readTtnApiConfig(env.DB);
    if (!config.apiKey) return badRequest('No TTN API key configured in /settings');
    const results = await refreshAllGateways(env.DB, config.host, config.apiKey);
    return ok({ results });
  }

  // All remaining actions require a gateway_id.
  const id = body.gateway_id;
  if (!id || typeof id !== 'string') return badRequest('Missing gateway_id');

  if (action === 'refresh') {
    const config = await readTtnApiConfig(env.DB);
    if (!config.apiKey) return badRequest('No TTN API key configured in /settings');
    const result = await refreshGateway(env.DB, config.host, config.apiKey, id);
    return ok({ result });
  }

  if (action === 'set_manual_location') {
    const lat = typeof body.latitude === 'number' ? body.latitude : null;
    const lon = typeof body.longitude === 'number' ? body.longitude : null;
    const alt = typeof body.altitude === 'number' ? body.altitude : null;
    // Both lat and lon must be set together (or both cleared).
    if ((lat === null) !== (lon === null)) {
      return badRequest('latitude and longitude must be set together');
    }
    if (lat !== null && (Math.abs(lat) > 90 || Math.abs(lon!) > 180)) {
      return badRequest('latitude/longitude out of range');
    }
    await setManualLocation(env.DB, id, lat, lon, alt);
    return ok({});
  }

  if (action === 'clear_manual_location') {
    await setManualLocation(env.DB, id, null, null, null);
    return ok({});
  }

  if (action === 'hide') {
    await setHidden(env.DB, id, true);
    return ok({});
  }
  if (action === 'unhide') {
    await setHidden(env.DB, id, false);
    return ok({});
  }

  return badRequest(`Unknown action: ${action}`);
};

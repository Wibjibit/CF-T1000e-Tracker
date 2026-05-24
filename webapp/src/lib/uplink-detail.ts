// Per-gateway radio detail for a LoRa uplink.
//
// The `reports` row keeps only the best gateway's RSSI/SNR; the full per-gateway
// fan-out is in the stored TTN ApplicationUp (`uplinks.raw_json` →
// `uplink_message.rx_metadata[]`). The timeline accordion fetches this lazily
// (only when the gateway-detail expander is opened) via /api/uplink-detail.

export interface GatewayRx {
  gateway_id: string;
  rssi: number | null;
  channel_rssi: number | null;
  snr: number | null;
  location: { latitude: number; longitude: number } | null;
  time: string | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Parse a stored TTN ApplicationUp JSON into the per-gateway reception list,
 * strongest RSSI first. Returns [] for anything malformed or location-less —
 * one missing field never throws.
 */
export function parseRxMetadata(rawJson: string | null | undefined): GatewayRx[] {
  if (!rawJson) return [];
  let o: unknown;
  try {
    o = JSON.parse(rawJson);
  } catch {
    return [];
  }
  const rx = (o as { uplink_message?: { rx_metadata?: unknown } })?.uplink_message?.rx_metadata;
  if (!Array.isArray(rx)) return [];

  const out: GatewayRx[] = rx.map((m) => {
    const e = (m ?? {}) as Record<string, unknown>;
    const ids = (e.gateway_ids ?? {}) as Record<string, unknown>;
    const loc = e.location as { latitude?: unknown; longitude?: unknown } | undefined;
    const lat = num(loc?.latitude);
    const lon = num(loc?.longitude);
    return {
      gateway_id: typeof ids.gateway_id === 'string' ? ids.gateway_id : '(unknown)',
      rssi: num(e.rssi),
      channel_rssi: num(e.channel_rssi),
      snr: num(e.snr),
      location: lat != null && lon != null ? { latitude: lat, longitude: lon } : null,
      time: typeof e.time === 'string' ? e.time : null,
    };
  });

  // Strongest first; nulls last.
  out.sort((a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity));
  return out;
}

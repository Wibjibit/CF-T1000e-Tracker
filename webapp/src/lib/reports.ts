// Shared LoRa → `reports` mapping. Both the live ingest dual-write
// (/api/ingest) and the one-shot uplinks backfill (migration 0011) go through
// the SAME slug scheme and the SAME source_metadata shape here, so a row
// written live and a row written by the backfill are byte-for-byte equivalent.
// If you change the device_id slug, the display name, or the metadata keys,
// change 0011_backfill_uplinks.sql to match (it mirrors these in SQL).

import type { Decoded } from './decoder';

/**
 * Deterministic, opaque device slug for a LoRa radio. NOT the DevEUI itself —
 * device identity is decoupled from transport (docs/architecture.md) — but
 * derived from it so live ingest and the SQL backfill independently agree on
 * the same device_id. The SQL side is `'t1000e-' || lower(dev_eui)`.
 */
export function loraDeviceId(devEui: string): string {
  return `t1000e-${devEui.toLowerCase()}`;
}

/** Human label for an auto-created LoRa device. SQL side: `'T1000-E ' || dev_eui`. */
export function loraDisplayName(devEui: string): string {
  return `T1000-E ${devEui.toUpperCase()}`;
}

/** Radio-layer fields pulled from the best (highest-RSSI) TTN gateway. */
export interface LoraRadioMeta {
  rssi: number | null;
  snr: number | null;
  gateway_id: string | null;
  spreading_factor: number | null;
}

/**
 * The LoRa report's source_metadata_json payload. Mirrors the json_object(...)
 * built in 0011_backfill_uplinks.sql — keep the key set in lockstep.
 */
export function loraSourceMetadata(
  d: Decoded,
  radio: LoraRadioMeta,
  fCnt: number,
): Record<string, unknown> {
  return {
    f_cnt: fCnt,
    rssi: radio.rssi,
    snr: radio.snr,
    gateway_id: radio.gateway_id,
    spreading_factor: radio.spreading_factor,
    hdop: d.hdop,
    sats_tracked: d.sats_tracked,
    sats_in_view: d.sats_in_view,
    fix_quality: d.fix_quality,
    speed_kmh: d.speed_kmh,
    battery_pct: d.battery_pct,
    battery_mv: d.battery_mv,
    temp_c: d.temp_c,
    lux_pct: d.lux_pct,
    motion: d.motion,
  };
}

interface SourceRow {
  sourceId: number;
  deviceId: string;
}

const SELECT_LORA_SOURCE =
  `SELECT source_id AS sourceId, device_id AS deviceId
     FROM device_sources
    WHERE source_type = 'lora' AND source_ref = ?`;

/**
 * Get-or-create the device + LoRa device_source for a DevEUI, returning the
 * ids the dual-write needs. Idempotent and concurrency-safe: the INSERT OR
 * IGNOREs lean on devices' PK and device_sources' UNIQUE(device_id,
 * source_type, source_ref), and we re-SELECT afterwards so a racing insert
 * that "won" still yields the right source_id.
 */
export async function ensureLoraSource(
  db: D1Database,
  devEui: string,
  now: number,
): Promise<SourceRow> {
  const eui = devEui.toUpperCase();

  const existing = await db.prepare(SELECT_LORA_SOURCE).bind(eui).first<SourceRow>();
  if (existing) return existing;

  const deviceId = loraDeviceId(eui);
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO devices (device_id, display_name, added_at) VALUES (?, ?, ?)`)
      .bind(deviceId, loraDisplayName(eui), now),
    db
      .prepare(
        `INSERT OR IGNORE INTO device_sources (device_id, source_type, source_ref, enabled, added_at)
         VALUES (?, 'lora', ?, 1, ?)`,
      )
      .bind(deviceId, eui, now),
  ]);

  const row = await db.prepare(SELECT_LORA_SOURCE).bind(eui).first<SourceRow>();
  if (!row) throw new Error(`ensureLoraSource: could not resolve LoRa source for ${eui}`);
  return row;
}

/**
 * Build (but do not run) the `reports` INSERT for one LoRa uplink, so the
 * caller can batch it atomically alongside the `uplinks` INSERT. INSERT OR
 * IGNORE + the UNIQUE(source_id, received_at) index make replays idempotent.
 * accuracy_m is NULL for LoRa (no per-fix accuracy metric; hdop lives in
 * source_metadata_json instead).
 */
export function loraReportInsert(
  db: D1Database,
  p: {
    deviceId: string;
    sourceId: number;
    receivedAt: number;
    decoded: Decoded;
    metadata: Record<string, unknown>;
    rawPayload: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO reports (
         device_id, source_id, source_type, received_at,
         latitude, longitude, altitude_m, accuracy_m,
         source_metadata_json, raw_payload
       ) VALUES (?, ?, 'lora', ?,  ?, ?, ?, NULL,  ?, ?)`,
    )
    .bind(
      p.deviceId,
      p.sourceId,
      p.receivedAt,
      p.decoded.latitude,
      p.decoded.longitude,
      p.decoded.altitude_m,
      JSON.stringify(p.metadata),
      p.rawPayload,
    );
}

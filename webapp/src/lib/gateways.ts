// Gateway cache: one row per gateway_id we've ever heard, populated lazily
// from incoming uplinks (sighting) and from the TTN gateway API (metadata).
//
// Aggregates (uplink counts, RSSI/SNR distribution, first/last seen) are
// computed on-demand from uplinks.raw_json using SQLite's json1 json_each.
// At a few thousand rows this is cheap; if it ever isn't, we can backfill
// into a normalized rx_metadata table without breaking the API shape.

export type GatewayStatus =
  | 'never_refreshed'
  | 'ok'
  | 'no_location'
  | 'not_found'
  | 'error';

/** Staleness threshold for an automatic re-fetch on sighting. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface GatewayRow {
  gateway_id: string;
  name: string | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  latitude_manual: number | null;
  longitude_manual: number | null;
  altitude_manual: number | null;
  hidden: 0 | 1;
  status: GatewayStatus;
  status_error: string | null;
  first_seen_at: number;
  last_refreshed_at: number | null;
  raw_json: string | null;
}

export interface GatewayAggregates {
  /** First time we saw this gateway in any rx_metadata. May predate `first_seen_at` if uplinks were imported. */
  first_seen: number | null;
  last_seen: number | null;
  uplinks_total: number;
  uplinks_24h: number;
  uplinks_7d: number;
  best_rssi: number | null;
  worst_rssi: number | null;
  avg_rssi: number | null;
  best_snr: number | null;
  worst_snr: number | null;
  avg_snr: number | null;
}

export interface GatewayListEntry extends GatewayRow, GatewayAggregates {
  /** Resolved coordinates: manual override wins, else TTN values, else null. */
  effective_latitude: number | null;
  effective_longitude: number | null;
  /** Computed sanity warnings (see SANITY_BADGES). */
  badges: SanityBadge[];
  /** Whether the gateway is currently drawable on /beams. */
  beam_eligible: boolean;
}

export type SanityBadge =
  | 'no_location'
  | 'null_island'
  | 'stale'
  | 'wide_rssi_swing'
  | 'not_found'
  | 'error'
  | 'hidden'
  | 'manual_override'
  | 'never_refreshed';

/** No-uplink-in-this-many-ms => "stale" badge. */
const STALE_UPLINK_MS = 30 * 24 * 60 * 60 * 1000;
/** RSSI swing (best minus worst) above this => "wide_rssi_swing" badge. */
const WIDE_RSSI_SWING_DB = 30;

// ─── TTN gateway API client ─────────────────────────────────────────────────

interface TtnAntennaLocation {
  latitude?: number;
  longitude?: number;
  altitude?: number;
  accuracy?: number;
  source?: string;
}

interface TtnAntenna {
  location?: TtnAntennaLocation;
}

interface TtnGatewayResponse {
  ids?: { gateway_id?: string };
  name?: string;
  description?: string;
  antennas?: TtnAntenna[];
}

export interface FetchResult {
  status: GatewayStatus;
  /** Set when status === 'ok' or 'no_location'. */
  data?: TtnGatewayResponse;
  error?: string;
  /** Raw response body for debugging (kept short for storage). */
  rawJson: string;
}

const TTN_FIELD_MASK = 'ids,name,description,antennas';
const FETCH_TIMEOUT_MS = 10_000;
const RAW_JSON_MAX_BYTES = 4_000;

/**
 * Look up a single gateway via TTN's Identity Server REST API.
 * Returns {status, data?, error?, rawJson} — never throws.
 */
export async function fetchGatewayFromTtn(
  host: string,
  apiKey: string,
  gatewayId: string,
): Promise<FetchResult> {
  if (!apiKey) {
    return { status: 'error', error: 'No TTN API key configured', rawJson: '' };
  }
  // Defensive encode: gateway_ids from TTN are typically "eui-…" or
  // user-chosen slugs (lowercase letters, digits, dashes) but we shouldn't
  // assume.
  const url =
    `https://${host}/api/v3/gateways/${encodeURIComponent(gatewayId)}` +
    `?field_mask=${TTN_FIELD_MASK}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let rawText = '';
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    rawText = await res.text().catch(() => '');
    if (res.status === 404) {
      return { status: 'not_found', rawJson: trimRaw(rawText) };
    }
    if (!res.ok) {
      return {
        status: 'error',
        error: `HTTP ${res.status}: ${rawText.slice(0, 200) || res.statusText}`,
        rawJson: trimRaw(rawText),
      };
    }
    let data: TtnGatewayResponse;
    try {
      data = JSON.parse(rawText) as TtnGatewayResponse;
    } catch (e) {
      return {
        status: 'error',
        error: `Parse error: ${e instanceof Error ? e.message : String(e)}`,
        rawJson: trimRaw(rawText),
      };
    }
    const loc = data.antennas?.[0]?.location;
    if (
      !loc ||
      typeof loc.latitude !== 'number' ||
      typeof loc.longitude !== 'number'
    ) {
      return { status: 'no_location', data, rawJson: trimRaw(rawText) };
    }
    return { status: 'ok', data, rawJson: trimRaw(rawText) };
  } catch (e) {
    const msg =
      e instanceof Error && e.name === 'AbortError'
        ? `Timeout after ${FETCH_TIMEOUT_MS / 1000}s`
        : e instanceof Error
          ? e.message
          : String(e);
    return { status: 'error', error: msg, rawJson: trimRaw(rawText) };
  } finally {
    clearTimeout(timer);
  }
}

function trimRaw(s: string): string {
  return s.length > RAW_JSON_MAX_BYTES ? s.slice(0, RAW_JSON_MAX_BYTES) + '…' : s;
}

// ─── Cache reads / writes ───────────────────────────────────────────────────

/**
 * Insert a "never_refreshed" placeholder for a freshly seen gateway_id.
 * No-op if a row already exists (so we don't clobber refresh state).
 * Returns true if a new row was inserted.
 */
export async function upsertGatewaySighting(
  db: D1Database,
  gatewayId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO gateways (gateway_id, status, first_seen_at)
       VALUES (?, 'never_refreshed', ?)`,
    )
    .bind(gatewayId, now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Apply a fetch result to the gateways row. Always sets last_refreshed_at.
 * On 'ok' / 'no_location' updates name/description/lat/lon/alt from TTN data.
 * On 'not_found' / 'error' leaves the TTN-derived fields alone (we may
 * already have stale-but-useful values) and only updates status + error.
 */
export async function applyFetchResult(
  db: D1Database,
  gatewayId: string,
  result: FetchResult,
  now: number = Date.now(),
): Promise<void> {
  if (result.status === 'ok' || result.status === 'no_location') {
    const d = result.data;
    const name = d?.name ?? null;
    const description = d?.description ?? null;
    const loc = d?.antennas?.[0]?.location;
    const lat = result.status === 'ok' ? loc?.latitude ?? null : null;
    const lon = result.status === 'ok' ? loc?.longitude ?? null : null;
    const alt = result.status === 'ok' ? loc?.altitude ?? null : null;
    await db
      .prepare(
        `UPDATE gateways
            SET name = ?, description = ?,
                latitude = ?, longitude = ?, altitude = ?,
                status = ?, status_error = NULL,
                last_refreshed_at = ?, raw_json = ?
          WHERE gateway_id = ?`,
      )
      .bind(name, description, lat, lon, alt, result.status, now, result.rawJson, gatewayId)
      .run();
    return;
  }
  // not_found / error
  await db
    .prepare(
      `UPDATE gateways
          SET status = ?, status_error = ?,
              last_refreshed_at = ?, raw_json = ?
        WHERE gateway_id = ?`,
    )
    .bind(result.status, result.error ?? null, now, result.rawJson, gatewayId)
    .run();
}

export async function readGatewayRow(
  db: D1Database,
  gatewayId: string,
): Promise<GatewayRow | null> {
  const row = await db
    .prepare(`SELECT * FROM gateways WHERE gateway_id = ?`)
    .bind(gatewayId)
    .first<GatewayRow>();
  return row ?? null;
}

/**
 * Fetch + apply in one shot. Used by the ingest waitUntil and by manual
 * refresh actions. Skips if no API key configured.
 *
 * Ensures a cache row exists before attempting applyFetchResult — that
 * way the per-row Refresh action works on gateways that exist only in
 * historical rx_metadata (no sighting recorded yet because the ingest
 * hook didn't exist when those uplinks landed).
 */
export async function refreshGateway(
  db: D1Database,
  host: string,
  apiKey: string,
  gatewayId: string,
): Promise<FetchResult> {
  await upsertGatewaySighting(db, gatewayId);
  const result = await fetchGatewayFromTtn(host, apiKey, gatewayId);
  await applyFetchResult(db, gatewayId, result);
  return result;
}

/**
 * Returns true if this gateway's metadata is overdue for a refresh:
 * never refreshed at all, or last refresh > STALE_AFTER_MS ago.
 */
export function isStale(row: GatewayRow, now: number = Date.now()): boolean {
  if (row.status === 'never_refreshed') return true;
  if (row.last_refreshed_at == null) return true;
  return now - row.last_refreshed_at > STALE_AFTER_MS;
}

// ─── Aggregates query ───────────────────────────────────────────────────────

/**
 * Single SQL pass that fans rx_metadata out into per-gateway aggregates
 * using JSON1's json_each, then LEFT JOINs the cache for metadata.
 *
 * NOTE: relies on D1's SQLite having the json1 extension compiled in, which
 * Cloudflare D1 has had since launch.
 */
export async function listGateways(
  db: D1Database,
  now: number = Date.now(),
): Promise<GatewayListEntry[]> {
  const since24h = now - 24 * 60 * 60 * 1000;
  const since7d = now - 7 * 24 * 60 * 60 * 1000;

  const sql = `
    WITH sightings AS (
      SELECT
        json_extract(rx.value, '$.gateway_ids.gateway_id') AS gateway_id,
        u.received_at AS received_at,
        CAST(json_extract(rx.value, '$.rssi') AS INTEGER) AS rssi,
        CAST(json_extract(rx.value, '$.snr')  AS REAL)    AS snr
      FROM uplinks u,
           json_each(json_extract(u.raw_json, '$.uplink_message.rx_metadata')) rx
      WHERE json_extract(rx.value, '$.gateway_ids.gateway_id') IS NOT NULL
    ),
    agg AS (
      SELECT
        gateway_id,
        MIN(received_at) AS first_seen,
        MAX(received_at) AS last_seen,
        COUNT(*)         AS uplinks_total,
        SUM(CASE WHEN received_at >= ?1 THEN 1 ELSE 0 END) AS uplinks_24h,
        SUM(CASE WHEN received_at >= ?2 THEN 1 ELSE 0 END) AS uplinks_7d,
        MAX(rssi) AS best_rssi,
        MIN(rssi) AS worst_rssi,
        AVG(rssi) AS avg_rssi,
        MAX(snr)  AS best_snr,
        MIN(snr)  AS worst_snr,
        AVG(snr)  AS avg_snr
      FROM sightings
      GROUP BY gateway_id
    )
    SELECT
      COALESCE(g.gateway_id, agg.gateway_id) AS gateway_id,
      g.name, g.description,
      g.latitude, g.longitude, g.altitude,
      g.latitude_manual, g.longitude_manual, g.altitude_manual,
      COALESCE(g.hidden, 0) AS hidden,
      COALESCE(g.status, 'never_refreshed') AS status,
      g.status_error,
      COALESCE(agg.first_seen, g.first_seen_at) AS first_seen_at,
      g.last_refreshed_at,
      g.raw_json,
      agg.first_seen, agg.last_seen,
      COALESCE(agg.uplinks_total, 0) AS uplinks_total,
      COALESCE(agg.uplinks_24h, 0)   AS uplinks_24h,
      COALESCE(agg.uplinks_7d, 0)    AS uplinks_7d,
      agg.best_rssi, agg.worst_rssi, agg.avg_rssi,
      agg.best_snr,  agg.worst_snr,  agg.avg_snr
    FROM agg
    LEFT JOIN gateways g ON g.gateway_id = agg.gateway_id
    UNION ALL
    -- Gateways that exist in cache but have no current sightings (e.g. user
    -- pre-seeded a manual entry, or all uplinks pruned). Rare for now.
    SELECT
      g.gateway_id,
      g.name, g.description,
      g.latitude, g.longitude, g.altitude,
      g.latitude_manual, g.longitude_manual, g.altitude_manual,
      g.hidden, g.status, g.status_error,
      g.first_seen_at, g.last_refreshed_at, g.raw_json,
      NULL, NULL, 0, 0, 0,
      NULL, NULL, NULL,
      NULL, NULL, NULL
    FROM gateways g
    WHERE g.gateway_id NOT IN (SELECT gateway_id FROM agg)
    ORDER BY last_seen DESC NULLS LAST, gateway_id ASC
  `;

  interface Row extends GatewayRow, GatewayAggregates {}
  const r = await db.prepare(sql).bind(since24h, since7d).all<Row>();
  const rows = r.results ?? [];

  return rows.map((row) => decorate(row, now));
}

function decorate(row: GatewayRow & GatewayAggregates, now: number): GatewayListEntry {
  const effLat = row.latitude_manual ?? row.latitude;
  const effLon = row.longitude_manual ?? row.longitude;
  const badges = computeBadges(row, effLat, effLon, now);
  const beamEligible =
    row.hidden !== 1 &&
    effLat !== null &&
    effLon !== null &&
    !(effLat === 0 && effLon === 0);
  return {
    ...row,
    effective_latitude: effLat,
    effective_longitude: effLon,
    badges,
    beam_eligible: beamEligible,
  };
}

function computeBadges(
  row: GatewayRow & GatewayAggregates,
  effLat: number | null,
  effLon: number | null,
  now: number,
): SanityBadge[] {
  const out: SanityBadge[] = [];
  if (row.hidden === 1) out.push('hidden');
  if (row.status === 'never_refreshed') out.push('never_refreshed');
  if (row.status === 'not_found') out.push('not_found');
  if (row.status === 'error') out.push('error');
  if (row.status === 'no_location' && row.latitude_manual == null) out.push('no_location');
  if (effLat === 0 && effLon === 0) out.push('null_island');
  if (row.latitude_manual != null || row.longitude_manual != null) out.push('manual_override');
  if (row.last_seen != null && now - row.last_seen > STALE_UPLINK_MS) out.push('stale');
  if (
    row.best_rssi != null &&
    row.worst_rssi != null &&
    row.best_rssi - row.worst_rssi > WIDE_RSSI_SWING_DB
  ) {
    out.push('wide_rssi_swing');
  }
  return out;
}

// ─── Mutations from the management page ─────────────────────────────────────

export async function setManualLocation(
  db: D1Database,
  gatewayId: string,
  lat: number | null,
  lon: number | null,
  alt: number | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE gateways
          SET latitude_manual = ?, longitude_manual = ?, altitude_manual = ?
        WHERE gateway_id = ?`,
    )
    .bind(lat, lon, alt, gatewayId)
    .run();
}

export async function setHidden(
  db: D1Database,
  gatewayId: string,
  hidden: boolean,
): Promise<void> {
  await db
    .prepare(`UPDATE gateways SET hidden = ? WHERE gateway_id = ?`)
    .bind(hidden ? 1 : 0, gatewayId)
    .run();
}

/**
 * Refresh every known gateway. "Known" = appears in either the cache
 * table or in any uplink's rx_metadata. The latter source matters on
 * first use: when the user adds an API key for the first time, the
 * cache table is empty but rx_metadata has weeks of history.
 *
 * Sequential to keep things calm (one personal tracker will rarely have
 * more than a handful of gateways). refreshGateway upserts the sighting
 * before fetching, so a fresh cache row is created when needed.
 */
export async function refreshAllGateways(
  db: D1Database,
  host: string,
  apiKey: string,
): Promise<Array<{ gateway_id: string; status: GatewayStatus; error?: string }>> {
  const r = await db
    .prepare(
      `SELECT gateway_id FROM gateways
       UNION
       SELECT DISTINCT json_extract(rx.value, '$.gateway_ids.gateway_id') AS gateway_id
         FROM uplinks u,
              json_each(json_extract(u.raw_json, '$.uplink_message.rx_metadata')) rx
        WHERE json_extract(rx.value, '$.gateway_ids.gateway_id') IS NOT NULL
       ORDER BY gateway_id`,
    )
    .all<{ gateway_id: string }>();
  const ids = (r.results ?? []).map((x) => x.gateway_id);
  const out: Array<{ gateway_id: string; status: GatewayStatus; error?: string }> = [];
  for (const id of ids) {
    const res = await refreshGateway(db, host, apiKey, id);
    out.push({ gateway_id: id, status: res.status, error: res.error });
  }
  return out;
}

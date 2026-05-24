// Generic key/value settings stored in D1. Cheap reads (PK lookup), edited
// from the /settings page so they take effect without redeploying.
//
// New keys: add a constant below + a typed accessor. The migration seeds
// initial values so callers can rely on first() returning a row.

export const FORWARDER_ENABLED_KEY = 'ttnmapper_enabled';
export const FORWARDER_URL_KEY = 'ttnmapper_url';
export const FORWARDER_EMAIL_KEY = 'ttnmapper_email';
export const FORWARDER_EXPERIMENT_KEY = 'ttnmapper_experiment';

export const TTN_API_KEY_KEY = 'ttn_api_key';
export const TTN_NS_HOST_KEY = 'ttn_ns_host';
export const TTN_NS_HOST_DEFAULT = 'eu1.cloud.thethings.network';

export const MAP_APPEARANCE_KEY = 'map_appearance';

export const HOME_LAT_KEY = 'home_lat';
export const HOME_LON_KEY = 'home_lon';

/** The single Home coordinate no-fix Find Hub reports can be pinned to. Both
 *  null when unset (the pinning feature stays dormant). */
export interface HomeLocation {
  lat: number | null;
  lon: number | null;
}

export interface ForwarderConfig {
  enabled: boolean;
  url: string;
  /** Sent as TTNMAPPERORG-USER header. Required by TTN Mapper's TTS v3 endpoint. */
  email: string;
  /** Sent as TTNMAPPERORG-EXPERIMENT header when non-empty. */
  experiment: string;
}

export interface TtnApiConfig {
  /** Bearer token with RIGHT_GATEWAY_INFO. Empty string means "no gateway lookups". */
  apiKey: string;
  /** Network server host, e.g. eu1.cloud.thethings.network. */
  host: string;
}

import { resolveAppearance, type Appearance } from './sources-display';

interface SettingRow { value: string; }

async function readSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<SettingRow>();
  return row?.value ?? null;
}

async function writeSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, Date.now())
    .run();
}

export async function readForwarderConfig(db: D1Database): Promise<ForwarderConfig> {
  const [enabledStr, url, email, experiment] = await Promise.all([
    readSetting(db, FORWARDER_ENABLED_KEY),
    readSetting(db, FORWARDER_URL_KEY),
    readSetting(db, FORWARDER_EMAIL_KEY),
    readSetting(db, FORWARDER_EXPERIMENT_KEY),
  ]);
  return {
    enabled: enabledStr === '1',
    url: url ?? '',
    email: email ?? '',
    experiment: experiment ?? '',
  };
}

export async function writeForwarderConfig(
  db: D1Database,
  config: ForwarderConfig,
): Promise<void> {
  // Independent writes; if any one fails the others still persist. That's
  // the right partial-failure behaviour — a stale email under a disabled
  // toggle is harmless.
  await writeSetting(db, FORWARDER_ENABLED_KEY, config.enabled ? '1' : '0');
  await writeSetting(db, FORWARDER_URL_KEY, config.url);
  await writeSetting(db, FORWARDER_EMAIL_KEY, config.email);
  await writeSetting(db, FORWARDER_EXPERIMENT_KEY, config.experiment);
}

export async function readTtnApiConfig(db: D1Database): Promise<TtnApiConfig> {
  const [apiKey, host] = await Promise.all([
    readSetting(db, TTN_API_KEY_KEY),
    readSetting(db, TTN_NS_HOST_KEY),
  ]);
  return {
    apiKey: apiKey ?? '',
    host: host && host.trim() ? host.trim() : TTN_NS_HOST_DEFAULT,
  };
}

export async function writeTtnApiConfig(
  db: D1Database,
  config: TtnApiConfig,
): Promise<void> {
  await writeSetting(db, TTN_API_KEY_KEY, config.apiKey);
  await writeSetting(db, TTN_NS_HOST_KEY, config.host || TTN_NS_HOST_DEFAULT);
}

/** Read the map colour overrides, resolved against the built-in defaults. */
export async function readMapAppearance(db: D1Database): Promise<Appearance> {
  return resolveAppearance(await readSetting(db, MAP_APPEARANCE_KEY));
}

/** Persist the map colour overrides as a JSON blob. */
export async function writeMapAppearance(db: D1Database, appearance: Appearance): Promise<void> {
  await writeSetting(db, MAP_APPEARANCE_KEY, JSON.stringify(appearance));
}

/** Read the Home coordinate (both null when unset / malformed). */
export async function readHomeLocation(db: D1Database): Promise<HomeLocation> {
  const [latStr, lonStr] = await Promise.all([readSetting(db, HOME_LAT_KEY), readSetting(db, HOME_LON_KEY)]);
  const lat = latStr == null ? NaN : Number(latStr);
  const lon = lonStr == null ? NaN : Number(lonStr);
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return ok ? { lat, lon } : { lat: null, lon: null };
}

/** Persist (or clear, when null) the Home coordinate. */
export async function writeHomeLocation(db: D1Database, lat: number | null, lon: number | null): Promise<void> {
  await writeSetting(db, HOME_LAT_KEY, lat == null ? '' : String(lat));
  await writeSetting(db, HOME_LON_KEY, lon == null ? '' : String(lon));
}

export interface ForwardLogRow {
  id: number;
  ts: number;
  f_cnt: number;
  target_url: string;
  status: number;
  duration_ms: number;
  error: string | null;
}

export async function recentForwardLog(db: D1Database, limit: number = 50): Promise<ForwardLogRow[]> {
  const r = await db.prepare(
    `SELECT id, ts, f_cnt, target_url, status, duration_ms, error
       FROM forward_log
      ORDER BY ts DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<ForwardLogRow>();
  return r.results ?? [];
}

export async function appendForwardLog(
  db: D1Database,
  entry: Omit<ForwardLogRow, 'id'>,
): Promise<void> {
  await db.prepare(
    `INSERT INTO forward_log (ts, f_cnt, target_url, status, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(entry.ts, entry.f_cnt, entry.target_url, entry.status, entry.duration_ms, entry.error)
    .run();
}

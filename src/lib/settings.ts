// Generic key/value settings stored in D1. Cheap reads (PK lookup), edited
// from the /settings page so they take effect without redeploying.
//
// New keys: add a constant below + a typed accessor. The migration seeds
// initial values so callers can rely on first() returning a row.

export const FORWARDER_ENABLED_KEY = 'ttnmapper_enabled';
export const FORWARDER_URL_KEY = 'ttnmapper_url';
export const FORWARDER_EMAIL_KEY = 'ttnmapper_email';
export const FORWARDER_EXPERIMENT_KEY = 'ttnmapper_experiment';

export interface ForwarderConfig {
  enabled: boolean;
  url: string;
  /** Sent as TTNMAPPERORG-USER header. Required by TTN Mapper's TTS v3 endpoint. */
  email: string;
  /** Sent as TTNMAPPERORG-EXPERIMENT header when non-empty. */
  experiment: string;
}

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

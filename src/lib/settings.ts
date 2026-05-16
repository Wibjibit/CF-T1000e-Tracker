// Generic key/value settings stored in D1. Cheap reads (PK lookup), edited
// from the /settings page so they take effect without redeploying.
//
// New keys: add a constant below + a typed accessor. The migration seeds
// initial values so callers can rely on first() returning a row.

export const FORWARDER_ENABLED_KEY = 'ttnmapper_enabled';
export const FORWARDER_URL_KEY = 'ttnmapper_url';

export interface ForwarderConfig {
  enabled: boolean;
  url: string;
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
  const [enabledStr, url] = await Promise.all([
    readSetting(db, FORWARDER_ENABLED_KEY),
    readSetting(db, FORWARDER_URL_KEY),
  ]);
  return {
    enabled: enabledStr === '1',
    url: url ?? '',
  };
}

export async function writeForwarderConfig(
  db: D1Database,
  config: ForwarderConfig,
): Promise<void> {
  // Two writes; not transactional but the keys are independent — if the
  // second fails, the first still persists, which is the right partial-
  // failure behaviour (a stale URL with a disabled toggle is harmless).
  await writeSetting(db, FORWARDER_ENABLED_KEY, config.enabled ? '1' : '0');
  await writeSetting(db, FORWARDER_URL_KEY, config.url);
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

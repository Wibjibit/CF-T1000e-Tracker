// D1 helpers for the Phase 3.3 "Devices & Sources" management UI (/sources).
//
// Mirrors src/lib/settings.ts: each function takes `db: D1Database`, queries
// are typed with `.all<Row>()` / `.first<Row>()`, and the page layer owns all
// request/response handling. NEVER select credentials_nonce or
// credentials_ciphertext — credential material must never reach the page.

import { SOURCE_TYPES, isSourceType, type SourceType } from './sources-display';

// The list of valid source types lives in sources-display.ts (the single
// source of truth, safe for client bundles). Re-export here so existing
// importers of '../lib/sources' keep working. Matches the
// device_sources.source_type CHECK constraint (migration 0009).
export { SOURCE_TYPES, isSourceType, type SourceType };

// ── Accounts ────────────────────────────────────────────────────────────

export interface AccountRow {
  account_id: number;
  provider: string;
  account_label: string;
  key_version: number;
  added_at: number;
  last_refreshed_at: number | null;
  last_error: string | null;
  last_attempt_at: number | null;
  /** How many device_sources reference this account (LEFT JOIN count). */
  source_count: number;
}

export async function listAccounts(db: D1Database): Promise<AccountRow[]> {
  // LEFT JOIN so accounts with zero attached sources still appear (source_count 0).
  // Credential blob columns are deliberately omitted from the SELECT.
  const r = await db
    .prepare(
      `SELECT a.account_id        AS account_id,
              a.provider          AS provider,
              a.account_label     AS account_label,
              a.key_version       AS key_version,
              a.added_at          AS added_at,
              a.last_refreshed_at AS last_refreshed_at,
              a.last_error        AS last_error,
              a.last_attempt_at   AS last_attempt_at,
              COUNT(ds.source_id) AS source_count
         FROM accounts a
         LEFT JOIN device_sources ds ON ds.account_id = a.account_id
        GROUP BY a.account_id
        ORDER BY a.provider, a.account_label`,
    )
    .all<AccountRow>();
  return r.results ?? [];
}

/**
 * Delete an account, but ONLY if no device_sources reference it. Refusing
 * here (rather than relying on the FK, which D1 doesn't enforce by default)
 * gives the page a clear, surfaceable error to toast.
 */
export async function deleteAccount(db: D1Database, accountId: number): Promise<void> {
  const ref = await db
    .prepare(`SELECT COUNT(*) AS n FROM device_sources WHERE account_id = ?`)
    .bind(accountId)
    .first<{ n: number }>();
  const count = ref?.n ?? 0;
  if (count > 0) {
    throw new Error(
      `Cannot delete account: ${count} source${count === 1 ? '' : 's'} still reference it. Delete those sources first.`,
    );
  }
  await db.prepare(`DELETE FROM accounts WHERE account_id = ?`).bind(accountId).run();
}

// ── Devices + their sources ───────────────────────────────────────────────

export interface DeviceSourceRow {
  source_id: number;
  source_type: SourceType;
  source_ref: string;
  account_id: number | null;
  account_label: string | null;
  enabled: number;
  added_at: number;
  last_report_at: number | null;
}

export interface DeviceWithSources {
  device_id: string;
  display_name: string;
  added_at: number;
  sources: DeviceSourceRow[];
}

interface DeviceRow {
  device_id: string;
  display_name: string;
  added_at: number;
}

interface SourceJoinRow extends DeviceSourceRow {
  device_id: string;
}

export async function listDevicesWithSources(db: D1Database): Promise<DeviceWithSources[]> {
  // Two queries + group in JS: keeps each row shape flat and easy to type, and
  // a device with zero sources still shows up (a plain JOIN would drop it).
  const [deviceRes, sourceRes] = await Promise.all([
    db
      .prepare(`SELECT device_id, display_name, added_at FROM devices ORDER BY display_name`)
      .all<DeviceRow>(),
    db
      .prepare(
        `SELECT ds.source_id      AS source_id,
                ds.device_id      AS device_id,
                ds.source_type    AS source_type,
                ds.source_ref     AS source_ref,
                ds.account_id     AS account_id,
                a.account_label   AS account_label,
                ds.enabled        AS enabled,
                ds.added_at       AS added_at,
                ds.last_report_at AS last_report_at
           FROM device_sources ds
           LEFT JOIN accounts a ON a.account_id = ds.account_id
          ORDER BY ds.source_type, ds.source_ref`,
      )
      .all<SourceJoinRow>(),
  ]);

  const byDevice = new Map<string, DeviceSourceRow[]>();
  for (const s of sourceRes.results ?? []) {
    const list = byDevice.get(s.device_id) ?? [];
    list.push({
      source_id: s.source_id,
      source_type: s.source_type,
      source_ref: s.source_ref,
      account_id: s.account_id,
      account_label: s.account_label,
      enabled: s.enabled,
      added_at: s.added_at,
      last_report_at: s.last_report_at,
    });
    byDevice.set(s.device_id, list);
  }

  return (deviceRes.results ?? []).map((d) => ({
    device_id: d.device_id,
    display_name: d.display_name,
    added_at: d.added_at,
    sources: byDevice.get(d.device_id) ?? [],
  }));
}

// ── Mutations ─────────────────────────────────────────────────────────────

export async function setSourceEnabled(
  db: D1Database,
  sourceId: number,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare(`UPDATE device_sources SET enabled = ? WHERE source_id = ?`)
    .bind(enabled ? 1 : 0, sourceId)
    .run();
}

export async function deleteSource(db: D1Database, sourceId: number): Promise<void> {
  await db.prepare(`DELETE FROM device_sources WHERE source_id = ?`).bind(sourceId).run();
}

export async function renameDevice(
  db: D1Database,
  deviceId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Display name cannot be empty.');
  await db
    .prepare(`UPDATE devices SET display_name = ? WHERE device_id = ?`)
    .bind(trimmed, deviceId)
    .run();
}

export async function addDevice(
  db: D1Database,
  deviceId: string,
  displayName: string,
  now: number,
): Promise<void> {
  const id = deviceId.trim();
  const name = displayName.trim();
  if (!id) throw new Error('Device id is required.');
  if (!name) throw new Error('Display name is required.');
  // INSERT OR IGNORE: re-adding an existing device_id is a no-op, not an error.
  await db
    .prepare(`INSERT OR IGNORE INTO devices (device_id, display_name, added_at) VALUES (?, ?, ?)`)
    .bind(id, name, now)
    .run();
}

export interface AddSourceInput {
  deviceId: string;
  sourceType: string;
  sourceRef: string;
  accountId: number | null;
  now: number;
}

export async function addSource(db: D1Database, input: AddSourceInput): Promise<void> {
  const deviceId = input.deviceId.trim();
  const sourceRef = input.sourceRef.trim();

  if (!deviceId) throw new Error('A device must be selected.');
  if (!isSourceType(input.sourceType)) {
    throw new Error(`Unknown source type: ${input.sourceType}`);
  }
  if (!sourceRef) throw new Error('Source ref is required.');

  // lora auth lives in the webhook's Basic-Auth header, so it has no account.
  // The credential-backed providers MUST be tied to an account.
  if (input.sourceType !== 'lora' && input.accountId === null) {
    throw new Error(`Source type "${input.sourceType}" requires an account.`);
  }

  // Upsert on the natural key so re-attaching a source re-points it at the
  // chosen account and re-enables it rather than erroring on the UNIQUE.
  await db
    .prepare(
      `INSERT INTO device_sources (device_id, source_type, source_ref, account_id, enabled, added_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(device_id, source_type, source_ref)
         DO UPDATE SET account_id = excluded.account_id, enabled = 1`,
    )
    .bind(deviceId, input.sourceType, sourceRef, input.accountId, input.now)
    .run();
}

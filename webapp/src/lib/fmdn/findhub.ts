// Pure orchestration for the Find Hub poller. Everything here is side-effect
// free (no socket, no D1, no fetch) so it's exercised in plain Node by
// src/test/fmdn-findhub.test.ts — the DO shell (do/findhub-poller.ts) is thin
// glue that wires these over the spike-proven MCS socket + D1.
//
// Mirrors the desktop app's fcm.rs/api.rs flow: ListDevices → EIK cache; each
// pushed DataMessageStanza → ECE-unwrap → DeviceUpdate → route each report.

import { decodeMessage, getString, getBytes, getMessages } from './protobuf';
import { decryptEik } from './eik';
import { unwrapFcmPayload, type EceKeys } from './ece';
import { parseDeviceUpdate, routeReport, type RoutedReport, type DeviceRegistrationInfo } from './report';

// ---------------------------------------------------------------------------
// Account credentials (the blob the Phase 3.3 bootstrap import must produce)
// ---------------------------------------------------------------------------

/** Decoded Google account credentials — the contract for the `accounts` blob. */
export interface GoogleAccountCreds {
  username: string;
  /** gpsoauth Master/AAS token (the `EncryptedPasswd` for ADM minting). */
  masterToken: string;
  /** E2EE account-wide owner key (decrypts each device's EIK). */
  ownerKey: Uint8Array;
  /** GCM android id / security token (decimal strings) for MCS login. */
  gcmAndroidId: string;
  gcmSecurityToken: string;
  /** FCM registration token — the `gcmRegistrationId` on LocateTracker. */
  fcmToken: string;
  /** ECDH key material for ECE-unwrapping pushes (raw bytes). */
  eceKeys: EceKeys;
}

/**
 * Parse + validate the decrypted account credential JSON. The shape is the
 * canonical one the Phase 3.3 importer writes (keys base64url, owner_key hex,
 * gcm ids decimal strings). Throws a field-named error on anything missing or
 * malformed — far better than a downstream crypto "operation failed".
 */
export function parseGoogleCreds(json: string): GoogleAccountCreds {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error('google creds: not valid JSON');
  }
  const gcm = o.gcm as Record<string, unknown> | undefined;
  const keys = o.keys as Record<string, unknown> | undefined;
  if (!gcm || typeof gcm !== 'object') throw new Error("google creds: missing 'gcm'");
  if (!keys || typeof keys !== 'object') throw new Error("google creds: missing 'keys'");

  return {
    username: reqStr(o, 'username'),
    masterToken: reqStr(o, 'master_token'),
    ownerKey: hexToBytes(reqStr(o, 'owner_key')),
    gcmAndroidId: reqStr(gcm, 'android_id'),
    gcmSecurityToken: reqStr(gcm, 'security_token'),
    fcmToken: reqStr(o, 'fcm_token'),
    eceKeys: {
      publicKey: b64urlToBytes(reqStr(keys, 'public')),
      privateKey: b64urlToBytes(reqStr(keys, 'private')),
      authSecret: b64urlToBytes(reqStr(keys, 'auth_secret')),
    },
  };
}

// ---------------------------------------------------------------------------
// EIK cache
// ---------------------------------------------------------------------------

export interface EikSource {
  canonicId: string;
  registration: DeviceRegistrationInfo;
}

export interface EikCacheResult {
  cache: Map<string, Uint8Array>;
  failures: { canonicId: string; error: string }[];
}

/**
 * Decrypt each device's EIK with the account owner key, returning a
 * canonic_id → EIK map. A device whose EIK won't decrypt (e.g. owner-key
 * version bump) is recorded in `failures` and skipped, never throwing — one
 * bad device must not sink the whole tick.
 */
export function buildEikCache(devices: EikSource[], ownerKey: Uint8Array): EikCacheResult {
  const cache = new Map<string, Uint8Array>();
  const failures: { canonicId: string; error: string }[] = [];
  for (const d of devices) {
    try {
      cache.set(d.canonicId, decryptEik(ownerKey, d.registration.encryptedIdentityKey, d.registration.isMcu));
    } catch (e) {
      failures.push({ canonicId: d.canonicId, error: String(e) });
    }
  }
  return { cache, failures };
}

// ---------------------------------------------------------------------------
// Push parsing
// ---------------------------------------------------------------------------

export interface PushParams {
  persistentId: string;
  dh: Uint8Array;
  salt: Uint8Array;
  rawData: Uint8Array;
}

/** DataMessageStanza fields (mcs.proto): persistentId=9, app_data=7, raw_data=21. */
const STANZA = { PERSISTENT_ID: 9, APP_DATA: 7, RAW_DATA: 21 } as const;

/**
 * Pull the Web Push parameters out of a DataMessageStanza payload: the
 * `crypto-key: dh=…` and `encryption: salt=…` app_data entries (base64url) plus
 * the `raw_data` ciphertext. Returns null if the stanza carries no push payload
 * (e.g. a control message).
 */
export function extractPushParams(stanzaPayload: Uint8Array): PushParams | null {
  const m = decodeMessage(stanzaPayload);
  const rawData = getBytes(m, STANZA.RAW_DATA);
  if (!rawData || rawData.length === 0) return null;

  let dhStr: string | undefined;
  let saltStr: string | undefined;
  for (const entry of getMessages(m, STANZA.APP_DATA)) {
    const key = getString(entry, 1);
    const value = getString(entry, 2);
    if (key === 'crypto-key' && value?.startsWith('dh=')) dhStr = value.slice(3);
    else if (key === 'encryption' && value?.startsWith('salt=')) saltStr = value.slice(5);
  }
  if (!dhStr || !saltStr) return null;

  return {
    persistentId: getString(m, STANZA.PERSISTENT_ID) ?? '',
    dh: b64urlToBytes(dhStr),
    salt: b64urlToBytes(saltStr),
    rawData,
  };
}

export interface ProcessedPush {
  canonicId: string;
  persistentId: string;
  ownerKeyVersion: number;
  reports: RoutedReport[];
  /** Per-report decrypt failures — logged + skipped, not fatal. */
  errors: string[];
}

/**
 * Full read pipeline for one pushed stanza, minus the socket: extract Web Push
 * params → ECE-unwrap to the DeviceUpdate → route every embedded report with
 * the cached EIK. Per-report decrypt failures are collected in `errors` (the
 * poller logs them; Google re-pushes). Returns null when the stanza isn't an
 * actionable DeviceUpdate (control message, non-SPOT, etc.).
 */
export function processPush(
  stanzaPayload: Uint8Array,
  eceKeys: EceKeys,
  eikCache: Map<string, Uint8Array>,
): ProcessedPush | null {
  const params = extractPushParams(stanzaPayload);
  if (!params) return null;

  const payload = unwrapFcmPayload(params.rawData, params.salt, params.dh, eceKeys);
  if (!payload) return null;

  const entry = parseDeviceUpdate(payload);
  if (!entry) return null;

  const eik = eikCache.get(entry.canonicId);
  const reports: RoutedReport[] = [];
  const errors: string[] = [];
  for (const r of entry.reports) {
    try {
      reports.push(routeReport(r, eik, entry.registration.isMcu));
    } catch (e) {
      errors.push(`${entry.canonicId} @${r.receivedAtUnixS}: ${String(e)}`);
    }
  }

  return {
    canonicId: entry.canonicId,
    persistentId: params.persistentId,
    ownerKeyVersion: entry.registration.ownerKeyVersion,
    reports,
    errors,
  };
}

// ---------------------------------------------------------------------------
// reports writer (mirrors lib/reports.ts conventions for the findhub source)
// ---------------------------------------------------------------------------

/** The findhub report's source_metadata_json. */
export function findhubSourceMetadata(
  routed: RoutedReport,
  ownerKeyVersion: number,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    status: routed.status,
    is_own_report: routed.isOwnReport,
    owner_key_version: ownerKeyVersion,
  };
  if (routed.semanticLabel !== null) meta.semantic_label = routed.semanticLabel;
  return meta;
}

/**
 * Build (don't run) the `reports` INSERT for one Find Hub report. INSERT OR
 * IGNORE + the UNIQUE(source_id, received_at) index make redelivered pushes
 * idempotent (the MCS backlog re-sends until acked). Mirrors loraReportInsert.
 */
export function findhubReportInsert(
  db: D1Database,
  p: {
    deviceId: string;
    sourceId: number;
    receivedAt: number; // unix epoch ms
    latitude: number | null;
    longitude: number | null;
    altitudeM: number | null;
    accuracyM: number | null;
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
       ) VALUES (?, ?, 'findhub', ?,  ?, ?, ?, ?,  ?, ?)`,
    )
    .bind(
      p.deviceId,
      p.sourceId,
      p.receivedAt,
      p.latitude,
      p.longitude,
      p.altitudeM,
      p.accuracyM,
      JSON.stringify(p.metadata),
      p.rawPayload,
    );
}

// ---------------------------------------------------------------------------
// Bookkeeping helpers
// ---------------------------------------------------------------------------

/**
 * Merge stored + newly-seen persistentIds, de-duplicated in first-seen order,
 * keeping only the most recent `cap`. Sent on the next MCS login so the server
 * stops redelivering acked pushes (spike finding).
 */
export function mergePersistentIds(stored: string[], incoming: string[], cap: number): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of [...stored, ...incoming]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** Next alarm delay (ms): the requested interval, but never below the floor. */
export function nextAlarmDelay(intervalMs: number, floorMs: number): number {
  return Math.max(intervalMs, floorMs);
}

// ---------------------------------------------------------------------------
// byte helpers
// ---------------------------------------------------------------------------

function reqStr(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`google creds: missing/invalid '${key}'`);
  }
  return v;
}

function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 !== 0) throw new Error('google creds: owner_key has odd-length hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('google creds: owner_key is not valid hex');
    out[i] = byte;
  }
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

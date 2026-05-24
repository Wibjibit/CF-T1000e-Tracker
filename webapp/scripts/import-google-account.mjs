#!/usr/bin/env node
// Phase 3.3 — one-time Google Find Hub account bootstrap importer.
//
// Reads the GoogleFindMyTools secrets.json (produced by its browser OAuth flow,
// which CANNOT run on Workers), reshapes it into the credential blob
// lib/fmdn/findhub.ts `parseGoogleCreds` expects, AES-256-GCM-encrypts that blob
// with BLOB_ENC_KEY (byte-compatible with lib/crypto/blob.ts), and emits an
// idempotent SQL file that upserts:
//   - accounts(provider='google')                         (the encrypted creds)
//   - devices(device_id)                                  (INSERT OR IGNORE)
//   - device_sources(source_type='findhub', source_ref=canonic_id)
// You then apply it with `wrangler d1 execute` (or pass --apply).
//
// The reshape mirrors desktop-app/tools/dump_fcm_for_rust.py: gcm ids stay
// decimal strings, owner_key stays hex, and the FCM ECDH keys are normalised to
// base64url-no-pad — with keys.private decoded from its PKCS#8 DER down to the
// raw 32-byte P-256 scalar (here via node:crypto's JWK export, no extra deps).
//
// Pure helpers (b64/scalar/creds/encrypt/sql) are unit-tested in
// src/test/import-google-account.test.mjs, including a parity check against the
// real parseGoogleCreds and a cross-decrypt against the worker's blob.ts.
//
// Usage:
//   node scripts/import-google-account.mjs --canonic-id <uuid> --device-id <slug> [opts]
//   node scripts/import-google-account.mjs --list-devices [--remote]
// Options:
//   --canonic-id <uuid>  FMDN canonic id of the tracker (the findhub source_ref). Required.
//   --device-id <slug>   Logical device to attach the findhub source to. Required.
//                        Use the EXISTING LoRa device id (e.g. t1000e-<deveui>) so the
//                        map/timeline show both pins on one device. Run --list-devices to see them.
//   --device-name <name> display_name if the device is new (default: "Find Hub <canonic8>").
//   --label <text>       accounts.account_label (default: the username/email from secrets.json).
//   --secrets <path>     secrets.json (default: <repo>/GoogleFindMyTools/Auth/secrets.json).
//   --key <base64>       BLOB_ENC_KEY (default: $BLOB_ENC_KEY, else webapp/.dev.vars).
//   --out <path>         SQL output file (default: scripts/out/import-google-account.sql).
//   --remote             target the REMOTE D1 for --list-devices / --apply (default: local).
//   --list-devices       print existing devices (read-only wrangler query) and exit.
//   --apply              run `wrangler d1 execute tracker [--local|--remote] --file <out>`.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPrivateKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR = resolve(SCRIPT_DIR, '..');
// scripts → webapp → cloudflare-multisource → dual-ble-tracker → SensecapTracker
const DEFAULT_SECRETS = resolve(SCRIPT_DIR, '../../../../GoogleFindMyTools/Auth/secrets.json');
const DEFAULT_OUT = resolve(SCRIPT_DIR, 'out/import-google-account.sql');

// ───────────────────────────────────────────────────────── base64 helpers ──

/** Decode standard OR url-safe base64, with or without padding, to bytes. */
export function b64ToBytes(s) {
  const norm = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode bytes as url-safe base64 with no padding. */
export function bytesToB64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Lowercase hex for a SQLite X'..' blob literal. */
export function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// ───────────────────────────────────────────────────── key normalisation ──

/**
 * Pull the raw 32-byte P-256 private scalar out of a PKCS#8 DER blob and return
 * it base64url-no-pad. node:crypto's JWK export gives `d` as base64url already;
 * we re-pad to a fixed 32 bytes so a scalar with leading zero bytes can't come
 * out short (the Rust/Python sides also fix it to 32).
 */
export function pkcs8ToRawScalarB64Url(pkcs8Bytes) {
  const key = createPrivateKey({ key: Buffer.from(pkcs8Bytes), format: 'der', type: 'pkcs8' });
  const jwk = key.export({ format: 'jwk' });
  if (!jwk || typeof jwk.d !== 'string') throw new Error('keys.private: not an EC private key (no JWK d)');
  const d = b64ToBytes(jwk.d);
  if (d.length > 32) throw new Error(`keys.private: scalar is ${d.length} bytes, expected ≤32`);
  const fixed = new Uint8Array(32);
  fixed.set(d, 32 - d.length); // left-pad
  return bytesToB64Url(fixed);
}

// ──────────────────────────────────────────────────────── creds reshaping ──

/**
 * Reshape a parsed secrets.json into the canonical credential object
 * parseGoogleCreds consumes. Throws field-named errors on anything missing.
 */
export function buildGoogleCreds(secrets) {
  if (!secrets || typeof secrets !== 'object') throw new Error('secrets.json: not an object');
  const fcm = secrets.fcm_credentials;
  if (!fcm || typeof fcm !== 'object') throw new Error('secrets.json: missing fcm_credentials');
  const keys = fcm.keys;
  const gcm = fcm.gcm;
  if (!keys || typeof keys !== 'object') throw new Error('secrets.json: missing fcm_credentials.keys');
  if (!gcm || typeof gcm !== 'object') throw new Error('secrets.json: missing fcm_credentials.gcm');

  const req = (obj, path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (typeof v !== 'string' || v.length === 0) throw new Error(`secrets.json: missing/invalid ${path}`);
    return v;
  };

  return {
    username: req(secrets, 'username'),
    master_token: req(secrets, 'aas_token'),
    owner_key: req(secrets, 'owner_key'), // hex string, as-is
    gcm: {
      android_id: req(fcm, 'gcm.android_id'),
      security_token: req(fcm, 'gcm.security_token'),
    },
    fcm_token: req(fcm, 'fcm.registration.token'),
    keys: {
      public: bytesToB64Url(b64ToBytes(req(fcm, 'keys.public'))), // 65-byte point
      private: pkcs8ToRawScalarB64Url(b64ToBytes(req(fcm, 'keys.private'))), // PKCS#8 → raw scalar
      auth_secret: bytesToB64Url(b64ToBytes(req(fcm, 'keys.secret'))), // 16-byte secret
    },
  };
}

// ───────────────────────────────────────────── encryption (matches blob.ts) ──

/**
 * AES-256-GCM envelope, byte-compatible with src/lib/crypto/blob.ts: import the
 * base64 BLOB_ENC_KEY (must be 32 bytes), fresh 12-byte nonce, ciphertext incl.
 * the appended GCM tag. Returns Uint8Arrays for the two `accounts` BLOB columns.
 */
export async function encryptCredsBlob(plaintext, keyB64) {
  const rawKey = b64ToBytes(keyB64);
  if (rawKey.length !== 32) throw new Error(`BLOB_ENC_KEY must be 32 bytes (base64), got ${rawKey.length}`);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { nonce, ciphertext: new Uint8Array(buf) };
}

// ────────────────────────────────────────────────────────── SQL generation ──

/** SQL single-quoted string literal with embedded quotes doubled. */
function sqlStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Idempotent, re-runnable SQL for `wrangler d1 execute`. The account upsert keys
 * on the 0012 UNIQUE(provider, account_label) so a re-import (e.g. owner_key
 * version bump) refreshes the one row; the device is INSERT OR IGNORE; the
 * findhub source upserts on UNIQUE(device_id, source_type, source_ref).
 */
export function buildImportSql({ label, nonceHex, ciphertextHex, deviceId, deviceName, canonicId, now }) {
  const stamp = new Date(now).toISOString();
  return `-- Generated by scripts/import-google-account.mjs at ${stamp}
-- Google account: ${label}
-- Device: ${deviceId}   findhub source_ref (canonic_id): ${canonicId}
-- Requires migration 0012 (UNIQUE(provider, account_label)) to be applied first.
-- Apply:  wrangler d1 execute tracker --local  --file <this file>
--    or:  wrangler d1 execute tracker --remote --file <this file>

INSERT INTO accounts (provider, account_label, credentials_nonce, credentials_ciphertext, key_version, added_at)
VALUES ('google', ${sqlStr(label)}, X'${nonceHex}', X'${ciphertextHex}', 1, ${now})
ON CONFLICT(provider, account_label) DO UPDATE SET
  credentials_nonce      = excluded.credentials_nonce,
  credentials_ciphertext = excluded.credentials_ciphertext,
  key_version            = excluded.key_version,
  last_error             = NULL;

INSERT OR IGNORE INTO devices (device_id, display_name, added_at)
VALUES (${sqlStr(deviceId)}, ${sqlStr(deviceName)}, ${now});

INSERT INTO device_sources (device_id, source_type, source_ref, account_id, enabled, added_at)
VALUES (
  ${sqlStr(deviceId)}, 'findhub', ${sqlStr(canonicId)},
  (SELECT account_id FROM accounts WHERE provider = 'google' AND account_label = ${sqlStr(label)}),
  1, ${now}
)
ON CONFLICT(device_id, source_type, source_ref) DO UPDATE SET
  account_id = excluded.account_id,
  enabled    = 1;
`;
}

// ─────────────────────────────────────────────────────────────── .dev.vars ──

/** Parse a .dev.vars / dotenv-ish file into a {KEY: value} map (quotes stripped). */
export function parseDevVars(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────── CLI ──

function parseArgs(argv) {
  const args = { remote: false, listDevices: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--canonic-id': args.canonicId = next(); break;
      case '--device-id': args.deviceId = next(); break;
      case '--device-name': args.deviceName = next(); break;
      case '--label': args.label = next(); break;
      case '--secrets': args.secrets = next(); break;
      case '--key': args.key = next(); break;
      case '--out': args.out = next(); break;
      case '--remote': args.remote = true; break;
      case '--local': args.remote = false; break; // default; accepted for clarity
      case '--list-devices': args.listDevices = true; break;
      case '--apply': args.apply = true; break;
      case '-h': case '--help': args.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function resolveKey(args) {
  if (args.key) return { key: args.key, source: '--key' };
  if (process.env.BLOB_ENC_KEY) return { key: process.env.BLOB_ENC_KEY, source: '$BLOB_ENC_KEY' };
  const devVars = resolve(WEBAPP_DIR, '.dev.vars');
  if (existsSync(devVars)) {
    const v = parseDevVars(readFileSync(devVars, 'utf8')).BLOB_ENC_KEY;
    if (v) return { key: v, source: '.dev.vars' };
  }
  throw new Error('no BLOB_ENC_KEY: pass --key, set $BLOB_ENC_KEY, or add it to webapp/.dev.vars');
}

function wrangler(wargs) {
  // Invoke wrangler's JS entry with the current node binary. Avoids the npx /
  // .cmd shim entirely (modern Node refuses to execFile a .cmd without a shell,
  // and shell quoting of file paths is fragile) and resolves the local wrangler.
  const wranglerBin = resolve(WEBAPP_DIR, 'node_modules/wrangler/bin/wrangler.js');
  if (!existsSync(wranglerBin)) throw new Error(`wrangler not found at ${wranglerBin} — run npm install, or apply the SQL manually`);
  return execFileSync(process.execPath, [wranglerBin, ...wargs], {
    cwd: WEBAPP_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function listDevices(remote) {
  const loc = remote ? '--remote' : '--local';
  const out = wrangler(['d1', 'execute', 'tracker', loc, '--json', '--command', 'SELECT device_id, display_name FROM devices ORDER BY added_at']);
  let rows = [];
  try {
    const parsed = JSON.parse(out);
    rows = (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? [];
  } catch {
    console.log(out);
    return;
  }
  if (rows.length === 0) {
    console.log(`(no devices in ${loc} D1 yet)`);
    return;
  }
  console.log(`Devices in ${loc} D1:`);
  for (const r of rows) console.log(`  ${r.device_id}   ${r.display_name ?? ''}`);
}

const HELP = `import-google-account.mjs — bootstrap a Google Find Hub account into D1.
See the header of this file for the full option list.
  node scripts/import-google-account.mjs --list-devices [--remote]
  node scripts/import-google-account.mjs --canonic-id <uuid> --device-id <slug> [--apply [--remote]]`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  if (args.listDevices) { listDevices(args.remote); return; }

  if (!args.canonicId) throw new Error('--canonic-id is required (the FMDN canonic id = the findhub source_ref)');
  if (!args.deviceId) {
    throw new Error('--device-id is required. Run with --list-devices to see existing devices; pass the LoRa device id (t1000e-<deveui>) to co-locate both pins on one device.');
  }

  const secretsPath = args.secrets ? resolve(args.secrets) : DEFAULT_SECRETS;
  if (!existsSync(secretsPath)) throw new Error(`secrets.json not found at ${secretsPath} (pass --secrets)`);
  const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));

  const creds = buildGoogleCreds(secrets);
  const label = args.label ?? creds.username;
  const deviceName = args.deviceName ?? `Find Hub ${args.canonicId.slice(0, 8)}`;

  const { key, source: keySource } = resolveKey(args);
  const { nonce, ciphertext } = await encryptCredsBlob(JSON.stringify(creds), key);

  const sql = buildImportSql({
    label,
    nonceHex: toHex(nonce),
    ciphertextHex: toHex(ciphertext),
    deviceId: args.deviceId,
    deviceName,
    canonicId: args.canonicId,
    now: Date.now(),
  });

  const outPath = args.out ? resolve(args.out) : DEFAULT_OUT;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, sql);

  // Never print the creds or the key — only what was read and where it landed.
  console.log(`Read secrets:   ${secretsPath}`);
  console.log(`BLOB_ENC_KEY:   from ${keySource}`);
  console.log(`Account label:  ${label}`);
  console.log(`Device:         ${args.deviceId}  (${deviceName})`);
  console.log(`findhub source_ref (canonic id): ${args.canonicId}`);
  console.log(`Wrote SQL:      ${outPath}`);

  if (args.apply) {
    const loc = args.remote ? '--remote' : '--local';
    console.log(`\nApplying to ${loc} D1 …`);
    wrangler(['d1', 'execute', 'tracker', loc, '--file', outPath]);
    console.log('Applied.');
  } else {
    const loc = args.remote ? '--remote' : '--local';
    console.log(`\nNext: wrangler d1 execute tracker ${loc} --file ${outPath}`);
    console.log('(ensure migration 0012 is applied first; re-running this SQL is idempotent)');
  }
}

// Run only as a CLI; importing the module (tests) must not execute main().
// pathToFileURL handles Windows drive paths so this matches under `node x.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`error: ${e.message ?? e}`);
    process.exit(1);
  });
}

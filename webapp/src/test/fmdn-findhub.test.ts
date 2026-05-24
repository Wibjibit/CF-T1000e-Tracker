// TDD (red→green) for the pure poller orchestration in lib/fmdn/findhub.ts.
// Written BEFORE the module exists. The DO shell (do/findhub-poller.ts) is thin
// glue over these functions + the spike-proven socket; everything with logic
// worth testing lives here and is exercised in plain Node.

import { describe, it, expect } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { PbWriter } from '../lib/fmdn/protobuf';
import { STATUS } from '../lib/fmdn/report';
import {
  parseGoogleCreds,
  buildEikCache,
  extractPushParams,
  processPush,
  findhubSourceMetadata,
  findhubReportInsert,
  mergePersistentIds,
  nextAlarmDelay,
} from '../lib/fmdn/findhub';

// ----- helpers -------------------------------------------------------------

const enc = new TextEncoder();

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function b64std(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function b64url(b: Uint8Array): string {
  return b64std(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function cat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** AES-GCM encrypt into IV||ct||tag (the own-report / EIK layout). */
function gcmSeal(key: Uint8Array, iv: Uint8Array, plain: Uint8Array): Uint8Array {
  return cat(iv, gcm(key, iv).encrypt(plain));
}

/** Encrypt a payload as an application server would (Web Push aesgcm). */
function eceSeal(plaintext: Uint8Array, recipientPub: Uint8Array, authSecret: Uint8Array) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const asPriv = p256.utils.randomSecretKey();
  const dh = p256.getPublicKey(asPriv, false);
  const ecdh = p256.getSharedSecret(asPriv, recipientPub).subarray(1, 33);
  const lp = (k: Uint8Array) => cat(new Uint8Array([(k.length >> 8) & 0xff, k.length & 0xff]), k);
  const secret = hkdf(sha256, ecdh, authSecret, enc.encode('Content-Encoding: auth\0'), 32);
  const ctx = cat(enc.encode('P-256'), new Uint8Array([0]), lp(recipientPub), lp(dh));
  const cek = hkdf(sha256, secret, salt, cat(enc.encode('Content-Encoding: aesgcm\0'), ctx), 16);
  const nonce = hkdf(sha256, secret, salt, cat(enc.encode('Content-Encoding: nonce\0'), ctx), 12);
  const rawData = gcm(cek, nonce).encrypt(cat(new Uint8Array([0, 0]), plaintext));
  return { rawData, dh, salt };
}

/** Build a DataMessageStanza carrying a Web Push payload. */
function buildStanza(persistentId: string, dh: Uint8Array, salt: Uint8Array, rawData: Uint8Array): Uint8Array {
  const appEntry = (k: string, v: string) => new PbWriter().string(1, k).string(2, v).finish();
  return new PbWriter()
    .string(9, persistentId)
    .message(7, appEntry('crypto-key', `dh=${b64url(dh)}`))
    .message(7, appEntry('encryption', `salt=${b64url(salt)}`))
    .message(7, appEntry('subtype', '1:289722593072:android:3cfcf5bc359f0308'))
    .bytesField(21, rawData)
    .finish();
}

/** Minimal DeviceUpdate: one own-report (encrypted under SHA256(eik)) + one semantic. */
function buildDeviceUpdate(canonicId: string, eik: Uint8Array): Uint8Array {
  const cid = new PbWriter().string(1, canonicId).finish();
  const cids = new PbWriter().message(1, cid).finish();
  const idInfo = new PbWriter().int(2, 2).message(3, cids).finish();

  const eus = new PbWriter().bytesField(1, new Uint8Array(60).fill(1)).int(3, 1).finish();
  const reg = new PbWriter().message(19, eus).string(21, '003200').finish();

  // own-report
  const loc = new PbWriter().fixed32(1, 377_749_000).fixed32(2, -1_224_194_000).int(3, 15).finish();
  const sealed = gcmSeal(sha256(eik), new Uint8Array(12).fill(7), loc);
  const er = new PbWriter().bytesField(2, sealed).bool(3, true).finish(); // no publicKeyRandom → own
  const geo = new PbWriter().message(1, er).int(2, 0).finish();
  const ownLoc = new PbWriter().message(10, geo).int(11, STATUS.LAST_KNOWN).finish();
  const ownTime = new PbWriter().int(1, 1_700_000_500).finish();

  // semantic
  const sem = new PbWriter().string(1, 'Home').finish();
  const semLoc = new PbWriter().message(5, sem).int(11, STATUS.SEMANTIC).finish();
  const semTime = new PbWriter().int(1, 1_700_000_000).finish();

  const ranl = new PbWriter()
    .message(1, ownLoc) // recentLocation = own
    .message(2, ownTime)
    .message(5, semLoc) // networkLocations[0] = semantic
    .message(6, semTime)
    .finish();
  const reports = new PbWriter().message(4, ranl).finish();
  const locInfo = new PbWriter().message(3, reports).finish();
  const info = new PbWriter().message(1, reg).message(2, locInfo).finish();
  const md = new PbWriter().message(1, idInfo).message(4, info).string(5, 'Tag').finish();
  return new PbWriter().message(3, md).finish();
}

function validCredsJson(ownerKeyHex: string): string {
  return JSON.stringify({
    username: 'user@gmail.com',
    master_token: 'aas_et/MASTER',
    owner_key: ownerKeyHex,
    gcm: { android_id: '1234567890', security_token: '9876543210' },
    fcm_token: 'fcm-token-abc',
    keys: {
      public: b64url(p256.getPublicKey(p256.utils.randomSecretKey(), false)),
      private: b64url(new Uint8Array(32).fill(9)),
      auth_secret: b64url(new Uint8Array(16).fill(3)),
    },
  });
}

// ----- parseGoogleCreds ----------------------------------------------------

describe('parseGoogleCreds', () => {
  it('decodes a full credential blob', () => {
    const creds = parseGoogleCreds(validCredsJson('00112233445566778899aabbccddeeff'));
    expect(creds.username).toBe('user@gmail.com');
    expect(creds.masterToken).toBe('aas_et/MASTER');
    expect(creds.gcmAndroidId).toBe('1234567890');
    expect(creds.gcmSecurityToken).toBe('9876543210');
    expect(creds.fcmToken).toBe('fcm-token-abc');
    expect(creds.ownerKey.length).toBe(16);
    expect(creds.eceKeys.privateKey.length).toBe(32);
    expect(creds.eceKeys.publicKey.length).toBe(65);
    expect(creds.eceKeys.authSecret.length).toBe(16);
  });
  it('throws on a missing field', () => {
    const bad = JSON.parse(validCredsJson('00112233445566778899aabbccddeeff'));
    delete bad.owner_key;
    expect(() => parseGoogleCreds(JSON.stringify(bad))).toThrow(/owner_key/);
  });
  it('throws on invalid owner_key hex', () => {
    expect(() => parseGoogleCreds(validCredsJson('zz'))).toThrow();
  });
});

// ----- buildEikCache -------------------------------------------------------

describe('buildEikCache', () => {
  it('decrypts good EIKs and records failures', () => {
    const ownerKey = new Uint8Array(16).fill(0xab);
    const eik = new Uint8Array(32).fill(0x42);
    // MCU device stores flip_bits(gcm-sealed EIK).
    const sealed = gcmSeal(ownerKey, new Uint8Array(12).fill(1), eik);
    const flipped = sealed.map((b) => b ^ 0xff);

    const devices = [
      { canonicId: 'good', registration: { encryptedIdentityKey: flipped, ownerKeyVersion: 1, isMcu: true } },
      { canonicId: 'bad', registration: { encryptedIdentityKey: new Uint8Array(60).fill(5), ownerKeyVersion: 1, isMcu: true } },
    ];
    const { cache, failures } = buildEikCache(devices, ownerKey);
    expect(cache.size).toBe(1);
    expect(toHex(cache.get('good')!)).toBe(toHex(eik));
    expect(failures.map((f) => f.canonicId)).toEqual(['bad']);
  });
});

// ----- extractPushParams ---------------------------------------------------

describe('extractPushParams', () => {
  it('pulls dh, salt, raw_data, persistentId from a DataMessageStanza', () => {
    const dh = crypto.getRandomValues(new Uint8Array(65));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const raw = crypto.getRandomValues(new Uint8Array(40));
    const params = extractPushParams(buildStanza('pid-7', dh, salt, raw));
    expect(params).not.toBeNull();
    expect(params!.persistentId).toBe('pid-7');
    expect(toHex(params!.dh)).toBe(toHex(dh));
    expect(toHex(params!.salt)).toBe(toHex(salt));
    expect(toHex(params!.rawData)).toBe(toHex(raw));
  });
  it('returns null when the stanza carries no push payload', () => {
    const stanza = new PbWriter().string(9, 'pid').finish(); // no app_data / raw_data
    expect(extractPushParams(stanza)).toBeNull();
  });
});

// ----- processPush (full read pipeline minus the socket) -------------------

describe('processPush', () => {
  it('ECE-unwraps → parses DeviceUpdate → routes both reports', () => {
    const eceKeys = {
      privateKey: p256.utils.randomSecretKey(),
      publicKey: new Uint8Array(0),
      authSecret: crypto.getRandomValues(new Uint8Array(16)),
    };
    eceKeys.publicKey = p256.getPublicKey(eceKeys.privateKey, false);

    const eik = new Uint8Array(32).fill(0x37);
    const canonicId = 'dev-X';
    const deviceUpdate = buildDeviceUpdate(canonicId, eik);
    const envelope = enc.encode(
      JSON.stringify({ data: { 'com.google.android.apps.adm.FCM_PAYLOAD': b64std(deviceUpdate) } }),
    );
    const { rawData, dh, salt } = eceSeal(envelope, eceKeys.publicKey, eceKeys.authSecret);
    const stanza = buildStanza('pid-1', dh, salt, rawData);

    const cache = new Map([[canonicId, eik]]);
    const result = processPush(stanza, eceKeys, cache);
    expect(result).not.toBeNull();
    expect(result!.canonicId).toBe(canonicId);
    expect(result!.persistentId).toBe('pid-1');
    expect(result!.reports).toHaveLength(2);

    const own = result!.reports.find((r) => r.latitude !== null)!;
    expect(own.latitude).toBeCloseTo(37.7749, 9);
    expect(own.longitude).toBeCloseTo(-122.4194, 9);
    const semantic = result!.reports.find((r) => r.semanticLabel !== null)!;
    expect(semantic.semanticLabel).toBe('Home');
  });

  it('returns null for a control message with no FCM_PAYLOAD', () => {
    const eceKeys = {
      privateKey: p256.utils.randomSecretKey(),
      publicKey: new Uint8Array(0),
      authSecret: crypto.getRandomValues(new Uint8Array(16)),
    };
    eceKeys.publicKey = p256.getPublicKey(eceKeys.privateKey, false);
    const envelope = enc.encode(JSON.stringify({ data: { message_type: 'deleted_messages' } }));
    const { rawData, dh, salt } = eceSeal(envelope, eceKeys.publicKey, eceKeys.authSecret);
    expect(processPush(buildStanza('pid', dh, salt, rawData), eceKeys, new Map())).toBeNull();
  });
});

// ----- writer helpers ------------------------------------------------------

describe('findhubSourceMetadata', () => {
  it('captures status, ownership, owner-key version and any semantic label', () => {
    const meta = findhubSourceMetadata(
      { status: STATUS.SEMANTIC, isOwnReport: true, semanticLabel: 'Home', latitude: null, longitude: null, altitudeM: null, accuracyM: null, receivedAtUnixS: 1 },
      2,
    );
    expect(meta).toMatchObject({ status: STATUS.SEMANTIC, is_own_report: true, owner_key_version: 2, semantic_label: 'Home' });
  });
});

describe('findhubReportInsert', () => {
  it('builds an INSERT OR IGNORE for the findhub source with ordered binds', () => {
    let captured: { sql: string; args: unknown[] } | null = null;
    const db = {
      prepare(sql: string) {
        return { bind: (...args: unknown[]) => ((captured = { sql, args }), captured) };
      },
    } as unknown as D1Database;

    findhubReportInsert(db, {
      deviceId: 'fmdn-dev-X',
      sourceId: 5,
      receivedAt: 1_700_000_500_000,
      latitude: 37.7749,
      longitude: -122.4194,
      altitudeM: 15,
      accuracyM: 12,
      metadata: { status: 1, is_own_report: true, owner_key_version: 1 },
      rawPayload: '{}',
    });
    expect(captured!.sql).toMatch(/INSERT OR IGNORE INTO reports/);
    expect(captured!.sql).toMatch(/'findhub'/);
    expect(captured!.args.slice(0, 4)).toEqual(['fmdn-dev-X', 5, 1_700_000_500_000, 37.7749]);
  });
});

describe('mergePersistentIds', () => {
  it('dedups while preserving order', () => {
    expect(mergePersistentIds(['a', 'b'], ['b', 'c'], 10)).toEqual(['a', 'b', 'c']);
  });
  it('caps to the most recent N', () => {
    expect(mergePersistentIds(['a', 'b', 'c'], ['d'], 2)).toEqual(['c', 'd']);
  });
});

describe('nextAlarmDelay', () => {
  it('honours the interval above the floor', () => {
    expect(nextAlarmDelay(600_000, 60_000)).toBe(600_000);
  });
  it('never schedules sooner than the floor', () => {
    expect(nextAlarmDelay(10_000, 60_000)).toBe(60_000);
  });
});

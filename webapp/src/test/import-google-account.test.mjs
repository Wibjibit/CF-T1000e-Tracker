// Phase 3.3 — bootstrap importer parity tests.
//
// Written test-first (red→green) per the master-plan directive. This is a
// plain .mjs test (not .ts) so the importer CLI it exercises
// (scripts/import-google-account.mjs) stays a runnable node script and never
// enters the tsc program — keeping `npm run check` clean. Vitest transpiles the
// imported .ts modules (parseGoogleCreds, blob) on the fly.
//
// The contract these tests lock down:
//   1. buildGoogleCreds(secrets) emits exactly the JSON shape parseGoogleCreds
//      accepts — change the importer or the parser and one of these breaks.
//   2. encryptCredsBlob() is byte-compatible with lib/crypto/blob.ts decrypt()
//      (the importer reimplements the tiny AES-GCM envelope so it can run under
//      node; this test guarantees it can never drift from the worker's chokepoint).
//   3. The generated SQL is idempotent-shaped and SQL-injection-safe on labels.

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import {
  b64ToBytes,
  bytesToB64Url,
  pkcs8ToRawScalarB64Url,
  buildGoogleCreds,
  encryptCredsBlob,
  toHex,
  buildImportSql,
  parseDevVars,
} from '../../scripts/import-google-account.mjs';
import { parseGoogleCreds } from '../lib/fmdn/findhub';
import { decrypt } from '../lib/crypto/blob';

/** Build a realistic secrets.json object backed by a freshly generated P-256 key. */
function makeFakeSecrets() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  // Python firebase-messaging stores keys.private as standard-b64 of PKCS#8 DER.
  const pkcs8B64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  // keys.public is standard-b64 of the 65-byte uncompressed point (0x04||X||Y).
  const rawPub = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  // Pull the trailing 65 bytes (the EC point) out of the SPKI DER.
  const pubPoint = rawPub.subarray(rawPub.length - 65);
  expect(pubPoint[0]).toBe(0x04);
  const jwk = privateKey.export({ format: 'jwk' });

  return {
    secrets: {
      username: 'badger@gmail.com',
      aas_token: 'aas_et/AKpThisIsAFakeMasterToken==',
      owner_key: '186f35ff03054e812d791e028323d3c1550d0a64dc80a70768d405f18f1d9537',
      shared_key: 'deadbeef',
      fcm_credentials: {
        keys: {
          public: pubPoint.toString('base64'),
          private: pkcs8B64,
          secret: Buffer.from('0123456789abcdef').toString('base64'), // 16-byte auth secret
        },
        gcm: {
          android_id: '5501591180135802741',
          security_token: '657520223166464948',
          token: 'ebERMdx-8Eo:APA91bGsilK4',
        },
        fcm: {
          registration: { token: 'dzRcUIkXRQWJn9kyCBbycu:APA91bGEtE-iSfCeRPTo' },
        },
      },
    },
    expected: {
      jwkD: jwk.d, // base64url-no-pad raw scalar, the source of truth
      pubPoint: new Uint8Array(pubPoint),
      authSecret: new Uint8Array(Buffer.from('0123456789abcdef')),
    },
  };
}

describe('base64 helpers', () => {
  it('b64ToBytes decodes standard and url-safe, padded or not', () => {
    const std = b64ToBytes('YWJjZA=='); // "abcd"
    const url = b64ToBytes('YWJjZA'); // no padding
    expect(Buffer.from(std).toString()).toBe('abcd');
    expect(Buffer.from(url).toString()).toBe('abcd');
    // url-safe alphabet (- and _) decodes too.
    const bytes = b64ToBytes('-_8'); // 0xfb 0xff
    expect([...bytes]).toEqual([0xfb, 0xff]);
  });

  it('bytesToB64Url is url-safe with no padding and round-trips', () => {
    const b = new Uint8Array([0xfb, 0xff, 0x00, 0x10]);
    const s = bytesToB64Url(b);
    expect(s).not.toMatch(/[+/=]/);
    expect([...b64ToBytes(s)]).toEqual([...b]);
  });
});

describe('pkcs8ToRawScalarB64Url', () => {
  it('extracts the raw 32-byte P-256 scalar matching the JWK d', () => {
    const { secrets, expected } = makeFakeSecrets();
    const pkcs8 = b64ToBytes(secrets.fcm_credentials.keys.private);
    const scalarB64 = pkcs8ToRawScalarB64Url(pkcs8);
    expect(scalarB64).toBe(expected.jwkD);
    expect(b64ToBytes(scalarB64).length).toBe(32);
  });
});

describe('buildGoogleCreds → parseGoogleCreds parity', () => {
  it('produces JSON the real parser accepts, with correct decodings', () => {
    const { secrets, expected } = makeFakeSecrets();
    const creds = buildGoogleCreds(secrets);

    // Shape the importer must emit.
    expect(creds.username).toBe('badger@gmail.com');
    expect(creds.master_token).toBe(secrets.aas_token);
    expect(creds.owner_key).toBe(secrets.owner_key);
    expect(creds.gcm.android_id).toBe('5501591180135802741');
    expect(creds.gcm.security_token).toBe('657520223166464948');
    expect(creds.fcm_token).toBe('dzRcUIkXRQWJn9kyCBbycu:APA91bGEtE-iSfCeRPTo');
    expect(creds.keys.auth_secret).toBeTruthy();

    // The actual consumer parses it without throwing and recovers the bytes.
    const parsed = parseGoogleCreds(JSON.stringify(creds));
    expect(parsed.username).toBe('badger@gmail.com');
    expect(parsed.masterToken).toBe(secrets.aas_token);
    expect(parsed.gcmAndroidId).toBe('5501591180135802741');
    expect(parsed.fcmToken).toBe('dzRcUIkXRQWJn9kyCBbycu:APA91bGEtE-iSfCeRPTo');
    // owner_key hex → 32 bytes.
    expect(parsed.ownerKey.length).toBe(32);
    // ECE keys decode to the right raw material.
    expect([...parsed.eceKeys.publicKey]).toEqual([...expected.pubPoint]);
    expect(parsed.eceKeys.publicKey.length).toBe(65);
    expect(parsed.eceKeys.privateKey.length).toBe(32);
    expect([...parsed.eceKeys.authSecret]).toEqual([...expected.authSecret]);
  });

  it('throws a clear error when fcm_credentials is missing', () => {
    expect(() => buildGoogleCreds({ username: 'x', aas_token: 'y', owner_key: 'aa' })).toThrow(
      /fcm_credentials/,
    );
  });
});

describe('encryptCredsBlob ↔ blob.ts decrypt interop', () => {
  it('a blob the importer seals is decryptable by the worker chokepoint', async () => {
    // 32 random bytes, base64 — the BLOB_ENC_KEY format.
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const plaintext = JSON.stringify({ hello: 'wörld', n: 42 });

    const { nonce, ciphertext } = await encryptCredsBlob(plaintext, key);
    expect(nonce.length).toBe(12);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length); // + GCM tag

    const back = await decrypt(
      { credentials_nonce: nonce, credentials_ciphertext: ciphertext },
      { BLOB_ENC_KEY: key },
    );
    expect(back).toBe(plaintext);
  });

  it('a wrong key fails to decrypt (AEAD integrity)', async () => {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const { nonce, ciphertext } = await encryptCredsBlob('secret', key);
    await expect(
      decrypt({ credentials_nonce: nonce, credentials_ciphertext: ciphertext }, { BLOB_ENC_KEY: other }),
    ).rejects.toThrow();
  });
});

describe('SQL generation', () => {
  it('toHex emits lowercase hex for a blob literal', () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff, 0xa0]))).toBe('000fffa0');
  });

  it('buildImportSql is idempotent-shaped and escapes single quotes', () => {
    const sql = buildImportSql({
      label: "o'brien@gmail.com",
      nonceHex: 'aabb',
      ciphertextHex: 'ccdd',
      deviceId: 't1000e-70b3d57ed00778af',
      deviceName: "Sean's T1000-E",
      canonicId: '6a07f1d0-1111-2222-3333-444455556666',
      now: 1716500000000,
    });
    // Upserts (re-runnable) rather than blind inserts.
    expect(sql).toMatch(/ON CONFLICT\(provider, account_label\) DO UPDATE/);
    expect(sql).toMatch(/INSERT OR IGNORE INTO devices/);
    expect(sql).toMatch(/ON CONFLICT\(device_id, source_type, source_ref\) DO UPDATE/);
    // Blob literals.
    expect(sql).toMatch(/X'aabb'/);
    expect(sql).toMatch(/X'ccdd'/);
    // findhub source_ref is the canonic id.
    expect(sql).toMatch(/'6a07f1d0-1111-2222-3333-444455556666'/);
    // Single quotes doubled, not left to break out of the literal.
    expect(sql).toMatch(/'o''brien@gmail\.com'/);
    expect(sql).toMatch(/'Sean''s T1000-E'/);
  });
});

describe('parseDevVars', () => {
  it('reads a KEY=VALUE line, ignoring comments and quotes', () => {
    const text = '# comment\nBLOB_ENC_KEY="abc123=="\nOTHER=zzz\n';
    expect(parseDevVars(text).BLOB_ENC_KEY).toBe('abc123==');
    expect(parseDevVars(text).OTHER).toBe('zzz');
  });
});

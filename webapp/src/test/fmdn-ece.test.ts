// Web Push "aesgcm" ECE round-trip.
//
// There's no Rust vector for ECE (the desktop app gets it from the
// fcm-push-listener crate), so this proves the decryptor against an INDEPENDENT
// encryptor written here straight from the draft-ietf-webpush-encryption-04 /
// http_ece "aesgcm" spec — not by calling the decryptor's internals. The true
// end-to-end confirmation is a live push in Phase 3.2; this guards the math and
// the padding/ECDH/HKDF wiring.

import { describe, it, expect } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decryptEce, unwrapFcmPayload, type EceKeys } from '../lib/fmdn/ece';

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function lp(key: Uint8Array): Uint8Array {
  return concat(new Uint8Array([(key.length >> 8) & 0xff, key.length & 0xff]), key);
}

/** Encrypt a payload the way an application server (Google) would — the mirror
 *  image of decryptEce, derived independently from the spec. */
function encryptEce(
  plaintext: Uint8Array,
  salt: Uint8Array,
  recipientPub: Uint8Array,
  authSecret: Uint8Array,
): { rawData: Uint8Array; dh: Uint8Array } {
  // Application-server ephemeral keypair (the `dh=` the recipient sees).
  const asPriv = p256.utils.randomSecretKey();
  const dh = p256.getPublicKey(asPriv, false); // 65-byte uncompressed
  const ecdh = p256.getSharedSecret(asPriv, recipientPub).subarray(1, 33);

  const secret = hkdf(sha256, ecdh, authSecret, enc.encode('Content-Encoding: auth\0'), 32);
  const context = concat(enc.encode('P-256'), new Uint8Array([0]), lp(recipientPub), lp(dh));
  const cek = hkdf(sha256, secret, salt, concat(enc.encode('Content-Encoding: aesgcm\0'), context), 16);
  const nonce = hkdf(sha256, secret, salt, concat(enc.encode('Content-Encoding: nonce\0'), context), 12);

  // 2-byte big-endian pad length (zero padding) prefix, per "aesgcm".
  const record = concat(new Uint8Array([0, 0]), plaintext);
  const rawData = gcm(cek, nonce).encrypt(record);
  return { rawData, dh };
}

function makeRecipientKeys(): EceKeys & { recipientPub: Uint8Array } {
  const privateKey = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(privateKey, false); // 65-byte uncompressed
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey, publicKey, authSecret, recipientPub: publicKey };
}

describe('Web Push aesgcm ECE', () => {
  it('round-trips a payload (independent encrypt → decrypt)', () => {
    const keys = makeRecipientKeys();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const message = enc.encode('hello find hub 🛰');
    const { rawData, dh } = encryptEce(message, salt, keys.recipientPub, keys.authSecret);

    const out = decryptEce(rawData, salt, dh, keys);
    expect(new TextDecoder().decode(out)).toBe('hello find hub 🛰');
  });

  it('rejects a tampered ciphertext (GCM auth)', () => {
    const keys = makeRecipientKeys();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const { rawData, dh } = encryptEce(enc.encode('x'), salt, keys.recipientPub, keys.authSecret);
    rawData[0] ^= 0xff;
    expect(() => decryptEce(rawData, salt, dh, keys)).toThrow();
  });

  it('unwrapFcmPayload pulls the base64 DeviceUpdate out of the JSON envelope', () => {
    const keys = makeRecipientKeys();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const deviceUpdate = new Uint8Array([0x0a, 0x03, 1, 2, 3]); // arbitrary protobuf-ish bytes
    const b64 = btoa(String.fromCharCode(...deviceUpdate));
    const envelope = enc.encode(
      JSON.stringify({ data: { 'com.google.android.apps.adm.FCM_PAYLOAD': b64 } }),
    );
    const { rawData, dh } = encryptEce(envelope, salt, keys.recipientPub, keys.authSecret);

    const payload = unwrapFcmPayload(rawData, salt, dh, keys);
    expect(payload).not.toBeNull();
    expect(Array.from(payload!)).toEqual([0x0a, 0x03, 1, 2, 3]);
  });

  it('returns null for a non-payload (control) message', () => {
    const keys = makeRecipientKeys();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const envelope = enc.encode(JSON.stringify({ data: { message_type: 'deleted_messages' } }));
    const { rawData, dh } = encryptEce(envelope, salt, keys.recipientPub, keys.authSecret);
    expect(unwrapFcmPayload(rawData, salt, dh, keys)).toBeNull();
  });
});

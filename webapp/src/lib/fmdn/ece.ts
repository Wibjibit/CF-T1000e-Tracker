// Web Push "aesgcm" Encrypted Content-Encoding (ECE) — unwraps the FCM push.
//
// The Find Hub DeviceUpdate arrives as an MCS DataMessageStanza whose `raw_data`
// is a Web Push ECE payload (legacy "aesgcm" scheme, draft-ietf-webpush-
// encryption-04), with the `dh=` and `salt=` parameters carried in the stanza's
// app_data (`crypto-key: dh=…`, `encryption: salt=…`). Decrypting it yields the
// JSON `{ data: { "com.google.android.apps.adm.FCM_PAYLOAD": "<base64>" } }`,
// and that base64 is the `DeviceUpdate` protobuf.
//
// The Rust desktop app gets this for free from the `fcm-push-listener` crate
// (`MessageStream::wrap`), so there's no Rust vector to mirror — this is the one
// module proven by round-trip + a live push in Phase 3.2, not by oracle parity.
// We follow the same primitives the Python reference's `http_ece` uses
// (`version="aesgcm"`, HKDF-SHA256, AES-128-GCM): see
// GoogleFindMyTools/Auth/firebase_messaging/fcmpushclient.py `_decrypt_raw_data`.
//
// All sync, via @noble: P-256 ECDH + HKDF-SHA256 + AES-128-GCM.

import { p256 } from '@noble/curves/nist.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** The recipient (our) FCM ECDH key material, from the bootstrap import. */
export interface EceKeys {
  /** Raw 32-byte P-256 private scalar (`keys.private` decoded from PKCS#8). */
  privateKey: Uint8Array;
  /** Raw 65-byte uncompressed P-256 public point (`keys.public`). */
  publicKey: Uint8Array;
  /** 16-byte auth secret (`keys.secret`). */
  authSecret: Uint8Array;
}

const enc = new TextEncoder();
const CE_AUTH = enc.encode('Content-Encoding: auth\0');
const CE_AESGCM = enc.encode('Content-Encoding: aesgcm\0');
const CE_NONCE = enc.encode('Content-Encoding: nonce\0');
const LABEL = enc.encode('P-256');

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 2-byte big-endian length prefix followed by the key bytes. */
function lengthPrefixed(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + key.length);
  out[0] = (key.length >> 8) & 0xff;
  out[1] = key.length & 0xff;
  out.set(key, 2);
  return out;
}

/**
 * The "aesgcm" key/nonce context: `"P-256"\0 || len||recipientPub || len||senderPub`.
 * recipient = us (our public key), sender = the `dh=` value (Google's).
 */
function buildContext(recipientPub: Uint8Array, senderPub: Uint8Array): Uint8Array {
  return concat(LABEL, new Uint8Array([0]), lengthPrefixed(recipientPub), lengthPrefixed(senderPub));
}

/**
 * Decrypt a Web Push "aesgcm" payload.
 *
 * @param rawData  the MCS DataMessageStanza `raw_data` (ciphertext + 16-byte GCM tag)
 * @param salt     16 bytes from the `encryption: salt=` app_data (already base64url-decoded)
 * @param dh       65-byte sender (Google) public key from `crypto-key: dh=` (base64url-decoded)
 * @param keys     our FCM ECDH keys (from the stored account credentials)
 * @returns the decrypted plaintext (typically UTF-8 JSON)
 */
export function decryptEce(
  rawData: Uint8Array,
  salt: Uint8Array,
  dh: Uint8Array,
  keys: EceKeys,
): Uint8Array {
  // 1) ECDH(our private, Google's dh) → 32-byte shared X coordinate.
  //    @noble returns a 33-byte compressed point; the X is bytes [1..33].
  const shared = p256.getSharedSecret(keys.privateKey, dh);
  const ecdhSecret = shared.subarray(1, 33);

  // 2) Mix in the auth secret: PRK = HKDF(salt=auth_secret, ikm=ecdh, info="…auth\0", 32).
  const secret = hkdf(sha256, ecdhSecret, keys.authSecret, CE_AUTH, 32);

  // 3) Derive CEK (16) and nonce (12), keyed by the message salt over the context.
  const context = buildContext(keys.publicKey, dh);
  const cek = hkdf(sha256, secret, salt, concat(CE_AESGCM, context), 16);
  const nonce = hkdf(sha256, secret, salt, concat(CE_NONCE, context), 12);

  // 4) AES-128-GCM decrypt the single record (FCM payloads fit in one record).
  const record = gcm(cek, nonce).decrypt(rawData);

  // 5) Strip the "aesgcm" 2-byte big-endian padding-length prefix + padding.
  if (record.length < 2) throw new Error('decryptEce: record too short for padding header');
  const padLen = (record[0] << 8) | record[1];
  if (2 + padLen > record.length) throw new Error('decryptEce: padding length exceeds record');
  return record.subarray(2 + padLen);
}

/**
 * Convenience: decrypt the push and pull the base64 `FCM_PAYLOAD` out of the
 * JSON envelope, returning the decoded `DeviceUpdate` protobuf bytes (or null
 * if the message carries no payload, e.g. a `deleted_messages` control).
 */
const FCM_PAYLOAD_KEY = 'com.google.android.apps.adm.FCM_PAYLOAD';

export function unwrapFcmPayload(
  rawData: Uint8Array,
  salt: Uint8Array,
  dh: Uint8Array,
  keys: EceKeys,
): Uint8Array | null {
  const plaintext = decryptEce(rawData, salt, dh, keys);
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
  const b64 =
    obj && typeof obj === 'object'
      ? ((obj as { data?: Record<string, unknown> }).data?.[FCM_PAYLOAD_KEY] as string | undefined)
      : undefined;
  if (typeof b64 !== 'string') return null;
  return base64ToBytes(b64);
}

/** Decode standard base64 (the FCM_PAYLOAD is standard, not url-safe). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

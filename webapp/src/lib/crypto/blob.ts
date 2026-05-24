// App-layer envelope encryption for credentials at rest (Google Master Token,
// Apple ID token, Maps cookies, ...). The single chokepoint for crypto: every
// callsite that stores or reads an `accounts` credential goes through here, so
// there is exactly one module to audit and one key to rotate (see
// docs/architecture.md "Credentials at rest").
//
// Scheme: AES-256-GCM via WebCrypto (crypto.subtle), available identically in
// the Workers runtime and in Node 18+. A fresh random 12-byte nonce per
// encrypt is returned alongside the ciphertext and stored in a SEPARATE column
// (accounts.credentials_nonce / accounts.credentials_ciphertext). GCM is an
// AEAD, so any tampering with either the nonce or the ciphertext makes
// decrypt() reject rather than return garbage.

/** Just the slice of the Workers env this module needs — keeps it unit-testable. */
export interface BlobEnv {
  /** 32 random bytes, base64-encoded. Lives in Cloudflare Workers Secrets. */
  BLOB_ENC_KEY: string;
}

/** What encrypt() produces and decrypt() consumes. Both halves go to D1. */
export interface EncryptedBlob {
  /** 12-byte AES-GCM IV. */
  nonce: Uint8Array;
  /** AES-GCM ciphertext (includes the 16-byte auth tag GCM appends). */
  ciphertext: Uint8Array;
}

/**
 * Shape of the two BLOB columns as D1 hands them back. Production D1 returns a
 * BLOB as a plain `number[]` (array of byte values), NOT an ArrayBuffer — so we
 * must accept that form too. (Local/miniflare and a hand-built row can also hand
 * over an ArrayBuffer or a typed array; toBytes normalises all of them.)
 */
export interface StoredBlob {
  credentials_nonce: ArrayBuffer | Uint8Array | ArrayBufferView | number[];
  credentials_ciphertext: ArrayBuffer | Uint8Array | ArrayBufferView | number[];
}

const AES_GCM = 'AES-GCM';
const NONCE_BYTES = 12; // 96-bit IV — the size GCM is defined and fastest for.
const KEY_BYTES = 32; // AES-256.

// crypto.subtle wants a BufferSource backed by a plain ArrayBuffer (TS 5.7+
// distinguishes ArrayBuffer from SharedArrayBuffer), so these helpers always
// return an ArrayBuffer-backed copy — cheap for the small credential blobs here
// and it sidesteps the Uint8Array<ArrayBufferLike> assignability friction.

/** Decode a base64 string to bytes, tolerating surrounding whitespace. */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Normalise anything BLOB-ish (D1 number[], ArrayBuffer, Uint8Array, DataView) to bytes. */
function toBytes(value: ArrayBuffer | Uint8Array | ArrayBufferView | number[]): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  // Production D1 returns BLOB columns as a plain array of byte values.
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('blob: expected ArrayBuffer, typed array, or number[]');
}

/**
 * Import BLOB_ENC_KEY into a non-extractable AES-GCM CryptoKey. Throws a clear
 * error if the secret is missing or not exactly 32 bytes once base64-decoded —
 * far better than a downstream "operation failed" deep inside subtle.
 */
async function importKey(env: BlobEnv): Promise<CryptoKey> {
  if (!env?.BLOB_ENC_KEY) {
    throw new Error('blob: BLOB_ENC_KEY is not set');
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(env.BLOB_ENC_KEY);
  } catch {
    throw new Error('blob: BLOB_ENC_KEY is not valid base64');
  }
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `blob: BLOB_ENC_KEY must be ${KEY_BYTES} bytes (base64), got ${raw.length}`,
    );
  }
  return crypto.subtle.importKey('raw', raw, { name: AES_GCM }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a UTF-8 plaintext under BLOB_ENC_KEY. Returns a fresh nonce plus the
 * ciphertext (with GCM's auth tag appended) for storage in the two `accounts`
 * BLOB columns.
 */
export async function encrypt(plaintext: string, env: BlobEnv): Promise<EncryptedBlob> {
  const key = await importKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const buf = await crypto.subtle.encrypt({ name: AES_GCM, iv: nonce }, key, data);
  return { nonce, ciphertext: new Uint8Array(buf) };
}

/**
 * Decrypt a stored credential blob back to its UTF-8 plaintext. Accepts either
 * a D1 row ({ credentials_nonce, credentials_ciphertext }) or an in-memory
 * EncryptedBlob. Rejects (throws) if the key is wrong or the data was tampered
 * with — GCM authentication failure surfaces as a thrown error, never silent
 * corruption.
 */
export async function decrypt(
  blob: StoredBlob | EncryptedBlob,
  env: BlobEnv,
): Promise<string> {
  const nonce =
    'nonce' in blob ? toBytes(blob.nonce) : toBytes(blob.credentials_nonce);
  const ciphertext =
    'ciphertext' in blob
      ? toBytes(blob.ciphertext)
      : toBytes(blob.credentials_ciphertext);

  const key = await importKey(env);
  let buf: ArrayBuffer;
  try {
    buf = await crypto.subtle.decrypt({ name: AES_GCM, iv: nonce }, key, ciphertext);
  } catch {
    // WebCrypto throws an opaque OperationError on auth-tag mismatch; translate
    // it into something a handler can log and act on.
    throw new Error('blob: decryption failed (wrong key or tampered data)');
  }
  return new TextDecoder().decode(buf);
}

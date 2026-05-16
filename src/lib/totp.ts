// RFC 6238 TOTP verify, implemented on top of WebCrypto so it runs in the
// Workers runtime without a Node dep. SHA-1 + 6 digits + 30 s step matches
// the Google Authenticator default — what almost every TOTP app uses.

import { decodeBase32 } from './base32';

const STEP_SECONDS = 30;
const DIGITS = 6;
const SKEW_STEPS = 1; // accept current ± 1 step (±30 s) for clock skew

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function counterToBytes(counter: number): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // JS bitwise ops are 32-bit. Split into hi/lo halves; Math.floor for the hi.
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000), false);
  view.setUint32(4, counter & 0xffff_ffff, false);
  return buf;
}

async function totpAt(secret: Uint8Array, timeMs: number): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS);
  const counterBytes = counterToBytes(counter);

  // WebCrypto needs ArrayBuffer-typed BufferSource; copy the key bytes.
  const keyBuf = secret.slice().buffer;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counterBytes));

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * Verify a 6-digit TOTP code against a base32 shared secret with ±1 step skew.
 * Returns true on match, false otherwise. Pass `timeMs` to override the clock
 * (useful in tests).
 */
export async function verifyTOTP(
  secretBase32: string,
  code: string,
  timeMs: number = Date.now(),
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  let secret: Uint8Array;
  try {
    secret = decodeBase32(secretBase32);
  } catch {
    return false;
  }
  if (secret.length === 0) return false;

  for (let offset = -SKEW_STEPS; offset <= SKEW_STEPS; offset++) {
    const expected = await totpAt(secret, timeMs + offset * STEP_SECONDS * 1000);
    if (timingSafeEqualStr(expected, code)) return true;
  }
  return false;
}

/** Exposed for tests. */
export const _internal = { totpAt };

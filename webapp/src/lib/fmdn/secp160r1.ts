// SECP160R1 curve + the EID-derivation scalar `calculate_r`.
//
// SECP160R1 is the curve Google's FMDN E2EE uses for foreign-report ECIES and
// for EID generation. It's a SEC2 curve no mainstream WebCrypto/most JS libs
// ship, so we define it from its public parameters via @noble/curves' generic
// short-Weierstrass constructor. The desktop app builds the same curve from the
// same SEC2 constants via openssl (`desktop-app/src/crypto.rs`); this module is
// the TS oracle-parity port. See docs/desktop-app-crypto.md.
//
// `@noble/curves` (custom Weierstrass) and `@noble/ciphers` (AES-256-ECB for
// calculate_r) per master-plan Phase 3.1.

import { weierstrass } from '@noble/curves/abstract/weierstrass.js';
import { ecb } from '@noble/ciphers/aes.js';

// SEC2 parameters for SECP160R1 (docs/desktop-app-crypto.md).
const P = 0xffffffffffffffffffffffffffffffff7fffffffn;
const A = 0xffffffffffffffffffffffffffffffff7ffffffcn;
const B = 0x1c97befc54bd7a8b65acf89f81d4d4adc565fa45n;
const GX = 0x4a96b5688ef573284664698968c38bb913cbfc82n;
const GY = 0x23a628553168947d59dcc912042351377ac5fb32n;
export const N = 0x0100000000000000000001f4c8f927aed3ca752257n; // group order

/** SECP160R1 point class (cofactor 1). `Point.BASE` is the generator G. */
export const Secp160r1Point = weierstrass({
  p: P,
  n: N,
  h: 1n,
  a: A,
  b: B,
  Gx: GX,
  Gy: GY,
});

const K = 10; // ROTATION_PERIOD = 2^K = 1024 s rotation window

/**
 * `calculate_r` per FMDNCrypto/eid_generator.py:
 *   - Mask the K=10 lowest bits of the beacon time counter (align to the
 *     1024-second EID rotation window); encode as 4 big-endian bytes.
 *   - Build the 32-byte structured AES input
 *     `[0xFF*11 | K | ts(4) | 0x00*11 | K | ts(4)]`.
 *   - AES-256-ECB encrypt it with the 32-byte EIK as the key (two independent
 *     16-byte blocks, no padding).
 *   - Interpret the 32-byte ciphertext as a big-endian integer, reduce mod n.
 *
 * `beaconTime` is the beacon time counter (0 for MCU/dev-kit trackers like the
 * T1000-E). Treated as an unsigned 32-bit value.
 */
export function calculateR(eik: Uint8Array, beaconTime: number): bigint {
  if (eik.length !== 32) throw new Error(`calculateR: EIK must be 32 bytes, got ${eik.length}`);

  const mask = ~((1 << K) - 1) >>> 0;
  const tsMasked = (beaconTime & mask) >>> 0;
  const ts = new Uint8Array(4);
  new DataView(ts.buffer).setUint32(0, tsMasked, false); // big-endian

  const data = new Uint8Array(32);
  data.fill(0xff, 0, 11);
  data[11] = K;
  data.set(ts, 12);
  // data[16..27] already 0
  data[27] = K;
  data.set(ts, 28);

  const rDash = ecb(eik, { disablePadding: true }).encrypt(data); // 32 bytes
  const rDashInt = bytesToBigIntBE(rDash);
  return mod(rDashInt, N);
}

/** R = r·G as an affine point. */
export function scalarMulG(r: bigint): { x: bigint; y: bigint } {
  return Secp160r1Point.BASE.multiply(r).toAffine();
}

/** shared = r·S, returning the x coordinate (the ECDH shared value). */
export function scalarMulPointX(sx: bigint, sy: bigint, r: bigint): bigint {
  const s = Secp160r1Point.fromAffine({ x: sx, y: sy });
  return s.multiply(r).toAffine().x;
}

/**
 * Recover the even-y solution of y² = x³ + a·x + b (mod p) for SECP160R1.
 * Valid because p ≡ 3 (mod 4), so the modular square root is
 * y = (y²)^((p+1)/4) mod p. Throws if x is not on the curve.
 *
 * Note: for ECIES the y-sign choice is irrelevant to the result (negating S
 * negates r·S, leaving its x — the shared value — and S.x unchanged), but we
 * match the reference's even-y convention for fidelity.
 */
export function rxToRy(rx: bigint): bigint {
  const ySq = mod(mod(rx * rx * rx, P) + mod(A * rx, P) + B, P);
  const y = modPow(ySq, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== ySq) {
    throw new Error('rxToRy: x is not on SECP160R1 (not a valid E2EE public key)');
  }
  return y % 2n === 0n ? y : P - y;
}

// ---------------------------------------------------------------------------
// bigint <-> bytes helpers (SECP160R1 coordinates are 20 bytes)
// ---------------------------------------------------------------------------

export function bytesToBigIntBE(b: Uint8Array): bigint {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}

/** big-endian bytes of `n`, zero-padded on the left to exactly `len` bytes. */
export function bigIntToBytesBE(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`bigIntToBytesBE: value too large for ${len} bytes`);
  return out;
}

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

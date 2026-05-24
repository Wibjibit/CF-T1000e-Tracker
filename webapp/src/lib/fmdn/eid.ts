// EID (Ephemeral Identifier) generation — `generate_eid` / `get_next_eids`.
//
// The read path (Phase 3) doesn't need this, but it's cheap to build now while
// the curve + AES-ECB code is fresh. Phase 4 (static-EID liveness) uses it to
// build the precomputed-EID window that keeps the tag on the network. TS parity
// port of FMDNCrypto/eid_generator.py + the SpotApi window loop.

import { calculateR, scalarMulG, bigIntToBytesBE } from './secp160r1';

export const ROTATION_PERIOD = 1024; // 2^K seconds — one EID rotation window

/**
 * `generate_eid(eik, timestamp)`: R = calculate_r(eik, t)·G; the EID is R's
 * x-coordinate as 20 big-endian bytes. (calculate_r masks the low 10 bits of
 * `timestamp`, so any t within the same 1024-second window yields one EID.)
 */
export function generateEid(eik: Uint8Array, timestamp: number): Uint8Array {
  const r = calculateR(eik, timestamp);
  return bigIntToBytesBE(scalarMulG(r).x, 20);
}

/** One precomputed (time-bucket, truncated-EID) pair for the upload window. */
export interface PrecomputedEid {
  /** Window start, unix seconds, aligned to ROTATION_PERIOD. */
  timestampSeconds: number;
  /** First 10 bytes of the EID — the `truncatedEid` Google indexes on. */
  truncatedEid: Uint8Array;
}

/**
 * Build `count` consecutive rotation-window buckets starting at (or just before)
 * `startTimeSeconds`. For a static-EID MCU/dev-kit tracker (`staticSlot0`), every
 * bucket maps to the single slot-0 EID `generate_eid(eik, 0)` — the
 * GoogleFindMyTools workaround for firmware that doesn't actually rotate. For a
 * truly rotating device, each bucket gets its own `generate_eid(eik, t)`.
 */
export function getNextEids(
  eik: Uint8Array,
  startTimeSeconds: number,
  count: number,
  opts: { staticSlot0?: boolean } = {},
): PrecomputedEid[] {
  const staticSlot0 = opts.staticSlot0 ?? false;
  const slot0 = staticSlot0 ? generateEid(eik, 0).subarray(0, 10) : null;

  const out: PrecomputedEid[] = [];
  let t = startTimeSeconds - (startTimeSeconds % ROTATION_PERIOD);
  for (let i = 0; i < count; i++) {
    const truncatedEid = slot0 ?? generateEid(eik, t).subarray(0, 10);
    out.push({ timestampSeconds: t, truncatedEid });
    t += ROTATION_PERIOD;
  }
  return out;
}

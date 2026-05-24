// Phase 4 — static-EID liveness: build the precomputed-EID upload that keeps a
// Find Hub MCU tracker on the network long-term (master-plan §1.3).
//
// TS port of GoogleFindMyTools SpotApi/UploadPrecomputedPublicKeyIds
// (`refresh_custom_trackers` / `get_next_eids`). The EID crypto itself lives in
// eid.ts/secp160r1.ts (oracle-parity tested); this module is the WINDOW math +
// the `UploadPrecomputedPublicKeyIdsRequest` protobuf + the gRPC frame.
//
// Transport note: the serialized frame is NOT sent from here — the `spot-pa`
// gRPC call needs `te: trailers`, which Workers `fetch()` strips (§1.5). The
// caller hands `buildSpotFrame(...)` + a Spot token to the off-Workers Rust
// relay container (spike/rust-transport), which performs the HTTP/2 POST.

import { generateEid, ROTATION_PERIOD, type PrecomputedEid } from './eid';
import { PbWriter } from './protobuf';
import { decryptEik } from './eik';
import type { DeviceEntry } from './report';
import {
  MAX_TRUNCATED_EID_SECONDS_SERVER,
  REFRESH_BACKDATE_SECONDS,
  eidWindowValidUntilMs,
  isEidWindowStale,
} from './eid-window';

// Re-export the dependency-free window helpers/constants so refresh.ts stays the
// one import surface for refresh logic (the /sources page imports the light
// eid-window.ts directly to keep @noble out of the site bundle).
export {
  MAX_TRUNCATED_EID_SECONDS_SERVER,
  REFRESH_BACKDATE_SECONDS,
  eidWindowValidUntilMs,
  isEidWindowStale,
};

/** The unary gRPC method path the relay container POSTs to (after spot-pa host). */
export const SPOT_UPLOAD_METHOD =
  'google.internal.spot.v1.SpotService/UploadPrecomputedPublicKeyIds';

/** One device's precomputed-EID window for the upload request. */
export interface UploadDeviceEids {
  canonicId: string;
  pairDate: number;
  eids: PrecomputedEid[];
}

/**
 * Faithful port of `get_next_eids(eik, pair_date, start_date, duration_seconds)`.
 * Buckets are anchored to `pairDate` (NOT to phase 0 like the read-path
 * `getNextEids`): the window starts at the rotation boundary at/just-before
 * `startDate` and steps by ROTATION_PERIOD until it covers `durationSeconds`.
 * Every bucket carries the single static slot-0 EID (the MCU/dev-kit firmware
 * doesn't rotate — master-plan §1.2).
 *
 * `startDate`/`pairDate` are unix SECONDS. Assumes pairDate ≤ startDate (the
 * device was paired before now-3h), so the offset is non-negative and JS `%`
 * matches Python's.
 */
export function getNextEidsForUpload(
  eik: Uint8Array,
  pairDate: number,
  startDate: number,
  durationSeconds: number,
): PrecomputedEid[] {
  const truncatedEid = generateEid(eik, 0).subarray(0, 10); // static slot-0

  const out: PrecomputedEid[] = [];
  const startOffset = startDate - pairDate;
  let currentOffset = startOffset - mod(startOffset, ROTATION_PERIOD); // align down
  const end = startOffset + durationSeconds;
  while (currentOffset <= end) {
    out.push({ timestampSeconds: pairDate + currentOffset, truncatedEid });
    currentOffset += ROTATION_PERIOD;
  }
  return out;
}

/**
 * Build a `UploadPrecomputedPublicKeyIdsRequest` (proto/DeviceUpdate.proto):
 *
 *   UploadPrecomputedPublicKeyIdsRequest { repeated DevicePublicKeyIds deviceEids = 1 }
 *   DevicePublicKeyIds { CanonicId canonicId = 1; PublicKeyIdList clientList = 2; int32 pairDate = 3 }
 *   PublicKeyIdList { repeated PublicKeyIdInfo publicKeyIdInfo = 1 }
 *   PublicKeyIdInfo { Time timestamp = 1; TruncatedEID publicKeyId = 2 }
 *   Time { uint32 seconds = 1 }   TruncatedEID { bytes truncatedEid = 1 }   CanonicId { string id = 1 }
 */
export function buildUploadRequest(devices: UploadDeviceEids[]): Uint8Array {
  const top = new PbWriter();
  for (const d of devices) {
    const canonicId = new PbWriter().string(1, d.canonicId).finish();

    const clientList = new PbWriter();
    for (const e of d.eids) {
      const timestamp = new PbWriter().int(1, e.timestampSeconds).finish();
      const publicKeyId = new PbWriter().bytesField(1, e.truncatedEid).finish();
      const info = new PbWriter().message(1, timestamp).message(2, publicKeyId).finish();
      clientList.message(1, info); // repeated publicKeyIdInfo
    }

    const dev = new PbWriter()
      .message(1, canonicId)
      .message(2, clientList.finish())
      .int(3, d.pairDate)
      .finish();
    top.message(1, dev); // repeated deviceEids
  }
  return top.finish();
}

/** Wrap a protobuf message in a gRPC length-prefixed frame:
 *  `[compressed=0x00][uint32 BE length][message]`. */
export function buildSpotFrame(message: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + message.length);
  new DataView(frame.buffer).setUint32(1, message.length, false); // byte 0 stays 0 (uncompressed)
  frame.set(message, 5);
  return frame;
}

// ---------------------------------------------------------------------------
// Orchestration core (pure; the I/O glue lives in the cron worker)
// ---------------------------------------------------------------------------

/** The outcome of planning one account's refresh from its ListDevices result. */
export interface RefreshPlan {
  /** The single batched gRPC frame to POST, or null if nothing is eligible. */
  frame: Uint8Array | null;
  /** canonicIds included in `frame` — their sources get `last_refreshed_at` bumped. */
  refreshedCanonicIds: string[];
  /** Devices skipped because their EIK wouldn't decrypt (e.g. owner-key bump). */
  failures: { canonicId: string; error: string }[];
}

/**
 * Plan the precomputed-EID refresh for one account's devices. Mirrors
 * `refresh_custom_trackers`: take the ListDevices result, keep the MCU
 * static-EID trackers we actually track, decrypt each EIK, and build ONE
 * batched `UploadPrecomputedPublicKeyIdsRequest` covering them all. A device
 * whose EIK won't decrypt is recorded in `failures` and skipped — it must not
 * sink the others. Pure: no token, no socket, no D1.
 *
 * `nowSeconds` is unix seconds; the window is `[now-3h, now-3h + 4d]`.
 */
export function planRefresh(
  devices: DeviceEntry[],
  trackedCanonicIds: Set<string>,
  ownerKey: Uint8Array,
  nowSeconds: number,
): RefreshPlan {
  const startDate = nowSeconds - REFRESH_BACKDATE_SECONDS;
  const uploadDevices: UploadDeviceEids[] = [];
  const refreshedCanonicIds: string[] = [];
  const failures: { canonicId: string; error: string }[] = [];

  for (const d of devices) {
    if (!d.registration.isMcu) continue; // only static-EID MCU trackers refresh
    if (!trackedCanonicIds.has(d.canonicId)) continue; // only devices we track
    let eik: Uint8Array;
    try {
      eik = decryptEik(ownerKey, d.registration.encryptedIdentityKey, d.registration.isMcu);
    } catch (e) {
      failures.push({ canonicId: d.canonicId, error: String(e) });
      continue;
    }
    const eids = getNextEidsForUpload(
      eik,
      d.registration.pairDate,
      startDate,
      MAX_TRUNCATED_EID_SECONDS_SERVER,
    );
    uploadDevices.push({ canonicId: d.canonicId, pairDate: d.registration.pairDate, eids });
    refreshedCanonicIds.push(d.canonicId);
  }

  const frame = uploadDevices.length ? buildSpotFrame(buildUploadRequest(uploadDevices)) : null;
  return { frame, refreshedCanonicIds, failures };
}

/** The relay container's JSON reply, normalised. */
export interface RelayResponse {
  ok: boolean;
  httpStatus: number;
  grpcStatus: string | null;
  grpcMessage: string | null;
  bodyHex: string;
  /** Set when the relay couldn't even make the call (bad/empty token, non-JSON). */
  error?: string;
}

/**
 * Parse the relay container's JSON envelope. NB: `ok` reflects clean TRANSPORT
 * (HTTP 200 + non-error grpc-status), not a guarantee the window actually moved
 * — for a mutating Upload, confirm that out-of-band (master-plan Phase 4 step 8).
 */
export function parseRelayResponse(jsonText: string): RelayResponse {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return { ok: false, httpStatus: 0, grpcStatus: null, grpcMessage: null, bodyHex: '', error: 'relay returned non-JSON' };
  }
  const base = {
    httpStatus: typeof o.http_status === 'number' ? o.http_status : 0,
    grpcStatus: o.grpc_status == null ? null : String(o.grpc_status),
    grpcMessage: o.grpc_message == null ? null : String(o.grpc_message),
    bodyHex: typeof o.body_hex === 'string' ? o.body_hex : '',
  };
  if (o.error) return { ...base, ok: false, error: String(o.error) };
  return { ...base, ok: o.ok === true };
}

/** Non-negative modulo (matches Python `%` for a positive divisor). */
function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

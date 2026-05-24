// Phase 4 static-EID refresh: the precomputed-EID upload window + protobuf.
//
// The window math is anchored on a GOLDEN VECTOR captured by running the real
// upstream `get_next_eids` (GoogleFindMyTools SpotApi/UploadPrecomputedPublicKeyIds,
// pure local crypto/arithmetic — no network/account). This pins our TS port to
// the proven implementation rather than to a re-reading of it. The static slot-0
// EID itself is cross-checked against the already-oracle-tested `generateEid`.

import { describe, it, expect } from 'vitest';
import { gcm } from '@noble/ciphers/aes.js';
import {
  getNextEidsForUpload,
  buildUploadRequest,
  buildSpotFrame,
  planRefresh,
  parseRelayResponse,
  eidWindowValidUntilMs,
  isEidWindowStale,
  MAX_TRUNCATED_EID_SECONDS_SERVER,
  REFRESH_BACKDATE_SECONDS,
} from '../lib/fmdn/refresh';
import { generateEid, ROTATION_PERIOD } from '../lib/fmdn/eid';
import type { DeviceEntry } from '../lib/fmdn/report';
import {
  decodeMessage,
  getMessage,
  getMessages,
  getString,
  getVarint,
  getBytes,
} from '../lib/fmdn/protobuf';

function hex(h: string): Uint8Array {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
}
function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

// --- GOLDEN VECTOR (real upstream get_next_eids) ---------------------------
const EIK = hex('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
const PAIR_DATE = 1700000000;
const START_DATE = 1700005000;
const SLOT0_TRUNCATED = '7079872e76c6ff939d14';
const SMALL_DURATION = 4096;
const SMALL_WINDOW_SECONDS = [1700004096, 1700005120, 1700006144, 1700007168, 1700008192];
// Full 4-day window:
const FULL_BUCKET_COUNT = 339;
const FULL_FIRST = 1700004096;
const FULL_LAST = 1700350208;

describe('getNextEidsForUpload (golden vector vs upstream get_next_eids)', () => {
  it('matches the captured small window exactly (timestamps + truncated EID)', () => {
    const eids = getNextEidsForUpload(EIK, PAIR_DATE, START_DATE, SMALL_DURATION);
    expect(eids.map((e) => e.timestampSeconds)).toEqual(SMALL_WINDOW_SECONDS);
    for (const e of eids) expect(toHex(e.truncatedEid)).toBe(SLOT0_TRUNCATED);
  });

  it('matches the captured full 4-day window count + endpoints', () => {
    const eids = getNextEidsForUpload(EIK, PAIR_DATE, START_DATE, MAX_TRUNCATED_EID_SECONDS_SERVER);
    expect(eids).toHaveLength(FULL_BUCKET_COUNT);
    expect(eids[0].timestampSeconds).toBe(FULL_FIRST);
    expect(eids[eids.length - 1].timestampSeconds).toBe(FULL_LAST);
  });

  it('is pairDate-anchored: every bucket ≡ pairDate (mod 1024), NOT phase 0', () => {
    const eids = getNextEidsForUpload(EIK, PAIR_DATE, START_DATE, SMALL_DURATION);
    const phase = PAIR_DATE % ROTATION_PERIOD; // 256 — distinct from the read-path getNextEids' phase-0
    expect(phase).not.toBe(0);
    for (const e of eids) expect(e.timestampSeconds % ROTATION_PERIOD).toBe(phase);
  });

  it('uses the static slot-0 EID (cross-check against the oracle-tested generateEid)', () => {
    const eids = getNextEidsForUpload(EIK, PAIR_DATE, START_DATE, SMALL_DURATION);
    expect(toHex(eids[0].truncatedEid)).toBe(toHex(generateEid(EIK, 0).subarray(0, 10)));
  });

  it('the 3h backdate constant is 10800s', () => {
    expect(REFRESH_BACKDATE_SECONDS).toBe(3 * 3600);
    expect(MAX_TRUNCATED_EID_SECONDS_SERVER).toBe(4 * 24 * 3600);
  });
});

describe('buildUploadRequest (UploadPrecomputedPublicKeyIdsRequest protobuf)', () => {
  it('round-trips one device: canonicId + pairDate + the bucket list', () => {
    const eids = getNextEidsForUpload(EIK, PAIR_DATE, START_DATE, SMALL_DURATION);
    const bytes = buildUploadRequest([{ canonicId: 'cid-123', pairDate: PAIR_DATE, eids }]);

    const top = decodeMessage(bytes);
    const deviceEids = getMessages(top, 1); // repeated DevicePublicKeyIds
    expect(deviceEids).toHaveLength(1);

    const dev = deviceEids[0];
    const canonic = getMessage(dev, 1); // CanonicId
    expect(canonic && getString(canonic, 1)).toBe('cid-123');
    expect(getVarint(dev, 3)).toBe(PAIR_DATE); // pairDate

    const clientList = getMessage(dev, 2); // PublicKeyIdList
    const infos = clientList ? getMessages(clientList, 1) : [];
    expect(infos).toHaveLength(eids.length);

    // First info: timestamp.seconds (Time field 1) + publicKeyId.truncatedEid (TruncatedEID field 1)
    const ts = getMessage(infos[0], 1);
    expect(ts && getVarint(ts, 1)).toBe(SMALL_WINDOW_SECONDS[0]);
    const teid = getMessage(infos[0], 2);
    expect(teid && toHex(getBytes(teid, 1)!)).toBe(SLOT0_TRUNCATED);
  });

  it('supports multiple devices in one request', () => {
    const eids = getNextEidsForUpload(EIK, PAIR_DATE, START_DATE, SMALL_DURATION);
    const bytes = buildUploadRequest([
      { canonicId: 'a', pairDate: 1, eids },
      { canonicId: 'b', pairDate: 2, eids },
    ]);
    expect(getMessages(decodeMessage(bytes), 1)).toHaveLength(2);
  });
});

describe('buildSpotFrame (gRPC length-prefixed frame)', () => {
  it('prefixes [compressed=0][BE u32 length][payload]', () => {
    const payload = hex('deadbeef');
    const frame = buildSpotFrame(payload);
    expect(frame[0]).toBe(0x00);
    expect(new DataView(frame.buffer).getUint32(1, false)).toBe(4);
    expect(toHex(frame.subarray(5))).toBe('deadbeef');
    expect(frame.length).toBe(5 + payload.length);
  });
});

// --- planRefresh + parseRelayResponse (orchestration core) -----------------

const OWNER_KEY = new Uint8Array(16).fill(0xab);

/** Seal an EIK exactly as a Find Hub MCU registration stores it: AES-GCM under
 *  the owner key ([12B IV][ct][16B tag]) then flip_bits (the MCU quirk). */
function sealEikForMcu(eik: Uint8Array): Uint8Array {
  const iv = new Uint8Array(12).fill(7);
  const ctTag = gcm(OWNER_KEY, iv).encrypt(eik);
  const blob = new Uint8Array(12 + ctTag.length);
  blob.set(iv, 0);
  blob.set(ctTag, 12);
  return blob.map((b) => b ^ 0xff);
}

function device(canonicId: string, isMcu: boolean, eik: Uint8Array, pairDate: number): DeviceEntry {
  return {
    canonicId,
    displayName: 'dev',
    registration: {
      encryptedIdentityKey: isMcu ? sealEikForMcu(eik) : new Uint8Array(60),
      ownerKeyVersion: 1,
      isMcu,
      pairDate,
    },
    reports: [],
  };
}

describe('planRefresh', () => {
  const eik = hex('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
  const NOW = 1700005000 + REFRESH_BACKDATE_SECONDS; // so startDate == golden START_DATE

  it('includes only MCU devices we track, building one batched upload frame', () => {
    const devices = [
      device('cid-mcu', true, eik, 1700000000),
      device('cid-phone', false, eik, 1700000000), // not MCU → skip
      device('cid-untracked', true, eik, 1700000000), // MCU but not tracked → skip
    ];
    const tracked = new Set(['cid-mcu', 'cid-untracked'].slice(0, 1)); // only cid-mcu
    const plan = planRefresh(devices, tracked, OWNER_KEY, NOW);

    expect(plan.refreshedCanonicIds).toEqual(['cid-mcu']);
    expect(plan.failures).toHaveLength(0);
    expect(plan.frame).not.toBeNull();

    // The frame decodes to exactly one device with the full 4-day window.
    const top = decodeMessage(plan.frame!.subarray(5)); // strip gRPC 5-byte prefix
    const devs = getMessages(top, 1);
    expect(devs).toHaveLength(1);
    expect(getString(getMessage(devs[0], 1)!, 1)).toBe('cid-mcu');
    const infos = getMessages(getMessage(devs[0], 2)!, 1);
    expect(infos).toHaveLength(339); // golden full-window bucket count
  });

  it('records an undecryptable EIK as a failure and excludes it', () => {
    const bad = device('cid-bad', true, eik, 1700000000);
    bad.registration.encryptedIdentityKey = new Uint8Array(60).fill(5); // garbage
    const plan = planRefresh([bad], new Set(['cid-bad']), OWNER_KEY, NOW);
    expect(plan.frame).toBeNull();
    expect(plan.refreshedCanonicIds).toHaveLength(0);
    expect(plan.failures.map((f) => f.canonicId)).toEqual(['cid-bad']);
  });

  it('returns a null frame when nothing is eligible', () => {
    const plan = planRefresh([device('x', false, eik, 1)], new Set(['x']), OWNER_KEY, NOW);
    expect(plan.frame).toBeNull();
    expect(plan.refreshedCanonicIds).toHaveLength(0);
  });
});

describe('parseRelayResponse', () => {
  it('treats ok:true as success and surfaces the gRPC fields', () => {
    const r = parseRelayResponse(
      JSON.stringify({ http_status: 200, grpc_status: '0', grpc_message: null, body_hex: '', ok: true }),
    );
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.grpcStatus).toBe('0');
  });

  it('treats a gRPC error (ok:false) as failure', () => {
    const r = parseRelayResponse(
      JSON.stringify({ http_status: 200, grpc_status: '7', grpc_message: 'permission denied', ok: false }),
    );
    expect(r.ok).toBe(false);
    expect(r.grpcMessage).toBe('permission denied');
  });

  it('treats an {error} envelope (e.g. no token) as failure', () => {
    const r = parseRelayResponse(JSON.stringify({ error: 'no token' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no token');
  });

  it('treats non-JSON as failure without throwing', () => {
    const r = parseRelayResponse('<html>502</html>');
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
});

describe('EID-window status helpers (for /sources)', () => {
  const DAY = 24 * 3600 * 1000;
  const t0 = 1_700_000_000_000;

  it('validUntil is last refresh + 4 days', () => {
    expect(eidWindowValidUntilMs(t0)).toBe(t0 + 4 * DAY);
    expect(eidWindowValidUntilMs(t0)).toBe(t0 + MAX_TRUNCATED_EID_SECONDS_SERVER * 1000);
  });

  it('never-refreshed (null) is stale', () => {
    expect(isEidWindowStale(null, t0)).toBe(true);
  });

  it('just-refreshed is fresh; past-expiry is stale', () => {
    expect(isEidWindowStale(t0, t0 + 1 * DAY)).toBe(false);
    expect(isEidWindowStale(t0, t0 + 5 * DAY)).toBe(true);
  });

  it('flags stale within the default 24h margin before the 4-day cliff', () => {
    expect(isEidWindowStale(t0, t0 + 2.5 * DAY)).toBe(false); // >1d of window left
    expect(isEidWindowStale(t0, t0 + 3.5 * DAY)).toBe(true); // <1d left → warn early
  });
});

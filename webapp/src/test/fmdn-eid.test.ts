// EID generator behaviour (no fixed Python vector here — the upstream example
// uses a private sample key — so we assert the structural + windowing
// properties that the curve/calculate_r parity tests already anchor).

import { describe, it, expect } from 'vitest';
import { generateEid, getNextEids, ROTATION_PERIOD } from '../lib/fmdn/eid';

function hex(h: string): Uint8Array {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
}
function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

const EIK = hex('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899');

describe('generateEid', () => {
  it('produces a 20-byte EID', () => {
    expect(generateEid(EIK, 0).length).toBe(20);
  });
  it('is constant within one rotation window (low 10 bits masked)', () => {
    expect(toHex(generateEid(EIK, 0))).toBe(toHex(generateEid(EIK, ROTATION_PERIOD - 1)));
  });
  it('changes across rotation windows', () => {
    expect(toHex(generateEid(EIK, 0))).not.toBe(toHex(generateEid(EIK, ROTATION_PERIOD)));
  });
});

describe('getNextEids', () => {
  it('aligns buckets to ROTATION_PERIOD and steps by it', () => {
    const eids = getNextEids(EIK, 5000, 3);
    expect(eids).toHaveLength(3);
    expect(eids[0].timestampSeconds).toBe(5000 - (5000 % ROTATION_PERIOD));
    expect(eids[1].timestampSeconds - eids[0].timestampSeconds).toBe(ROTATION_PERIOD);
    expect(eids[0].truncatedEid.length).toBe(10);
  });
  it('static slot-0 maps every bucket to the same truncated EID', () => {
    const eids = getNextEids(EIK, 0, 4, { staticSlot0: true });
    const slot0 = toHex(generateEid(EIK, 0).subarray(0, 10));
    for (const e of eids) expect(toHex(e.truncatedEid)).toBe(slot0);
  });
  it('rotating mode gives distinct truncated EIDs per window', () => {
    const eids = getNextEids(EIK, 0, 3);
    const set = new Set(eids.map((e) => toHex(e.truncatedEid)));
    expect(set.size).toBe(3);
  });
});

// DeviceUpdate parsing + report routing parity (api.rs / fcm.rs).

import { describe, it, expect } from 'vitest';
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { PbWriter } from '../lib/fmdn/protobuf';
import {
  parseDeviceUpdate,
  parseDevices,
  routeReport,
  STATUS,
  type EncryptedReport,
} from '../lib/fmdn/report';

function hex(h: string): Uint8Array {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
}
function cat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
/** Raw protobuf float field (wire type 5, little-endian) — for GeoLocation.accuracy. */
function floatField(field: number, v: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = (field << 3) | 5;
  new DataView(out.buffer).setFloat32(1, v, true);
  return out;
}

/** Build a DeviceMetadata with one semantic recent + one crowdsourced network
 *  report, for an MCU device. */
function buildDeviceMetadata(): Uint8Array {
  const canonicId = new PbWriter().string(1, 'abc-canonic').finish();
  const canonicIds = new PbWriter().message(1, canonicId).finish();
  const idInfo = new PbWriter().int(2, 2 /* SPOT */).message(3, canonicIds).finish();

  const eus = new PbWriter().bytesField(1, new Uint8Array(60).fill(0xaa)).int(3, 1).finish();
  const registration = new PbWriter()
    .message(19, eus)
    .string(21, '003200' /* MCU */)
    .int(23, 1_690_000_000 /* pairDate */)
    .finish();

  // semantic recentLocation
  const sem = new PbWriter().string(1, 'Home').finish();
  const recentLoc = new PbWriter().message(5, sem).int(11, STATUS.SEMANTIC).finish();
  const recentTime = new PbWriter().int(1, 1_700_000_500).finish();

  // crowdsourced networkLocation (geo)
  const encReport = new PbWriter()
    .bytesField(1, hex('aabb')) // publicKeyRandom
    .bytesField(2, hex('beef')) // encryptedLocation
    .bool(3, false)
    .finish();
  const geo = cat(new PbWriter().message(1, encReport).int(2, 42).finish(), floatField(3, 12.5));
  const netLoc = new PbWriter().message(10, geo).int(11, STATUS.CROWDSOURCED).finish();
  const netTime = new PbWriter().int(1, 1_699_999_000).finish();

  const ranl = new PbWriter()
    .message(1, recentLoc)
    .message(2, recentTime)
    .message(5, netLoc)
    .message(6, netTime)
    .finish();
  const reports = new PbWriter().message(4, ranl).finish();
  const locationInformation = new PbWriter().message(3, reports).finish();
  const information = new PbWriter().message(1, registration).message(2, locationInformation).finish();

  return new PbWriter()
    .message(1, idInfo)
    .message(4, information)
    .string(5, 'Backpack')
    .finish();
}

/** Wrap a DeviceMetadata as a DeviceUpdate (field 3). */
function wrapDeviceUpdate(md: Uint8Array): Uint8Array {
  return new PbWriter().message(3, md).finish();
}

describe('parseDeviceUpdate', () => {
  it('extracts canonicId, MCU flag, and both reports (network then recent)', () => {
    const entry = parseDeviceUpdate(wrapDeviceUpdate(buildDeviceMetadata()));
    expect(entry).not.toBeNull();
    expect(entry!.canonicId).toBe('abc-canonic');
    expect(entry!.displayName).toBe('Backpack');
    expect(entry!.registration.isMcu).toBe(true);
    expect(entry!.registration.encryptedIdentityKey.length).toBe(60);
    expect(entry!.registration.pairDate).toBe(1_690_000_000);
    expect(entry!.reports).toHaveLength(2);

    const net = entry!.reports[0];
    expect(net.status).toBe(STATUS.CROWDSOURCED);
    expect(Array.from(net.publicKeyRandom)).toEqual([0xaa, 0xbb]);
    expect(Array.from(net.encryptedLocation)).toEqual([0xbe, 0xef]);
    expect(net.isOwnReport).toBe(false);
    expect(net.accuracyM).toBeCloseTo(12.5, 5);
    expect(net.deviceTimeOffset).toBe(42);
    expect(net.receivedAtUnixS).toBe(1_699_999_000);

    const rec = entry!.reports[1];
    expect(rec.status).toBe(STATUS.SEMANTIC);
    expect(rec.semanticLabel).toBe('Home');
    expect(rec.isOwnReport).toBe(true);
    expect(rec.receivedAtUnixS).toBe(1_700_000_500);
  });

  it('returns null for a non-actionable update (no deviceMetadata)', () => {
    expect(parseDeviceUpdate(new PbWriter().int(99, 1).finish())).toBeNull();
  });
});

describe('parseDevices (ListDevices response → registration + reports)', () => {
  it('maps each DevicesList.deviceMetadata (field 2) to a DeviceEntry', () => {
    const md = buildDeviceMetadata();
    const resp = new PbWriter().message(2, md).message(2, md).finish();
    const entries = parseDevices(resp);
    expect(entries).toHaveLength(2);
    expect(entries[0].canonicId).toBe('abc-canonic');
    expect(entries[0].registration.isMcu).toBe(true);
    expect(entries[0].registration.encryptedIdentityKey.length).toBe(60);
    expect(entries[0].registration.pairDate).toBe(1_690_000_000);
    expect(entries[0].reports).toHaveLength(2);
  });

  it('skips non-SPOT / registration-less rows', () => {
    const phone = new PbWriter()
      .message(1, new PbWriter().int(2, 1 /* ANDROID */).finish())
      .string(5, 'Pixel')
      .finish();
    expect(parseDevices(new PbWriter().message(2, phone).finish())).toHaveLength(0);
  });
});

describe('routeReport', () => {
  const semantic: EncryptedReport = {
    receivedAtUnixS: 1_700_000_000,
    status: STATUS.SEMANTIC,
    isOwnReport: true,
    semanticLabel: 'Home',
    encryptedLocation: new Uint8Array(0),
    publicKeyRandom: new Uint8Array(0),
    accuracyM: 0,
    deviceTimeOffset: 0,
  };

  it('routes a semantic report to a label-only row', () => {
    const r = routeReport(semantic, undefined, true);
    expect(r.semanticLabel).toBe('Home');
    expect(r.latitude).toBeNull();
    expect(r.longitude).toBeNull();
    expect(r.accuracyM).toBeNull();
  });

  it('decrypts an own report (empty publicKeyRandom)', () => {
    const eik = new Uint8Array(32).fill(0x37);
    const plain = new PbWriter().fixed32(1, 377_749_000).fixed32(2, -1_224_194_000).int(3, 15).finish();
    const iv = new Uint8Array(12).fill(0x05);
    const ctTag = gcm(sha256(eik), iv).encrypt(plain);
    const report: EncryptedReport = {
      receivedAtUnixS: 1_700_000_500,
      status: STATUS.LAST_KNOWN,
      isOwnReport: true,
      semanticLabel: null,
      encryptedLocation: cat(iv, ctTag),
      publicKeyRandom: new Uint8Array(0),
      accuracyM: 12,
      deviceTimeOffset: 0,
    };
    const r = routeReport(report, eik, true);
    expect(r.isOwnReport).toBe(true);
    expect(r.latitude).toBeCloseTo(37.7749, 9);
    expect(r.longitude).toBeCloseTo(-122.4194, 9);
    expect(r.altitudeM).toBe(15);
    expect(r.accuracyM).toBe(12);
  });

  it('decrypts a foreign report (non-MCU uses deviceTimeOffset)', () => {
    const eik = hex('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899');
    const report: EncryptedReport = {
      receivedAtUnixS: 1_700_000_000,
      status: STATUS.CROWDSOURCED,
      isOwnReport: false,
      semanticLabel: null,
      encryptedLocation: hex('358d966e689af0b0f3199fa43885c01862fbab8fd6bc1bbccd769b89'),
      publicKeyRandom: hex('dde7ecd33c015ba08035f8fa977bc8b2bc8387be'),
      accuracyM: 50,
      deviceTimeOffset: 0x0084d000,
    };
    const r = routeReport(report, eik, false);
    expect(r.isOwnReport).toBe(false);
    expect(r.latitude).toBeCloseTo(37.7749, 9);
    expect(r.longitude).toBeCloseTo(-122.4194, 9);
    expect(r.accuracyM).toBe(50);
  });

  it('throws when a non-semantic report has no EIK', () => {
    const report = { ...semantic, status: STATUS.LAST_KNOWN, semanticLabel: null };
    expect(() => routeReport(report, undefined, true)).toThrow(/EIK/);
  });
});

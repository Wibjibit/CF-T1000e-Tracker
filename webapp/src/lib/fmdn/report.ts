// FMDN location-report decryption + the DeviceUpdate protobuf walker.
//
// TS parity port of `desktop-app/src/crypto.rs` (own/foreign decrypt),
// `api.rs::convert_device_metadata` (DeviceMetadata → reports) and
// `fcm.rs::route_report` (status/shape routing). See docs/desktop-app-crypto.md.
//
// Three report shapes, picked by status + publicKeyRandom:
//   - Semantic   (status==SEMANTIC)          → plaintext label, no decryption.
//   - Own-report (non-semantic, no pkRandom) → AES-256-GCM, key = SHA256(EIK).
//   - Foreign    (non-semantic, pkRandom)    → SECP160R1 ECIES + AES-EAX-256.

import { cmac, ctr } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  decodeMessage,
  getString,
  getBytes,
  getVarint,
  getMessage,
  getMessages,
  readSfixed32,
  type Field,
} from './protobuf';
import { aesGcmDecrypt } from './eik';
import {
  calculateR,
  scalarMulG,
  scalarMulPointX,
  rxToRy,
  bytesToBigIntBE,
  bigIntToBytesBE,
} from './secp160r1';

// `Common.proto:Status`.
export const STATUS = { SEMANTIC: 0, LAST_KNOWN: 1, CROWDSOURCED: 2, AGGREGATED: 3 } as const;

/** Fast Pair model id for the MCU/dev-kit firmware (needs flip_bits + offset 0). */
const MCU_FAST_PAIR_MODEL_ID = '003200';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One decoded location point (own/foreign share this shape). */
export interface DecryptedLocation {
  latitude: number;
  longitude: number;
  altitudeM: number;
}

/** One encrypted location report extracted from a DeviceUpdate / ListDevices. */
export interface EncryptedReport {
  receivedAtUnixS: number;
  status: number;
  isOwnReport: boolean;
  semanticLabel: string | null;
  encryptedLocation: Uint8Array;
  publicKeyRandom: Uint8Array;
  accuracyM: number;
  deviceTimeOffset: number;
}

/** Material the crypto layer needs to decrypt a device's reports. */
export interface DeviceRegistrationInfo {
  encryptedIdentityKey: Uint8Array;
  ownerKeyVersion: number;
  isMcu: boolean;
  /** Unix seconds the device was paired. Anchors the Phase 4 EID-refresh
   *  window (`get_next_eids` aligns buckets to this, not to 0). 0 if absent. */
  pairDate: number;
}

/** A parsed DeviceMetadata (from a DeviceUpdate push or a ListDevices row). */
export interface DeviceEntry {
  canonicId: string;
  displayName: string;
  registration: DeviceRegistrationInfo;
  reports: EncryptedReport[];
}

/** A report after routing/decryption, in the flat shape a `reports` row wants. */
export interface RoutedReport {
  receivedAtUnixS: number;
  status: number;
  isOwnReport: boolean;
  latitude: number | null;
  longitude: number | null;
  altitudeM: number | null;
  accuracyM: number | null;
  semanticLabel: string | null;
}

// ---------------------------------------------------------------------------
// Location protobuf
// ---------------------------------------------------------------------------

/**
 * Decode a `Location { sfixed32 latitude=1; sfixed32 longitude=2; int32
 * altitude=3 }`. lat/lon are in 1e7 units on the wire; scaled to degrees here.
 * Unknown fields are skipped (forward-compat). Throws if lat or lon is missing.
 */
export function decodeLocation(bytes: Uint8Array): DecryptedLocation {
  const m = decodeMessage(bytes);
  const latF = m.get(1)?.[0];
  const lonF = m.get(2)?.[0];
  if (!latF || latF.wireType !== 5 || !(latF.value instanceof Uint8Array)) {
    throw new Error('Location proto missing latitude (field 1, sfixed32)');
  }
  if (!lonF || lonF.wireType !== 5 || !(lonF.value instanceof Uint8Array)) {
    throw new Error('Location proto missing longitude (field 2, sfixed32)');
  }
  const latE7 = readSfixed32(latF.value);
  const lonE7 = readSfixed32(lonF.value);
  const altitudeM = (getVarint(m, 3) ?? 0) | 0; // int32 (default 0 if absent)
  return { latitude: latE7 / 1e7, longitude: lonE7 / 1e7, altitudeM };
}

// ---------------------------------------------------------------------------
// Own-report decryption
// ---------------------------------------------------------------------------

/**
 * Decrypt an "own report" (uploaded by one of the owner's trusted devices).
 * Key = SHA-256(EIK) → AES-256-GCM over `[12-byte IV][ciphertext][16-byte tag]`.
 */
export function decryptOwnReport(eik: Uint8Array, encryptedLocation: Uint8Array): DecryptedLocation {
  const key = sha256(eik); // 32 bytes → AES-256-GCM
  const plaintext = aesGcmDecrypt(key, encryptedLocation);
  return decodeLocation(plaintext);
}

// ---------------------------------------------------------------------------
// Foreign-report decryption (SECP160R1 ECIES + AES-EAX-256)
// ---------------------------------------------------------------------------

/**
 * Decrypt a "foreign report" (contributed by a stranger's Android phone that
 * scanned the beacon). ECIES over SECP160R1:
 *   r = calculate_r(eik, deviceTimeOffset);  R = r·G
 *   S = (Sx, rxToRy(Sx)) from publicKeyRandom;  shared = r·S
 *   k = HKDF-SHA256(shared.x as 20 BE bytes, salt=∅, info=∅, 32)
 *   nonce = R.x[12..] || S.x[12..]  (lower 8 bytes of each 20-byte coord)
 *   plaintext = AES-EAX-256-decrypt(k, nonce, m', tag)  where input = m'||tag(16)
 *
 * `deviceTimeOffset` is the beacon time counter (0 for MCU/dev-kit trackers).
 */
export function decryptForeignReport(
  eik: Uint8Array,
  encryptedLocation: Uint8Array,
  publicKeyRandom: Uint8Array,
  deviceTimeOffset: number,
): DecryptedLocation {
  if (encryptedLocation.length < 16) {
    throw new Error(
      `decryptForeignReport: encrypted_location length ${encryptedLocation.length} < 16 (no tag)`,
    );
  }
  if (publicKeyRandom.length === 0 || publicKeyRandom.length > 20) {
    throw new Error(
      `decryptForeignReport: public_key_random length ${publicKeyRandom.length} (want 1..20)`,
    );
  }
  const split = encryptedLocation.length - 16;
  const mDash = encryptedLocation.subarray(0, split);
  const tag = encryptedLocation.subarray(split);

  const r = calculateR(eik, deviceTimeOffset);
  const R = scalarMulG(r);
  const sx = bytesToBigIntBE(publicKeyRandom);
  const sy = rxToRy(sx);
  const sharedX = scalarMulPointX(sx, sy, r);

  const k = hkdf(sha256, bigIntToBytesBE(sharedX, 20), undefined, new Uint8Array(0), 32);

  const rx20 = bigIntToBytesBE(R.x, 20);
  const sx20 = bigIntToBytesBE(sx, 20);
  const nonce = new Uint8Array(16);
  nonce.set(rx20.subarray(12), 0);
  nonce.set(sx20.subarray(12), 8);

  const plaintext = aesEaxDecrypt(k, nonce, mDash, tag);
  return decodeLocation(plaintext);
}

// ---------------------------------------------------------------------------
// AES-EAX-256 (CTR + OMAC/CMAC) — @noble has no EAX, so build it from cmac+ctr.
// ---------------------------------------------------------------------------

/** OMAC^t(msg) = CMAC(key, [t as 16-byte block] || msg). */
function omac(key: Uint8Array, t: number, msg: Uint8Array): Uint8Array {
  const input = new Uint8Array(16 + msg.length);
  input[15] = t; // 15 zero bytes then the tag-distinguishing byte
  input.set(msg, 16);
  return cmac(input, key);
}

/**
 * AES-EAX decrypt with empty associated data (the FMDN convention). Verifies
 * the tag, then CTR-decrypts with the nonce-OMAC as the initial counter block.
 * Throws on tag mismatch.
 */
function aesEaxDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Uint8Array {
  const n = omac(key, 0, nonce);
  const h = omac(key, 1, new Uint8Array(0)); // OMAC of empty AAD
  const c = omac(key, 2, ciphertext);

  const expected = new Uint8Array(16);
  for (let i = 0; i < 16; i++) expected[i] = n[i] ^ h[i] ^ c[i];

  let diff = tag.length === 16 ? 0 : 1;
  for (let i = 0; i < 16; i++) diff |= expected[i] ^ tag[i];
  if (diff !== 0) throw new Error('AES-EAX-256 decrypt failed: tag mismatch');

  // CTR with the full 16-byte N as the starting counter (standard EAX).
  return ctr(key, n).decrypt(ciphertext);
}

// ---------------------------------------------------------------------------
// DeviceUpdate / DeviceMetadata walker (field numbers per proto/DeviceUpdate.proto)
// ---------------------------------------------------------------------------

/**
 * Parse a `DeviceUpdate` (the FCM push body, after ECE-unwrap + base64-decode of
 * the FCM_PAYLOAD) into a DeviceEntry, or null for a non-actionable update.
 * DeviceUpdate.deviceMetadata is field 3. (A ListDevices row is a DeviceMetadata
 * directly — pass it to [`parseDeviceMetadata`].)
 */
export function parseDeviceUpdate(bytes: Uint8Array): DeviceEntry | null {
  const update = decodeMessage(bytes);
  const md = getMessage(update, 3); // DeviceUpdate.deviceMetadata
  if (!md) return null;
  return parseDeviceMetadata(md);
}

/**
 * Parse a `DevicesList` response (the ListDevices reply) into DeviceEntries —
 * each carrying the encrypted registration the poller needs to build its EIK
 * cache. `DevicesList.deviceMetadata` is the repeated field 2. (nova.ts's
 * `parseDeviceList` is the lighter catalog-only parse; this one keeps the
 * registration + reports.)
 */
export function parseDevices(resp: Uint8Array): DeviceEntry[] {
  const out: DeviceEntry[] = [];
  for (const md of getMessages(decodeMessage(resp), 2)) {
    const entry = parseDeviceMetadata(md);
    if (entry) out.push(entry);
  }
  return out;
}

/** Convert one decoded DeviceMetadata message into a DeviceEntry, or null. */
export function parseDeviceMetadata(md: Map<number, Field[]>): DeviceEntry | null {
  // identifierInformation (1): type(2)==SPOT(2); canonicIds(3).canonicId(1).id(1)
  const idInfo = getMessage(md, 1);
  if (!idInfo) return null;
  const idType = getVarint(idInfo, 2) ?? 0;
  if (idType !== 2) return null; // only SPOT devices are actionable here
  const canonicIds = getMessage(idInfo, 3);
  const cidMsg = canonicIds ? getMessage(canonicIds, 1) : undefined;
  const canonicId = cidMsg ? getString(cidMsg, 1) : undefined;
  if (!canonicId) return null;

  const displayName = getString(md, 5) ?? '';

  // information(4).deviceRegistration(1).encryptedUserSecrets(19)
  const information = getMessage(md, 4);
  if (!information) return null;
  const registrationProto = getMessage(information, 1);
  if (!registrationProto) return null;
  const eus = getMessage(registrationProto, 19);
  if (!eus) return null;

  const fastPairModelId = getString(registrationProto, 21) ?? '';
  const registration: DeviceRegistrationInfo = {
    encryptedIdentityKey: getBytes(eus, 1) ?? new Uint8Array(0),
    ownerKeyVersion: getVarint(eus, 3) ?? 0,
    isMcu: fastPairModelId === MCU_FAST_PAIR_MODEL_ID,
    pairDate: getVarint(registrationProto, 23) ?? 0, // DeviceRegistration.pairDate
  };

  // information(4).locationInformation(2).reports(3).recentLocationAndNetworkLocations(4)
  const reports = extractReports(getMessage(getMessage(getMessage(information, 2) ?? new Map(), 3) ?? new Map(), 4));

  return { canonicId, displayName, registration, reports };
}

/** Flatten a RecentLocationAndNetworkLocations into EncryptedReport[]. */
function extractReports(wrap: Map<number, Field[]> | undefined): EncryptedReport[] {
  if (!wrap) return [];
  const out: EncryptedReport[] = [];

  // networkLocations(5) zipped with networkLocationTimestamps(6), then the
  // recentLocation(1)/recentLocationTimestamp(2) pair appended (matches api.rs).
  const netLocs = getMessages(wrap, 5);
  const netTimes = getMessages(wrap, 6);
  const n = Math.min(netLocs.length, netTimes.length);
  for (let i = 0; i < n; i++) {
    const r = convertLocationReport(netLocs[i], netTimes[i]);
    if (r) out.push(r);
  }
  const recentLoc = getMessage(wrap, 1);
  const recentTime = getMessage(wrap, 2);
  if (recentLoc && recentTime) {
    const r = convertLocationReport(recentLoc, recentTime);
    if (r) out.push(r);
  }
  return out;
}

/** LocationReport(+Time) → EncryptedReport. Time.seconds is field 1. */
function convertLocationReport(
  loc: Map<number, Field[]>,
  time: Map<number, Field[]>,
): EncryptedReport | null {
  const receivedAtUnixS = getVarint(time, 1) ?? 0;
  const status = getVarint(loc, 11) ?? 0; // LocationReport.status

  if (status === STATUS.SEMANTIC) {
    const sem = getMessage(loc, 5); // semanticLocation
    return {
      receivedAtUnixS,
      status,
      isOwnReport: true, // semantic reports originate from the owner's phone
      semanticLabel: sem ? (getString(sem, 1) ?? null) : null,
      encryptedLocation: new Uint8Array(0),
      publicKeyRandom: new Uint8Array(0),
      accuracyM: 0,
      deviceTimeOffset: 0,
    };
  }

  const geo = getMessage(loc, 10); // geoLocation
  if (!geo) return null;
  const enc = getMessage(geo, 1); // encryptedReport
  if (!enc) return null;

  const accF = geo.get(3)?.[0];
  const accuracyM =
    accF && accF.value instanceof Uint8Array && accF.wireType === 5
      ? new DataView(accF.value.buffer, accF.value.byteOffset, 4).getFloat32(0, true)
      : 0;

  return {
    receivedAtUnixS,
    status,
    isOwnReport: (getVarint(enc, 3) ?? 0) !== 0,
    semanticLabel: null,
    encryptedLocation: getBytes(enc, 2) ?? new Uint8Array(0),
    publicKeyRandom: getBytes(enc, 1) ?? new Uint8Array(0),
    accuracyM,
    deviceTimeOffset: getVarint(geo, 2) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Routing (mirrors fcm.rs::route_report, minus the DB write)
// ---------------------------------------------------------------------------

/**
 * Route + decrypt one report into a flat RoutedReport. Mirrors
 * `fcm.rs::route_report`:
 *   - Semantic → label-only (no lat/lon), no EIK needed.
 *   - Own (empty publicKeyRandom) → decrypt with `eik` (throws if missing).
 *   - Foreign (non-empty) → SECP160R1 ECIES; deviceTimeOffset forced to 0 for MCU.
 * Decryption failures throw — the caller logs/skips (Google re-pushes).
 */
export function routeReport(
  report: EncryptedReport,
  eik: Uint8Array | undefined,
  isMcu: boolean,
): RoutedReport {
  const base = {
    receivedAtUnixS: report.receivedAtUnixS,
    status: report.status,
    accuracyM: report.accuracyM > 0 ? report.accuracyM : null,
  };

  if (report.status === STATUS.SEMANTIC) {
    return {
      ...base,
      accuracyM: null,
      isOwnReport: report.isOwnReport,
      latitude: null,
      longitude: null,
      altitudeM: null,
      semanticLabel: report.semanticLabel,
    };
  }

  if (report.publicKeyRandom.length === 0) {
    if (!eik) throw new Error('routeReport: own-report needs an EIK (not in cache yet)');
    const loc = decryptOwnReport(eik, report.encryptedLocation);
    return {
      ...base,
      isOwnReport: true,
      latitude: loc.latitude,
      longitude: loc.longitude,
      altitudeM: loc.altitudeM,
      semanticLabel: null,
    };
  }

  if (!eik) throw new Error('routeReport: foreign-report needs an EIK (not in cache yet)');
  const offset = isMcu ? 0 : report.deviceTimeOffset;
  const loc = decryptForeignReport(eik, report.encryptedLocation, report.publicKeyRandom, offset);
  return {
    ...base,
    isOwnReport: false,
    latitude: loc.latitude,
    longitude: loc.longitude,
    altitudeM: loc.altitudeM,
    semanticLabel: null,
  };
}

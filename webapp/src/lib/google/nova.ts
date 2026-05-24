// Google Nova HTTP API (read path) — plain HTTPS POST of raw protobuf bodies.
//
// Three calls the Find Hub poller needs:
//   - novaPost            — POST a protobuf body to a Nova scope with the ADM token.
//   - buildDevicesListRequest / parseDeviceList — ListDevices (catalog + each
//     device's encrypted registration).
//   - buildLocateTrackerRequest — fire-and-forget; tells Google to push a
//     DeviceUpdate back over our MCS socket (gcmRegistrationId = our FCM token).
//
// Ported from GoogleFindMyTools NovaApi/* and the desktop-app api.rs; lifted
// from `spike/findhub-mcs/src/nova.ts`.

import { PbWriter, decodeMessage, getString, getMessage, getMessages, getBytes } from '../fmdn/protobuf';

const NOVA_BASE = 'https://android.googleapis.com/nova/';

/** POST a raw protobuf body to a Nova endpoint with the ADM bearer token. */
export async function novaPost(admToken: string, scope: string, body: Uint8Array): Promise<Uint8Array> {
  const res = await fetch(NOVA_BASE + scope, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + admToken,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept-Language': 'en-US',
      'User-Agent': 'fmd/20006320; gzip',
    },
    // Copy into a fresh ArrayBuffer-backed view: the Workers `fetch` BodyInit
    // rejects `Uint8Array<ArrayBufferLike>` (TS 5.7+ distinguishes it from
    // `Uint8Array<ArrayBuffer>`), and PbWriter outputs are small.
    body: Uint8Array.from(body),
  });
  if (!res.status.toString().startsWith('2')) {
    const t = await res.text();
    throw new Error(`Nova ${scope} HTTP ${res.status}: ${t.slice(0, 160)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** DevicesListRequest { 1: payload { 1: type=SPOT_DEVICE(2), 3: id=uuid } } */
export function buildDevicesListRequest(): Uint8Array {
  const payload = new PbWriter().int(1, 2).string(3, crypto.randomUUID()).finish();
  return new PbWriter().message(1, payload).finish();
}

export interface DeviceEntry {
  name: string;
  canonicId: string;
  idType: number; // IdentifierInformationType: 1=ANDROID, 2=SPOT
}

/**
 * Parse a DevicesList response -> [{name, canonicId, idType}]. Walks
 * DevicesList.deviceMetadata(2) -> identifierInformation(1) -> the canonicIds,
 * which live at field 3 for SPOT devices and nested under phoneInformation(1)
 * for phones. (Registration/EIK extraction lives in lib/fmdn/report.ts via the
 * shared DeviceMetadata walker — this lighter parse is for the catalog only.)
 */
export function parseDeviceList(resp: Uint8Array): DeviceEntry[] {
  const top = decodeMessage(resp);
  const out: DeviceEntry[] = [];
  for (const md of getMessages(top, 2)) {
    const name = getString(md, 5) ?? '(unnamed)';
    const idInfo = getMessage(md, 1);
    if (!idInfo) continue;
    const idType = Number(idInfo.get(2)?.[0]?.value ?? 0n);
    // SPOT: canonicIds at field 3; phones nest under phoneInformation (field 1).
    const canonicIds = getMessage(idInfo, 3) ?? getMessage(getMessage(idInfo, 1) ?? new Map(), 2);
    if (!canonicIds) continue;
    const cidMsg = getMessage(canonicIds, 1);
    if (!cidMsg) continue;
    const cid = getString(cidMsg, 1);
    if (cid) out.push({ name, canonicId: cid, idType });
  }
  return out;
}

/**
 * ExecuteActionRequest for LocateTracker. Mirrors nbe_execute_action.py +
 * location_request.py. gcmRegistrationId = our FCM token, so Google pushes the
 * resulting DeviceUpdate back over our MCS connection.
 */
export function buildLocateTrackerRequest(canonicId: string, fcmToken: string): Uint8Array {
  // scope { 2: type=SPOT(2), 3: device { 1: canonicId { 1: id } } }
  const canonic = new PbWriter().string(1, canonicId).finish();
  const device = new PbWriter().message(1, canonic).finish();
  const scope = new PbWriter().int(2, 2).message(3, device).finish();

  // action { 30: locateTracker { 2: time{1: seconds}, 3: contributorType=FMDN_ALL_LOCATIONS(2) } }
  const time = new PbWriter().int(1, 1732120060).finish();
  const locate = new PbWriter().message(2, time).int(3, 2).finish();
  const action = new PbWriter().message(30, locate).finish();

  // requestMetadata { 1: type=SPOT(2), 2: requestUuid, 3: fmdClientUuid, 4: gcm{1: token}, 6: unknown=true }
  const gcm = new PbWriter().string(1, fcmToken).finish();
  const meta = new PbWriter()
    .int(1, 2)
    .string(2, crypto.randomUUID())
    .string(3, crypto.randomUUID())
    .message(4, gcm)
    .bool(6, true)
    .finish();

  return new PbWriter().message(1, scope).message(2, action).message(3, meta).finish();
}

export { getBytes };

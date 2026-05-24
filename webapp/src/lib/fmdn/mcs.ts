// MCS (FCM `mtalk.google.com:5228`) wire framing + a stream FrameReader.
//
// MCS is Google's persistent push protocol — protobuf-over-TLS, NOT RFC XMPP.
// A fresh connection sends one version byte, then a stream of
// `[tag][varint len][payload]` frames. Lifted from the Phase 3.0 spike
// (`spike/findhub-mcs/src/{proto,index}.ts`), which proved a deployed Durable
// Object can open this socket and complete the FCM login on the real edge.
//
// This module is deliberately transport-agnostic: it owns framing + a reader
// over any `ReadableStream<Uint8Array>`, but does NOT import
// `cloudflare:sockets`. The actual `connect()` lives in the Phase 3.2 poller
// Durable Object, so these pure functions stay unit-testable under Node/vitest.

import { PbWriter, decodeMessage, encodeVarint, getString, getBytes, has, type Field } from './protobuf';

export const MCS_VERSION = 41;

/** MCS message tags (the first byte of every frame after the version byte). */
export const TAG = {
  HeartbeatPing: 0,
  HeartbeatAck: 1,
  LoginRequest: 2,
  LoginResponse: 3,
  Close: 4,
  IqStanza: 7,
  DataMessageStanza: 8,
} as const;

export function tagName(tag: number): string {
  for (const [k, v] of Object.entries(TAG)) if (v === tag) return k;
  return `tag(${tag})`;
}

/** Decimal android id string -> lowercase hex (BigInt avoids a Long dep). */
function androidIdHex(androidId: string): string {
  return BigInt(androidId).toString(16);
}

/**
 * First frame on a fresh MCS connection:
 *   [MCS_VERSION][LoginRequest tag] + varint(len) + LoginRequest payload.
 * Field numbers per mcs.proto LoginRequest. `persistentIds` are the
 * `received_persistent_id`s of already-acked pushes — sending them on login
 * stops MCS redelivering its backlog every connect (spike finding).
 */
export function buildLoginFrame(
  androidId: string,
  securityToken: string,
  persistentIds: string[] = [],
): Uint8Array {
  const lr = new PbWriter();
  lr.string(1, 'chrome-63.0.3234.0'); // id
  lr.string(2, 'mcs.android.com'); // domain
  lr.string(3, androidId); // user
  lr.string(4, androidId); // resource
  lr.string(5, securityToken); // auth_token
  lr.string(6, `android-${androidIdHex(androidId)}`); // device_id
  // setting (repeated message {1:name, 2:value}) = [{new_vc, 1}]
  const setting = new PbWriter().string(1, 'new_vc').string(2, '1').finish();
  lr.message(8, setting);
  for (const pid of persistentIds) lr.string(10, pid); // received_persistent_id
  lr.bool(12, false); // adaptive_heartbeat
  lr.bool(14, true); // use_rmq2
  lr.int(16, 2); // auth_service = ANDROID_ID
  lr.int(17, 1); // network_type
  const payload = lr.finish();

  const lenBytes = encodeVarint(payload.length);

  const frame = new Uint8Array(2 + lenBytes.length + payload.length);
  frame[0] = MCS_VERSION;
  frame[1] = TAG.LoginRequest;
  frame.set(lenBytes, 2);
  frame.set(payload, 2 + lenBytes.length);
  return frame;
}

/** HeartbeatAck frame: [tag] + varint(len) + payload({2: last_stream_id_received}). */
export function buildHeartbeatAckFrame(lastStreamIdReceived: number): Uint8Array {
  const payload = new PbWriter().int(2, lastStreamIdReceived).finish();
  const len = encodeVarint(payload.length);
  const frame = new Uint8Array(1 + len.length + payload.length);
  frame[0] = TAG.HeartbeatAck;
  frame.set(len, 1);
  frame.set(payload, 1 + len.length);
  return frame;
}

/** Decode an MCS LoginResponse error (field 3) into {code, message}, or null. */
export function loginError(payload: Uint8Array): { code: number; message?: string } | null {
  const m = decodeMessage(payload);
  if (!has(m, 3)) return null;
  const bytes = getBytes(m, 3);
  if (!bytes) return { code: -1 };
  const em = decodeMessage(bytes);
  return { code: Number(em.get(1)?.[0]?.value ?? -1n), message: getString(em, 2) };
}

// ---------------------------------------------------------------------------
// FrameReader — turn a byte stream into MCS frames
// ---------------------------------------------------------------------------

/** One parsed MCS frame off the wire. */
export interface McsFrame {
  tag: number;
  payload: Uint8Array;
}

/**
 * Stateful reader over a `ReadableStream<Uint8Array>` (the socket's
 * `.readable`). Buffers partial reads and yields whole frames. The caller is
 * responsible for consuming the leading version byte once per connection via
 * [`readByte`] before the first [`readFrame`].
 */
export class FrameReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(min: number): Promise<void> {
    while (this.buf.length < min) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error(`stream ended (have ${this.buf.length}, need ${min})`);
      const merged = new Uint8Array(this.buf.length + value.length);
      merged.set(this.buf);
      merged.set(value, this.buf.length);
      this.buf = merged;
    }
  }

  async readByte(): Promise<number> {
    await this.fill(1);
    const b = this.buf[0];
    this.buf = this.buf.slice(1);
    return b;
  }

  private async readVarint(): Promise<number> {
    let shift = 0;
    let result = 0;
    for (;;) {
      const b = await this.readByte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }

  private async readBytes(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  /** Read one whole `[tag][varint len][payload]` frame. */
  async readFrame(): Promise<McsFrame> {
    const tag = await this.readByte();
    const len = await this.readVarint();
    const payload = await this.readBytes(len);
    return { tag, payload };
  }

  /** Release the underlying stream lock (call before closing the socket). */
  releaseLock(): void {
    this.reader.releaseLock();
  }
}

export { decodeMessage, getString, getBytes, has };
export type { Field };

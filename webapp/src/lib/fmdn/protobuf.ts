// Minimal, dependency-free protobuf writer + generic decoder for the
// Workers/Durable-Object isolate.
//
// Why hand-rolled: protobufjs's reflection path generates encoder/decoder
// functions via `new Function`, which the Workers runtime forbids
// ("EvalError: Code generation from strings disallowed"). A tiny explicit
// reader/writer sidesteps that and also decodes arbitrary messages generically
// — which is exactly what the nested `DeviceUpdate` payload needs (see
// lib/fmdn/report.ts). Lifted verbatim-in-spirit from the Phase 3.0 spike
// (`spike/findhub-mcs/src/proto.ts`), with the MCS-framing bits split out into
// lib/fmdn/mcs.ts so this module stays pure data-codec.

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export class PbWriter {
  private bytes: number[] = [];

  private varint(v: number | bigint): void {
    let n = BigInt(v);
    if (n < 0n) n += 1n << 64n; // two's-complement for negatives (proto int32/64 sign-extend)
    do {
      let b = Number(n & 0x7fn);
      n >>= 7n;
      if (n > 0n) b |= 0x80;
      this.bytes.push(b);
    } while (n > 0n);
  }

  private tag(field: number, wireType: number): void {
    this.varint((field << 3) | wireType);
  }

  int(field: number, v: number | bigint): this {
    this.tag(field, 0);
    this.varint(v);
    return this;
  }

  bool(field: number, v: boolean): this {
    return this.int(field, v ? 1 : 0);
  }

  /** Little-endian fixed32 (wire type 5). Used for sfixed32 lat/lon. */
  fixed32(field: number, v: number): this {
    this.tag(field, 5);
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setInt32(0, v, true);
    for (const x of buf) this.bytes.push(x);
    return this;
  }

  string(field: number, s: string): this {
    return this.bytesField(field, new TextEncoder().encode(s));
  }

  bytesField(field: number, b: Uint8Array): this {
    this.tag(field, 2);
    this.varint(b.length);
    for (const x of b) this.bytes.push(x);
    return this;
  }

  message(field: number, sub: Uint8Array): this {
    return this.bytesField(field, sub);
  }

  finish(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** Bare-varint encoder (for length prefixes / MCS frame headers). */
export function encodeVarint(v: number): Uint8Array {
  const w = new PbWriter();
  // varint() is private; int(field=0) would prepend a tag byte, so reach in.
  (w as unknown as { varint(n: number): void }).varint(v);
  return w.finish();
}

// ---------------------------------------------------------------------------
// Generic reader — decode any message into fieldNumber -> Field[]
// ---------------------------------------------------------------------------

export interface Field {
  wireType: number;
  value: bigint | Uint8Array;
}

function readVarint(buf: Uint8Array, i: number): [bigint, number] {
  let shift = 0n;
  let result = 0n;
  for (;;) {
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, i];
}

export function decodeMessage(buf: Uint8Array): Map<number, Field[]> {
  const out = new Map<number, Field[]>();
  let i = 0;
  while (i < buf.length) {
    const [key, ni] = readVarint(buf, i);
    i = ni;
    const field = Number(key >> 3n);
    const wireType = Number(key & 7n);
    let value: bigint | Uint8Array;
    if (wireType === 0) {
      const [v, n2] = readVarint(buf, i);
      i = n2;
      value = v;
    } else if (wireType === 2) {
      const [len, n2] = readVarint(buf, i);
      i = n2;
      const l = Number(len);
      value = buf.slice(i, i + l);
      i += l;
    } else if (wireType === 5) {
      value = buf.slice(i, i + 4);
      i += 4;
    } else if (wireType === 1) {
      value = buf.slice(i, i + 8);
      i += 8;
    } else {
      throw new Error(`unsupported wireType ${wireType} at field ${field}`);
    }
    const arr = out.get(field);
    if (arr) arr.push({ wireType, value });
    else out.set(field, [{ wireType, value }]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed accessors over the decoded map
// ---------------------------------------------------------------------------

export function getString(m: Map<number, Field[]>, field: number): string | undefined {
  const f = m.get(field)?.[0];
  if (!f || !(f.value instanceof Uint8Array)) return undefined;
  return new TextDecoder().decode(f.value);
}

export function getBytes(m: Map<number, Field[]>, field: number): Uint8Array | undefined {
  const f = m.get(field)?.[0];
  return f && f.value instanceof Uint8Array ? f.value : undefined;
}

/** First varint value of a field, as a Number (callers know these fit). */
export function getVarint(m: Map<number, Field[]>, field: number): number | undefined {
  const f = m.get(field)?.[0];
  return f && typeof f.value === 'bigint' ? Number(f.value) : undefined;
}

/** Decode a length-delimited sub-message at `field` (first occurrence). */
export function getMessage(
  m: Map<number, Field[]>,
  field: number,
): Map<number, Field[]> | undefined {
  const b = getBytes(m, field);
  return b ? decodeMessage(b) : undefined;
}

/** All length-delimited sub-messages at a repeated `field`. */
export function getMessages(m: Map<number, Field[]>, field: number): Map<number, Field[]>[] {
  const fs = m.get(field) ?? [];
  const out: Map<number, Field[]>[] = [];
  for (const f of fs) if (f.value instanceof Uint8Array) out.push(decodeMessage(f.value));
  return out;
}

export function has(m: Map<number, Field[]>, field: number): boolean {
  return m.has(field);
}

/** Read a little-endian SIGNED fixed32 from a 4-byte wire-type-5 value. */
export function readSfixed32(value: Uint8Array): number {
  return new DataView(value.buffer, value.byteOffset, 4).getInt32(0, true);
}

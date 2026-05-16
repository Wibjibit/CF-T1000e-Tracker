// 26-byte v9 payload decoder. Mirrors decoder/ttn_decoder.js byte-for-byte —
// keep the two in lockstep when the payload format changes.
//
// See docs/payload.md for the field-by-field spec.

export const PAYLOAD_LENGTH = 26;

export interface Decoded {
  latitude: number | null;
  longitude: number | null;
  altitude_m: number;
  hdop: number;
  sats_tracked: number;
  sats_in_view: number;
  fix_quality: number;
  speed_kmh: number;
  uart_bytes_rx: number;
  uart_lines_parsed: number;
  battery_pct: number;
  battery_mv: number;
  temp_c: number;
  lux_pct: number;
  motion: boolean;
}

export type DecodeResult =
  | { ok: true; data: Decoded; warnings: string[] }
  | { ok: false; error: string };

function readUInt16BE(b: Uint8Array, off: number): number {
  return (b[off]! << 8) | b[off + 1]!;
}

function readInt16BE(b: Uint8Array, off: number): number {
  const v = readUInt16BE(b, off);
  return v & 0x8000 ? v - 0x10000 : v;
}

function readInt32BE(b: Uint8Array, off: number): number {
  // Force signed 32-bit interpretation via the |0 shift.
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) | 0;
}

export function decodeUplink(bytes: Uint8Array): DecodeResult {
  if (bytes.length !== PAYLOAD_LENGTH) {
    return { ok: false, error: `Expected ${PAYLOAD_LENGTH} bytes, got ${bytes.length}` };
  }

  const latRaw = readInt32BE(bytes, 0);
  const lonRaw = readInt32BE(bytes, 4);
  const fixQuality = bytes[13]!;
  const hasFix = fixQuality !== 0 && !(latRaw === 0 && lonRaw === 0);

  const data: Decoded = {
    latitude: hasFix ? latRaw / 1e6 : null,
    longitude: hasFix ? lonRaw / 1e6 : null,
    altitude_m: readInt16BE(bytes, 8),
    hdop: bytes[10]! / 10,
    sats_tracked: bytes[11]!,
    sats_in_view: bytes[12]!,
    fix_quality: fixQuality,
    speed_kmh: bytes[14]!,
    uart_bytes_rx: readUInt16BE(bytes, 15),
    uart_lines_parsed: readUInt16BE(bytes, 17),
    battery_pct: bytes[19]!,
    battery_mv: readUInt16BE(bytes, 20),
    temp_c: readInt16BE(bytes, 22) / 100,
    lux_pct: bytes[24]!,
    motion: (bytes[25]! & 0x01) === 0x01,
  };

  const warnings: string[] = [];
  if (data.battery_pct < 20) {
    warnings.push(`Low battery: ${data.battery_pct}% (${data.battery_mv} mV)`);
  }
  if (!hasFix) {
    if (data.uart_bytes_rx === 0) {
      warnings.push('UART RX dead - no bytes received from GPS chip');
    } else if (data.uart_lines_parsed === 0) {
      warnings.push(`UART receiving (${data.uart_bytes_rx} bytes) but no NMEA lines parsed`);
    } else if (data.sats_in_view === 0 && data.sats_tracked === 0) {
      warnings.push(`NMEA flowing (${data.uart_lines_parsed} lines) but chip reports no sats`);
    } else {
      warnings.push(`Chip sees ${data.sats_tracked || data.sats_in_view} sats, waiting for fix`);
    }
  }

  return { ok: true, data, warnings };
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

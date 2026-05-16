// RFC 4648 base32 (A-Z, 2-7). What Google Authenticator / Authy / 1Password
// expect when you paste a TOTP secret. Padding is allowed on decode and
// omitted on encode (matches `otpauth://` URI convention).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export function decodeBase32(input: string): Uint8Array {
  const s = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const idx = ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base32 character: ${c}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

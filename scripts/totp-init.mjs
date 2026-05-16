#!/usr/bin/env node
// One-shot helper: generate a 160-bit TOTP secret, encode it as base32, print
// the otpauth:// URI and an ASCII QR for your authenticator app, and remind
// you where to paste it.
//
// Usage:
//   npm run totp:init
//   npm run totp:init -- --label "tracker-prod" --issuer "wibjibit"

import crypto from 'node:crypto';
import qrcode from 'qrcode-terminal';

// --- argv parsing (intentionally tiny, no external dep) ---
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}
const label = arg('label', 'tracker');
const issuer = arg('issuer', 'CF-T1000e-Tracker');

// --- base32 (RFC 4648, no padding) ---
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function encodeBase32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

const secretBytes = crypto.randomBytes(20); // 160 bits, RFC 6238 recommended
const secretBase32 = encodeBase32(secretBytes);

const otpauth = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
  `?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

console.log('');
console.log('  Scan this QR with Google Authenticator / Authy / 1Password:');
console.log('');
qrcode.generate(otpauth, { small: true });
console.log('');
console.log(`  otpauth URI:  ${otpauth}`);
console.log(`  TOTP_SECRET:  ${secretBase32}`);
console.log('');
console.log('  Next steps:');
console.log('    1. Paste TOTP_SECRET into .dev.vars (and a fresh COOKIE_SECRET).');
console.log('    2. For production: wrangler secret put TOTP_SECRET');
console.log('                       wrangler secret put COOKIE_SECRET');
console.log('    3. Restart the dev server so the new env is picked up.');
console.log('');
console.log('  Need a COOKIE_SECRET too? Here\'s a 32-byte hex string:');
console.log(`    COOKIE_SECRET=${crypto.randomBytes(32).toString('hex')}`);
console.log('');

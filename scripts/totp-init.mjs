#!/usr/bin/env node
// One-shot helper: generate a 160-bit TOTP secret, encode it as base32, print
// the otpauth:// URI and an ASCII QR for your authenticator app, then offer
// to write the secrets straight into .dev.vars.
//
// Usage:
//   npm run totp:init
//   npm run totp:init -- --label "tracker-prod" --issuer "wibjibit"
//   npm run totp:init -- --no-write          (skip the .dev.vars prompt)
//   npm run totp:init -- --yes               (write without asking)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';

// --- argv parsing (intentionally tiny, no external dep) ---
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}
function flag(name) {
  return args.includes(`--${name}`);
}
const label = arg('label', 'tracker');
const issuer = arg('issuer', 'CF-T1000e-Tracker');
const skipWrite = flag('no-write');
const assumeYes = flag('yes');

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
const cookieSecret = crypto.randomBytes(32).toString('hex');

const otpauth =
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
  `?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

console.log('');
console.log('  Scan this QR with Google Authenticator / Authy / 1Password:');
console.log('');
qrcode.generate(otpauth, { small: true });
console.log('');
console.log(`  otpauth URI:   ${otpauth}`);
console.log(`  TOTP_SECRET:   ${secretBase32}`);
console.log(`  COOKIE_SECRET: ${cookieSecret}`);
console.log('');

// --- offer to update .dev.vars in place -----------------------------------

// Repo root = script lives in scripts/ next to package.json
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devVarsPath = path.join(repoRoot, '.dev.vars');
const examplePath = path.join(repoRoot, '.dev.vars.example');

/** Replace or append a single KEY=value line in a .env-style buffer. */
function upsertLine(content, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) return content.replace(re, `${key}=${value}`);
  if (!content.endsWith('\n') && content.length > 0) content += '\n';
  return content + `${key}=${value}\n`;
}

async function maybeWriteDevVars() {
  if (skipWrite) {
    console.log('  Skipping .dev.vars update (--no-write).');
    console.log('  Paste TOTP_SECRET and COOKIE_SECRET into .dev.vars yourself, then restart the dev server.');
    console.log('');
    return;
  }

  const exists = fs.existsSync(devVarsPath);
  const hasExample = fs.existsSync(examplePath);

  if (!exists && !hasExample) {
    console.log('  No .dev.vars or .dev.vars.example found; not modifying anything.');
    console.log('  Paste TOTP_SECRET and COOKIE_SECRET into a .dev.vars by hand.');
    console.log('');
    return;
  }

  let proceed;
  if (assumeYes) {
    proceed = true;
  } else {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const action = exists ? 'update existing' : 'create from .dev.vars.example';
      const answer = (await rl.question(`  ${action} .dev.vars with the new secrets? [Y/n] `)).trim().toLowerCase();
      proceed = answer === '' || answer === 'y' || answer === 'yes';
    } finally {
      rl.close();
    }
  }
  if (!proceed) {
    console.log('  Skipped. Nothing written.');
    console.log('');
    return;
  }

  let content;
  if (exists) {
    content = fs.readFileSync(devVarsPath, 'utf8');
    // Back up the current file so we don't lose a hand-tweaked value silently.
    const backup = devVarsPath + '.bak';
    fs.writeFileSync(backup, content);
    console.log(`  Backed up existing .dev.vars -> ${path.basename(backup)}`);
  } else {
    content = fs.readFileSync(examplePath, 'utf8');
  }

  content = upsertLine(content, 'TOTP_SECRET', secretBase32);
  content = upsertLine(content, 'COOKIE_SECRET', cookieSecret);
  fs.writeFileSync(devVarsPath, content);
  console.log(`  Wrote ${path.basename(devVarsPath)}.`);
  console.log('  Restart the dev server (Ctrl-C then `npm run dev`) so the new env is picked up.');
  console.log('');
}

async function main() {
  await maybeWriteDevVars();

  console.log('  For production, push the same values to Cloudflare:');
  console.log('    wrangler secret put TOTP_SECRET');
  console.log('    wrangler secret put COOKIE_SECRET');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

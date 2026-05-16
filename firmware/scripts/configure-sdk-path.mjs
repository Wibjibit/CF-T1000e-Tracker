#!/usr/bin/env node
// Rewrite all .emProject files to point at the user's local Nordic nRF5 SDK
// 17.1.0 checkout. The SDK is ~250 MB and licensed separately, so it's not
// included in this repo — download it from Nordic and unpack anywhere, then
// run this script once with that path.
//
// Usage:
//   node firmware/scripts/configure-sdk-path.mjs /path/to/nrf5-sdk-17.1.0
//   node firmware/scripts/configure-sdk-path.mjs D:/nrf5-sdk-17.1.0
//
// Idempotent. Re-runs replace any previously-set path with the new one. The
// detection is "any directory that contains components/libraries/log/src/".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const firmwareRoot = path.join(repoRoot, 'firmware');

const newPath = process.argv[2];
if (!newPath) {
  console.error('usage: node configure-sdk-path.mjs <PATH_TO_NRF5_SDK_17.1.0>');
  console.error('example: node configure-sdk-path.mjs D:/nrf5-sdk-17.1.0');
  process.exit(2);
}

// Normalise to forward slashes (SES projects use forward slashes on both OSes).
const normalised = newPath.replace(/\\/g, '/').replace(/\/+$/, '');

// Sanity check: SDK has a recognisable file at this relative path.
const sentinel = path.join(normalised, 'components/libraries/log/src/nrf_log_frontend.c');
if (!fs.existsSync(sentinel)) {
  console.error(`error: '${sentinel}' not found.`);
  console.error('Pass the directory that *contains* components/, modules/, integration/ etc.');
  process.exit(3);
}

// Match either the placeholder-style "__NRF5_SDK_PATH__/" or any previously-
// configured absolute path. We detect by looking for the shared SDK suffix
// "/components/libraries/log/src/nrf_log_frontend.c" inside file_name attrs.
const sdkSuffixRe = /file_name="([^"]+?)\/components\/libraries\/log\/src\/nrf_log_frontend\.c"/;

function findEmProjectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findEmProjectFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.emProject')) out.push(full);
  }
  return out;
}

const projects = findEmProjectFiles(firmwareRoot);
if (projects.length === 0) {
  console.error('no .emProject files found under', firmwareRoot);
  process.exit(4);
}

let totalReplaced = 0;
for (const file of projects) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(sdkSuffixRe);
  if (!m) {
    console.log(`  skip  ${path.relative(repoRoot, file)} (no SDK references found)`);
    continue;
  }
  const oldPath = m[1];
  if (oldPath === normalised) {
    console.log(`  ok    ${path.relative(repoRoot, file)} (already ${normalised})`);
    continue;
  }
  // Global string replace — every SDK reference in this file shares the prefix.
  const updated = raw.split(oldPath).join(normalised);
  const replacements = raw.split(oldPath).length - 1;
  fs.writeFileSync(file, updated);
  totalReplaced += replacements;
  console.log(`  wrote ${path.relative(repoRoot, file)}: ${replacements} path${replacements === 1 ? '' : 's'} updated  (${oldPath} -> ${normalised})`);
}

console.log('');
console.log(`Done. ${totalReplaced} SDK path${totalReplaced === 1 ? '' : 's'} rewritten across ${projects.length} .emProject file(s).`);

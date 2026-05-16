// Minimal signed-cookie session. Payload is JSON `{exp: unixSeconds}`,
// signed with HMAC-SHA-256 over its base64url-encoded form. No PII inside —
// just an expiry; the fact that the signature verifies under COOKIE_SECRET
// means the user passed the TOTP gate at some point.

const SESSION_COOKIE = 'session';
const DAY_SECONDS = 24 * 60 * 60;
const DEFAULT_LIFETIME_SECONDS = 7 * DAY_SECONDS;

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  let str = s.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSession(secret: string, expSeconds?: number): Promise<string> {
  const exp = expSeconds ?? Math.floor(Date.now() / 1000) + DEFAULT_LIFETIME_SECONDS;
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ exp })));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
  );
  return `${payload}.${b64urlEncode(sig)}`;
}

export interface SessionVerifyResult {
  ok: boolean;
  expMs?: number;
}

export async function verifySession(secret: string, token: string): Promise<SessionVerifyResult> {
  const dot = token.indexOf('.');
  if (dot < 0) return { ok: false };
  const payload = token.slice(0, dot);
  const sigStr = token.slice(dot + 1);
  if (!payload || !sigStr) return { ok: false };

  const key = await hmacKey(secret);
  let valid: boolean;
  try {
    // .slice() copies the bytes into a fresh ArrayBuffer-backed view, which
    // WebCrypto's strict BufferSource typing requires.
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sigStr).slice(),
      new TextEncoder().encode(payload),
    );
  } catch {
    return { ok: false };
  }
  if (!valid) return { ok: false };

  let parsed: { exp?: number };
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return { ok: false };
  }
  if (typeof parsed.exp !== 'number') return { ok: false };
  const expMs = parsed.exp * 1000;
  if (expMs < Date.now()) return { ok: false };

  return { ok: true, expMs };
}

export function buildSessionCookie(
  token: string,
  opts: { secure: boolean; maxAgeSeconds?: number },
): string {
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=`, 'Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

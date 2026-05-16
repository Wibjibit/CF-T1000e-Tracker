import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { readSessionCookie, verifySession } from './lib/session';

// Paths that bypass the session gate entirely. /api/ingest has its own Basic
// auth (TTN webhook); /api/auth/* is the login/logout flow itself; /login is
// the form; /favicon.ico is a static asset we serve as-is.
const PUBLIC_EXACT = new Set<string>([
  '/login',
  '/favicon.ico',
  '/api/ingest',
  '/api/auth/verify',
  '/api/auth/logout',
]);

// Dev-only prefixes: Vite's HMR and asset URLs. In production Static Assets
// serves /_astro/ directly without invoking the worker, so this matters most
// when running `astro dev`.
const DEV_PREFIXES = ['/_astro/', '/@vite/', '/@id/', '/@fs/', '/node_modules/', '/src/'];

function isPublic(path: string): boolean {
  if (PUBLIC_EXACT.has(path)) return true;
  for (const p of DEV_PREFIXES) if (path.startsWith(p)) return true;
  return false;
}

function unauthorized(path: string, search: string, origin: string): Response {
  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const loginUrl = new URL('/login', origin);
  loginUrl.searchParams.set('return_to', path + search);
  return new Response(null, {
    status: 302,
    headers: { Location: loginUrl.toString() },
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  if (isPublic(url.pathname)) return next();

  if (!env.COOKIE_SECRET) {
    // Misconfigured. Fail closed.
    if (url.pathname.startsWith('/api/')) {
      return new Response(
        JSON.stringify({ ok: false, error: 'server not configured (COOKIE_SECRET missing)' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(null, {
      status: 302,
      headers: { Location: '/login?error=config' },
    });
  }

  const token = readSessionCookie(context.request.headers.get('Cookie'));
  if (token) {
    const result = await verifySession(env.COOKIE_SECRET, token);
    if (result.ok) return next();
  }

  return unauthorized(url.pathname, url.search, url.origin);
});

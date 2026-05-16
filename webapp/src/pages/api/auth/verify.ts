import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { verifyTOTP } from '../../../lib/totp';
import { signSession, buildSessionCookie } from '../../../lib/session';

export const prerender = false;

// Sliding-window rate limit: at most this many attempts per IP per window.
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX_ATTEMPTS = 10;

function safeReturnTo(raw: string | null): string {
  // Only honour same-origin paths starting with '/' and not '//'.
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function redirect(target: string, headers: Headers): Response {
  headers.set('Location', target);
  return new Response(null, { status: 303, headers });
}

export const POST: APIRoute = async ({ request, url }) => {
  if (!env.TOTP_SECRET || !env.COOKIE_SECRET) {
    return redirect('/login?error=config', new Headers());
  }

  const ip = request.headers.get('cf-connecting-ip') ?? '0.0.0.0';
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;

  // Parse the form first so a malformed body (no `code`) doesn't burn a
  // rate-limit slot.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect('/login?error=invalid', new Headers());
  }
  const code = (form.get('code') ?? '').toString().trim();
  const returnTo = safeReturnTo((form.get('return_to') ?? '').toString());

  // Atomic rate limit: insert this attempt first, then count.
  // Running these as a D1 batch means each concurrent request sees its
  // own INSERT plus every earlier INSERT in the same window when it does
  // the count — closes the TOCTOU window where N concurrent verifys
  // could each read count < limit, pass the gate, and all proceed.
  const batchResults = await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_attempts WHERE ts < ?`).bind(cutoff),
    env.DB.prepare(`INSERT INTO auth_attempts (ip, ts) VALUES (?, ?)`).bind(ip, now),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND ts > ?`).bind(ip, cutoff),
  ]);
  const attempts = (batchResults[2]?.results?.[0] as { n: number } | undefined)?.n ?? 0;

  if (attempts > RL_MAX_ATTEMPTS) {
    return redirect('/login?error=ratelimit', new Headers());
  }

  const ok = await verifyTOTP(env.TOTP_SECRET, code, now);
  if (!ok) {
    return redirect(`/login?error=invalid&return_to=${encodeURIComponent(returnTo)}`, new Headers());
  }

  // On success, clear this IP's attempts so a successful login doesn't leave
  // the user one wrong-tap away from a 10-minute lockout.
  await env.DB.prepare(`DELETE FROM auth_attempts WHERE ip = ?`).bind(ip).run();

  const token = await signSession(env.COOKIE_SECRET);
  const headers = new Headers();
  headers.append(
    'Set-Cookie',
    buildSessionCookie(token, { secure: url.protocol === 'https:' }),
  );
  return redirect(returnTo, headers);
};

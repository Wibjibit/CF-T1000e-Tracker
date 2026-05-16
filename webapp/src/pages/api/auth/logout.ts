import type { APIRoute } from 'astro';
import { clearSessionCookie } from '../../../lib/session';

export const prerender = false;

export const POST: APIRoute = ({ url }) => {
  const headers = new Headers();
  headers.append('Set-Cookie', clearSessionCookie({ secure: url.protocol === 'https:' }));
  headers.set('Location', '/login');
  return new Response(null, { status: 303, headers });
};

// Convenience: a GET that does the same, so a plain <a href="/api/auth/logout">
// works as a logout link without needing a form. Idempotent.
export const GET: APIRoute = ({ url }) => {
  const headers = new Headers();
  headers.append('Set-Cookie', clearSessionCookie({ secure: url.protocol === 'https:' }));
  headers.set('Location', '/login');
  return new Response(null, { status: 303, headers });
};

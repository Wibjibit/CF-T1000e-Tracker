/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

// Bindings + secrets visible inside the Worker / Astro SSR routes.
// Mirrors wrangler.jsonc + .dev.vars.example.
interface Env {
  // Static assets binding (Workers + Static Assets).
  ASSETS: Fetcher;

  // TTN webhook Basic auth.
  TTN_BASIC_AUTH_USER: string;
  TTN_BASIC_AUTH_PASS: string;

  // Dashboard TOTP gate.
  TOTP_SECRET: string;
  COOKIE_SECRET: string;

  // Device identity filter.
  EXPECTED_DEV_EUI: string;

  // D1 (wired in Phase 2).
  // DB: D1Database;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}

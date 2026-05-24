// Companion Worker that owns the Find Hub poller Durable Object + its cron.
//
// WHY a second worker (master-plan Phase 3.2 "deferred" note, option (b)):
// the main site is built by @astrojs/cloudflare (v13.5.1), which emits a
// `no_bundle: true` deploy (main = dist/server/entry.mjs) — wrangler ships the
// pre-built Astro app as-is and does NOT bundle anything else, so it cannot pull
// in a Durable Object class plus its @noble / `cloudflare:sockets` dependencies.
// A standalone worker with normal bundling can, and it keeps the DO's lifecycle
// (alarm-driven MCS polling) cleanly separated from the request-serving site.
// Both bind the SAME D1 database (see wrangler.findhub.jsonc), so reports land
// in the one `reports` table the site already reads.
//
// Deploy:  wrangler deploy --config wrangler.findhub.jsonc
// Secret:  wrangler secret put BLOB_ENC_KEY --config wrangler.findhub.jsonc
// (the same 32-byte base64 key the site uses — it decrypts the `accounts` blob).

import { FindHubPoller } from './do/findhub-poller';

/** Bindings this cron worker needs. The DO itself only consumes DB + BLOB_ENC_KEY. */
export interface CronEnv {
  FINDHUB_POLLER: DurableObjectNamespace;
  DB: D1Database;
  BLOB_ENC_KEY: string;
}

/** The DO instance is a singleton (one Google household) addressed by a fixed name. */
const SINGLETON = 'singleton';

export default {
  // No public poll trigger on purpose: polling is driven by the cron below and
  // by the DO's own self-rearming alarm. This endpoint is a side-effect-free
  // health check (and workers_dev is disabled in the config anyway).
  async fetch(): Promise<Response> {
    return new Response('findhub-poller: ok\n', { headers: { 'Content-Type': 'text/plain' } });
  },

  // Safety-net kick: after a deploy/restart, nudge the singleton DO so it
  // (re)arms its alarm if one isn't already scheduled. The DO holds the
  // ephemeral mtalk.google.com:5228 socket per tick; the cron only ensures it
  // keeps ticking. `/ensure` (not `/kick`) just schedules — it doesn't force an
  // immediate full poll on top of the alarm cadence.
  async scheduled(_controller: ScheduledController, env: CronEnv, ctx: ExecutionContext): Promise<void> {
    const stub = env.FINDHUB_POLLER.get(env.FINDHUB_POLLER.idFromName(SINGLETON));
    ctx.waitUntil(stub.fetch('https://findhub-poller.internal/ensure'));
  },
};

export { FindHubPoller };

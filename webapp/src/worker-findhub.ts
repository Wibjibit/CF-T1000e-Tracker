// Companion Worker that owns the Find Hub poller Durable Object + its crons.
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
// Two crons (master-plan Phase 4, decision LOCKED — fold refresh in here):
//   - `*/10` → kick the poller DO (the Find Hub READ path; MCS socket).
//   - `0 4`  → static-EID LIVENESS refresh: build the precomputed-EID upload in
//              TS and hand it to the SpotRelay Container for the one `te:
//              trailers` gRPC POST Workers can't do (§1.5). No socket/DO.
//
// Deploy:  wrangler deploy --config wrangler.findhub.jsonc
// Secret:  wrangler secret put BLOB_ENC_KEY --config wrangler.findhub.jsonc
// (the same 32-byte base64 key the site uses — it decrypts the `accounts` blob).

import { Container, getContainer } from '@cloudflare/containers';
import { FindHubPoller } from './do/findhub-poller';
import { decrypt as decryptBlob } from './lib/crypto/blob';
import { mintAdmToken, mintSpotToken } from './lib/google/auth';
import { novaPost, buildDevicesListRequest } from './lib/google/nova';
import { parseDevices } from './lib/fmdn/report';
import { parseGoogleCreds } from './lib/fmdn/findhub';
import { planRefresh, parseRelayResponse, SPOT_UPLOAD_METHOD } from './lib/fmdn/refresh';

/** Bindings this cron worker needs. The poller DO consumes DB + BLOB_ENC_KEY;
 *  the refresh additionally drives the SpotRelay container. */
export interface CronEnv {
  FINDHUB_POLLER: DurableObjectNamespace;
  SPOT_RELAY: DurableObjectNamespace<SpotRelay>;
  DB: D1Database;
  BLOB_ENC_KEY: string;
}

/** The poller DO is a singleton (one Google household) addressed by a fixed name. */
const SINGLETON = 'singleton';
/** The cron expression that drives the EID-window refresh (vs the 10-min read kick). */
const REFRESH_CRON = '0 4 * * *';
/** Container instance name — one is plenty (refresh is a daily unary call). */
const RELAY_NAME = 'relay';

/**
 * The generic Spot gRPC relay container (container/spot-relay, Rust). A thin
 * Container subclass: the Worker POSTs a framed gRPC message + `x-spot-token` +
 * `x-spot-method`; the binary forwards it with `te: trailers`. `sleepAfter` is
 * short so cold-start + exec dominate the billed window (master-plan §Phase 4).
 */
export class SpotRelay extends Container {
  defaultPort = 8080;
  sleepAfter = '20s';
}

export default {
  // No public poll trigger on purpose: polling is driven by the cron below and
  // by the DO's own self-rearming alarm. This endpoint is a side-effect-free
  // health check (and workers_dev is disabled in the config anyway).
  async fetch(): Promise<Response> {
    return new Response('findhub-poller: ok\n', { headers: { 'Content-Type': 'text/plain' } });
  },

  // Two crons share this handler (branch on `controller.cron`):
  //   - REFRESH_CRON (`0 4 * * *`) → static-EID liveness refresh.
  //   - everything else (`*/10`)   → safety-net kick of the poller DO: after a
  //     deploy/restart, nudge the singleton so it (re)arms its alarm if one
  //     isn't scheduled. The DO holds the ephemeral mtalk:5228 socket per tick;
  //     the cron only ensures it keeps ticking. `/ensure` (not `/kick`) just
  //     schedules — it doesn't force an immediate full poll.
  async scheduled(controller: ScheduledController, env: CronEnv, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === REFRESH_CRON) {
      ctx.waitUntil(
        runRefresh(env).catch((e) => console.error('findhub-refresh: tick threw', e)),
      );
      return;
    }
    const stub = env.FINDHUB_POLLER.get(env.FINDHUB_POLLER.idFromName(SINGLETON));
    ctx.waitUntil(stub.fetch('https://findhub-poller.internal/ensure'));
  },
};

// ---------------------------------------------------------------------------
// Static-EID liveness refresh (master-plan Phase 4). I/O glue only — the
// EID/window/protobuf + plan are the vitest-covered pure modules
// (lib/fmdn/refresh.ts); this just reads D1, mints tokens, drives ListDevices +
// the relay container, and writes the result back.
// ---------------------------------------------------------------------------

/** One enabled findhub source joined to its account credentials. */
interface RefreshSourceRow {
  source_id: number;
  source_ref: string; // FMDN canonic_id
  account_id: number;
  credentials_nonce: ArrayBuffer;
  credentials_ciphertext: ArrayBuffer;
}

interface RefreshResult {
  accounts: number;
  refreshed: number; // device-sources whose EID window was extended
  errors: string[];
}

async function runRefresh(env: CronEnv): Promise<RefreshResult> {
  const result: RefreshResult = { accounts: 0, refreshed: 0, errors: [] };

  const rows = await env.DB.prepare(
    `SELECT s.source_id, s.source_ref, s.account_id,
            a.credentials_nonce, a.credentials_ciphertext
       FROM device_sources s
       JOIN accounts a ON a.account_id = s.account_id
      WHERE s.source_type = 'findhub' AND s.enabled = 1`,
  ).all<RefreshSourceRow>();

  const sources = rows.results ?? [];
  if (sources.length === 0) return result;

  // One Spot upload per Google account → group sources by account_id.
  const byAccount = new Map<number, RefreshSourceRow[]>();
  for (const r of sources) {
    const list = byAccount.get(r.account_id);
    if (list) list.push(r);
    else byAccount.set(r.account_id, [r]);
  }
  result.accounts = byAccount.size;

  for (const [accountId, accountSources] of byAccount) {
    try {
      result.refreshed += await refreshAccount(env, accountId, accountSources);
    } catch (e) {
      const msg = String(e);
      result.errors.push(`account ${accountId}: ${msg}`);
      // Record-only alerting (master-plan §1.6): persist the failure so the
      // /sources auth-health badge shows it. A later successful refresh clears it.
      try {
        await env.DB.prepare(
          `UPDATE accounts SET last_error = ?, last_attempt_at = ? WHERE account_id = ?`,
        )
          .bind(msg.slice(0, 500), Date.now(), accountId)
          .run();
      } catch (dbErr) {
        console.error('findhub-refresh: could not record account error', dbErr);
      }
    }
  }
  return result;
}

/** Refresh one account: ListDevices → plan → Spot upload via the relay → write. */
async function refreshAccount(
  env: CronEnv,
  accountId: number,
  sources: RefreshSourceRow[],
): Promise<number> {
  const creds = parseGoogleCreds(
    await decryptBlob(
      {
        credentials_nonce: sources[0].credentials_nonce,
        credentials_ciphertext: sources[0].credentials_ciphertext,
      },
      env,
    ),
  );

  // ADM token → ListDevices (the registration: encryptedIdentityKey, pairDate, …).
  const adm = await mintAdmToken(creds.username, creds.masterToken, creds.gcmAndroidId);
  if (!adm.ok || !adm.token) {
    throw new Error(`ADM token mint failed (status ${adm.status}) — re-auth needed`);
  }
  const devices = parseDevices(await novaPost(adm.token, 'nbe_list_devices', buildDevicesListRequest()));

  const tracked = new Set(sources.map((s) => s.source_ref));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const plan = planRefresh(devices, tracked, creds.ownerKey, nowSeconds);
  for (const f of plan.failures) console.warn(`findhub-refresh: EIK decrypt failed for ${f.canonicId}: ${f.error}`);
  if (!plan.frame) return 0; // nothing eligible (no MCU tracker we follow)

  // Spot token → the one `te: trailers` gRPC POST, done off-Workers by the relay.
  const spot = await mintSpotToken(creds.username, creds.masterToken, creds.gcmAndroidId);
  if (!spot.ok || !spot.token) {
    throw new Error(`Spot token mint failed (status ${spot.status}) — re-auth needed`);
  }

  const relay = getContainer(env.SPOT_RELAY, RELAY_NAME);
  const resp = await relay.fetch(
    new Request('https://spot-relay.internal/', {
      method: 'POST',
      headers: { 'x-spot-token': spot.token, 'x-spot-method': SPOT_UPLOAD_METHOD },
      // buildSpotFrame allocates an exact-size buffer (offset 0), so .buffer IS
      // the frame; the cast satisfies BodyInit under TS 5.7's generic Uint8Array.
      body: plan.frame.buffer as ArrayBuffer,
    }),
  );
  const parsed = parseRelayResponse(await resp.text());
  if (!parsed.ok) {
    throw new Error(
      `Spot upload failed: http ${parsed.httpStatus} grpc ${parsed.grpcStatus ?? '?'} ${
        parsed.grpcMessage ?? parsed.error ?? ''
      }`.trim(),
    );
  }

  // Success: bump last_refreshed_at for the refreshed sources + clear the
  // account error. (accounts.last_refreshed_at is the READ poll's signal — left
  // untouched here; the EID window's freshness lives per-source.)
  const now = Date.now();
  const refreshed = new Set(plan.refreshedCanonicIds);
  const writes: D1PreparedStatement[] = [];
  for (const s of sources) {
    if (refreshed.has(s.source_ref)) {
      writes.push(
        env.DB.prepare(`UPDATE device_sources SET last_refreshed_at = ? WHERE source_id = ?`).bind(now, s.source_id),
      );
    }
  }
  writes.push(
    env.DB.prepare(`UPDATE accounts SET last_error = NULL, last_attempt_at = ? WHERE account_id = ?`).bind(now, accountId),
  );
  await env.DB.batch(writes);
  return plan.refreshedCanonicIds.length;
}

export { FindHubPoller };

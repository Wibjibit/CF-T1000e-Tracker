# Architecture

How the bits fit together. Updated 2026-05-16 after Phase 7 monorepo restructure.

## Goals

- Run entirely on Cloudflare's free tier &mdash; no paid plan, no third-party SaaS.
- Single device, single user (or small group), TOTP-gated.
- Store every uplink (~480/day at the v10 180 s cadence) with full fidelity for at least a year.
- Map view of current position, timeline view of sensor data, both selectable by time range (1h / 6h / 24h / 7d / 30d / all).
- Optional fan-out of uplinks to a configurable downstream (e.g. TTN Mapper) without coupling our response latency to theirs.

## Worker

One Cloudflare Worker handles SSR pages, API routes, the TTN webhook, and an optional outbound forwarder. Workers + Static Assets serves Astro's built output; SSR routes run via `@astrojs/cloudflare` v13.

Bindings (see `webapp/wrangler.jsonc`):

| Name | Type | Purpose |
|---|---|---|
| `DB` | D1 | All app data; binding name set in `wrangler.jsonc` |
| `ASSETS` | Static assets | Astro's built static output |
| `SESSION` | KV (auto-provisioned by adapter) | Astro session driver, not used by our app code |

### Routes

| Path | Method | Auth | Notes |
|---|---|---|---|
| `/` | GET | session cookie | SSR landing &mdash; mini map (Leaflet, zoom 16) + GPS / Sensors / Radio detail sections |
| `/map` | GET | session cookie | SSR shell; client-side Leaflet + OSM polyline by range; auto-refresh checkbox |
| `/timeline` | GET | session cookie | SSR shell; client-side uPlot for every captured field (battery, mV, temp, lux, RSSI, SNR, SF, fix quality, sats tracked, sats in view, HDOP, speed, motion); auto-refresh checkbox |
| `/settings` | GET, POST | session cookie | Forwarder config form (toggle / URL / email / experiment) + audit log of last 50 forward attempts |
| `/login` | GET | none (public) | TOTP entry form |
| `/api/ingest` | POST | TTN HTTP Basic auth (public-ish) | Receive TTN webhook, validate, insert into D1, optionally forward to TTN Mapper via `waitUntil` |
| `/api/points` | GET | session cookie | `?range=1h\|6h\|24h\|7d\|30d\|all&with_fix=1` &mdash; chronological points, capped 5000 |
| `/api/auth/verify` | POST | rate-limited (D1) | Validate TOTP code, issue signed session cookie |
| `/api/auth/logout` | GET, POST | session cookie | Clear cookie |

### Middleware

`src/middleware.ts` gates everything not in `PUBLIC_EXACT` (`/login`, `/api/ingest`, `/api/auth/*`, `/favicon.ico`) on a valid session cookie. Unauth HTML routes get 302 → `/login?return_to=…`; unauth `/api/*` routes get 401 JSON. The path-match normalises trailing slashes so prerendered `/login/` works the same as `/login` &mdash; learned the hard way when Astro 6's prerender ran middleware at build time with build-time `Astro.url.origin = http://localhost:4321` and embedded that into the deployed static HTML.

### Auth

- **Dashboard:** TOTP shared-secret gate (RFC 6238, SHA-1, 6 digits, 30 s step, &plusmn;1 step skew). Secret in `TOTP_SECRET` Workers env; `npm run totp:init` generates one and prints an ASCII QR for Authenticator apps. Successful verification mints a 7-day `HMAC-SHA-256`-signed cookie (`COOKIE_SECRET`).
- **TTN webhook:** HTTP Basic auth, credentials in `TTN_BASIC_AUTH_USER` / `TTN_BASIC_AUTH_PASS`. Constant-time compare to mitigate timing leaks.
- **Origin check:** Astro 6's built-in CSRF origin check is on by default; the `/login` form works because browsers send `Origin` automatically. curl/PowerShell tests need `-H "Origin: …"` explicitly.

### Rate limiting

D1-backed sliding window in the `auth_attempts(ip, ts)` table, 10 attempts per IP per 10 min. Cheap because of the `(ip, ts)` index; old rows pruned inline on each check. Chose this over Cloudflare's free Rate Limiting binding to keep behaviour deterministic across `wrangler dev` (where bindings may behave differently) and prod.

## D1 schema

Migration files in `webapp/migrations/`. Apply locally with `wrangler d1 migrations apply tracker --local`, remotely with `--remote`.

| Table | Purpose |
|---|---|
| `uplinks` | One row per LoRaWAN uplink; PK `(dev_eui, f_cnt)` for idempotency. Stores decoded payload fields, best-gateway radio metadata, spreading factor, and the raw TTN `ApplicationUp` JSON. |
| `auth_attempts` | Sliding-window TOTP rate limit. `(ip, ts)` with indexes on both. |
| `settings` | Generic key/value config (`ttnmapper_enabled`, `ttnmapper_url`, `ttnmapper_email`, `ttnmapper_experiment`). Seeded with defaults; edited from `/settings`. |
| `forward_log` | Audit trail for outbound forwards: timestamp, target URL, HTTP status, duration, error snippet. |

The raw `ApplicationUp` JSON is retained alongside decoded columns so payload-format changes can be re-applied retroactively without losing data.

## Forwarder

The "forward each uplink to TTN Mapper" feature lives in `/api/ingest`. After a successful first insert (skipping replays via `INSERT OR IGNORE`'s `meta.changes`), reads `settings`, and if `ttnmapper_enabled === '1'`, builds a fetch with:

- `Content-Type: application/json`
- `TTNMAPPERORG-USER: <email>` &mdash; required; TTN Mapper returns 403 "email address is empty" without it
- `X-TTS-DOMAIN: <body.uplink_message.network_ids.cluster_address>` &mdash; required; TTN Mapper returns 400 "Originating network server header not set" without it. Mirrors what TTN-the-platform sets when it forwards directly.
- `TTNMAPPERORG-EXPERIMENT: <experiment>` &mdash; optional; tags traffic as test data so it stays off the main coverage map.

The fetch is detached via `Astro.locals.cfContext.waitUntil(...)`. 25 s `AbortController` timeout. Every attempt (success or timeout) is logged to `forward_log`. **Status:** as of May 2026 the TTN Mapper TTS v3 endpoint reliably times out due to a jammed internal publish channel &mdash; documented upstream issue (the maintainer is openly considering shutting the service down). The forwarder is configurable so it can be pointed at a successor when one exists.

## Idempotency

TTN's free tier sends each uplink once with no retries. We treat at-most-once delivery as fine for a personal tracker. The `(dev_eui, f_cnt)` primary key still means that if retries are ever enabled (paid plan), duplicate webhook deliveries simply collide on insert and become no-ops.

## Deployment target

- **Cloudflare account:** "Pauls Account" (`a3c6a5b41c0312ead688ef0c16313b45`), pinned in `webapp/wrangler.jsonc`.
- **Production hostname:** `tracker.wibjibit.com` via a custom-domain Worker binding. Cloudflare auto-provisions the TLS cert. `workers.dev` URL is auto-disabled when a custom domain is bound.
- **Dev/preview URL:** `npm run dev` (Astro + workerd via Vite) at `http://localhost:4321/`.

## Build / deploy

The `@astrojs/cloudflare` v13 adapter generates `dist/server/wrangler.json` on build with the right layout (`assets.directory = ../client`, `main = entry.mjs`). Deploys via `wrangler deploy --config dist/server/wrangler.json`. The repo-tracked `wrangler.jsonc` intentionally omits the `main` field &mdash; the Cloudflare Vite plugin would otherwise error during dev because the file doesn't exist until first build.

## What's deliberately not here

- **Queues / Durable Objects** &mdash; not needed at &le; 720 writes/day; D1 absorbs the writes directly. Outbound forwarding uses `waitUntil` instead of a queue consumer.
- **Real-time push to the browser** &mdash; the dashboard polls every 5 min when auto-refresh is on; WebSockets / Durable Objects add complexity without proportional value at this cadence.
- **Multi-device support** &mdash; one device, single `EXPECTED_DEV_EUI` filter. Trivial to generalise later (drop the env filter, add a per-row device label).
- **Downlink command UI** &mdash; out of scope for now; could be added once the firmware grows downlink handlers.

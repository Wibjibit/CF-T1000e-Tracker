# Architecture

How the bits fit together.

## Goals

- Run entirely on Cloudflare's free tier — no paid plan, no third-party SaaS.
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
| `/` | GET | session cookie | SSR landing — mini map (Leaflet, zoom 16) + GPS / Sensors / Radio detail sections |
| `/map` | GET | session cookie | SSR shell; client-side Leaflet + OSM polyline by range; auto-refresh checkbox |
| `/timeline` | GET | session cookie | SSR shell; client-side uPlot for every captured field (battery, mV, temp, lux, RSSI, SNR, SF, fix quality, sats tracked, sats in view, HDOP, speed, motion); auto-refresh checkbox |
| `/beams` | GET | session cookie | SSR shell; client-side Leaflet polylines from each receiving gateway to the device for every uplink in range, coloured by RSSI or SNR via an HSL gradient |
| `/gateways` | GET | session cookie | SSR table of every gateway ever heard in `rx_metadata`, with TTN-fetched name/location, per-gateway aggregates, sortable columns, filter chips, per-row refresh + hide + manual lat/lon override actions |
| `/settings` | GET, POST | session cookie | Forwarder config + TTN gateway-API config (bearer key + NS host) + audit log of last 50 forward attempts |
| `/login` | GET | none (public) | TOTP entry form |
| `/api/ingest` | POST | TTN HTTP Basic auth (public-ish) | Receive TTN webhook, validate, insert into D1, optionally forward to TTN Mapper via `waitUntil`, and fan out lazy gateway-metadata lookups for any new/stale `gateway_id` seen in `rx_metadata` |
| `/api/points` | GET | session cookie | `?range=1h\|6h\|24h\|7d\|30d\|all&with_fix=1` — chronological points, capped 5000 |
| `/api/beams` | GET | session cookie | `?range=…` — one row per (uplink × receiving gateway) for the `/beams` view. Joins parsed `rx_metadata` against the `gateways` cache; drops hidden / unlocated / (0,0) gateways |
| `/api/gateways` | GET, POST | session cookie | GET = list with aggregates + sanity badges; POST body `{action: refresh\|refresh_all\|set_manual_location\|clear_manual_location\|hide\|unhide, gateway_id?, latitude?, longitude?, altitude?}` |
| `/api/auth/verify` | POST | rate-limited (D1) | Validate TOTP code, issue signed session cookie |
| `/api/auth/logout` | GET, POST | session cookie | Clear cookie |

### Layout & nav structure

All authenticated pages render through `src/layouts/Layout.astro`. It owns `<html>`, `<head>`, the global `<style is:global>` block, and a persistent left sidebar that groups pages into **Live** (`/`, `/map`), **History** (`/timeline`), **Coverage** (`/beams`, `/gateways`), and **Admin** (`/settings`, sign out). Pages emit their content via the default slot; the leaflet stylesheet goes through a named `head` slot on the three pages that need it.

The sidebar's collapse state (full-width vs ~56 px icon rail) is toggled by a chevron button and persisted in `localStorage`; the class is applied to `<html>` from an inline `<script is:inline>` in `<head>` so the layout doesn't flash on the first paint after navigation. At ≤720 px the sidebar is hidden behind a hamburger drawer driven by a hidden `<input type="checkbox">` + `:checked` — no JS needed for the drawer itself. Active link highlight is derived from `Astro.url.pathname` inside the Layout, so pages never need to pass a prop. Page-level controls (range select, auto-refresh checkbox, RSSI/SNR toggle on `/beams`) live in a shared `.page-bar` strip at the top of each page's content, with styles defined once in Layout's global block.

### Middleware

`src/middleware.ts` gates everything not in `PUBLIC_EXACT` (`/login`, `/api/ingest`, `/api/auth/*`, `/favicon.ico`) on a valid session cookie. Unauth HTML routes get 302 → `/login?return_to=…`; unauth `/api/*` routes get 401 JSON. The path-match normalises trailing slashes so prerendered `/login/` works the same as `/login` — learned the hard way when Astro 6's prerender ran middleware at build time with build-time `Astro.url.origin = http://localhost:4321` and embedded that into the deployed static HTML.

### Auth

- **Dashboard:** TOTP shared-secret gate (RFC 6238, SHA-1, 6 digits, 30 s step, ±1 step skew). Secret in `TOTP_SECRET` Workers env; `npm run totp:init` generates one and prints an ASCII QR for Authenticator apps. Successful verification mints a 7-day `HMAC-SHA-256`-signed cookie (`COOKIE_SECRET`).
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
| `settings` | Generic key/value config. Forwarder: `ttnmapper_enabled`, `ttnmapper_url`, `ttnmapper_email`, `ttnmapper_experiment`. TTN gateway API: `ttn_api_key`, `ttn_ns_host`. Seeded with defaults; edited from `/settings`. |
| `forward_log` | Audit trail for outbound forwards: timestamp, target URL, HTTP status, duration, error snippet. |
| `gateways` | Cache of TTN gateway metadata (name, lat/lon/alt, status) keyed on `gateway_id`. Includes manual override columns (`latitude_manual` / `longitude_manual` / `altitude_manual`) and a `hidden` flag to exclude bad gateways from `/beams`. Populated lazily by the ingest hook (sighting on every uplink, refresh-on-stale via the TTN `/api/v3/gateways/{id}` endpoint) and via per-row / refresh-all actions on `/gateways`. |

The raw `ApplicationUp` JSON is retained alongside decoded columns so payload-format changes can be re-applied retroactively without losing data.

## Forwarder

The "forward each uplink to TTN Mapper" feature lives in `/api/ingest`. After a successful first insert (skipping replays via `INSERT OR IGNORE`'s `meta.changes`), reads `settings`, and if `ttnmapper_enabled === '1'`, builds a fetch with:

- `Content-Type: application/json`
- `TTNMAPPERORG-USER: <email>` — required; TTN Mapper returns 403 "email address is empty" without it
- `X-TTS-DOMAIN: <body.uplink_message.network_ids.cluster_address>` — required; TTN Mapper returns 400 "Originating network server header not set" without it. Mirrors what TTN-the-platform sets when it forwards directly.
- `TTNMAPPERORG-EXPERIMENT: <experiment>` — optional; tags traffic as test data so it stays off the main coverage map.

The fetch is detached via `Astro.locals.cfContext.waitUntil(...)`. 25 s `AbortController` timeout. Every attempt (success or timeout) is logged to `forward_log`. **Status:** as of May 2026 the TTN Mapper TTS v3 endpoint reliably times out due to a jammed internal publish channel — documented upstream issue (the maintainer is openly considering shutting the service down). The forwarder is configurable so it can be pointed at a successor when one exists.

## Idempotency

TTN's free tier sends each uplink once with no retries. We treat at-most-once delivery as fine for a personal tracker. The `(dev_eui, f_cnt)` primary key still means that if retries are ever enabled (paid plan), duplicate webhook deliveries simply collide on insert and become no-ops.

## Deployment target

- **Cloudflare account:** pinned via `account_id` in `webapp/wrangler.jsonc`. Reads as a comment block at the top of the file (FORK SETUP).
- **Production hostname:** custom-domain Worker binding (e.g. `tracker.example.com`). The zone has to be on the same Cloudflare account as the Worker; Cloudflare auto-provisions the TLS certificate after the first deploy. `workers.dev` URL is auto-disabled when a custom domain is bound — delete the `routes` block in `wrangler.jsonc` to keep `*.workers.dev` if you don't have a custom domain yet.
- **Dev/preview URL:** `npm run dev` (Astro + workerd via Vite) at `http://localhost:4321/`.

## Build / deploy

The `@astrojs/cloudflare` v13 adapter generates `dist/server/wrangler.json` on build with the right layout (`assets.directory = ../client`, `main = entry.mjs`). Deploys via `wrangler deploy --config dist/server/wrangler.json`. The repo-tracked `wrangler.jsonc` intentionally omits the `main` field — the Cloudflare Vite plugin would otherwise error during dev because the file doesn't exist until first build.

## What's deliberately not here

- **Queues / Durable Objects** — not needed at ≤ 720 writes/day; D1 absorbs the writes directly. Outbound forwarding uses `waitUntil` instead of a queue consumer.
- **Real-time push to the browser** — the dashboard polls every 5 min when auto-refresh is on; WebSockets / Durable Objects add complexity without proportional value at this cadence.
- **Multi-device support** — one device, single `EXPECTED_DEV_EUI` filter. Trivial to generalise later (drop the env filter, add a per-row device label).
- **Downlink command UI** — out of scope for now; could be added once the firmware grows downlink handlers.

# Webapp

Cloudflare-hosted Astro dashboard for the T1000-E tracker. SSR + Static Assets + D1. See the [top-level README](../README.md) for the project context.

## Quick start (local dev)

```bash
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars: set TTN_BASIC_AUTH_USER/PASS, EXPECTED_DEV_EUI, then:
npm run totp:init    # generates TOTP_SECRET + COOKIE_SECRET, optionally writes them
npm run dev          # http://localhost:4321
```

`wrangler` reads `wrangler.jsonc`; the adapter produces `dist/server/wrangler.json` on build, which is what `wrangler deploy` consumes.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `astro dev` — workerd-backed dev server with full bindings |
| `npm run build` | `astro build` — produces `dist/` with static assets + server entry |
| `npm run preview` | Build + `wrangler dev --config dist/server/wrangler.json` |
| `npm run deploy` | Build + `wrangler deploy` — ships to your bound Worker |
| `npm run check` | `astro check && tsc --noEmit` — typecheck |
| `npm run totp:init` | Generate a new 160-bit TOTP secret + COOKIE_SECRET; optionally write into `.dev.vars` |

## Deploy

```bash
# First time only: push secrets
wrangler secret put TTN_BASIC_AUTH_USER
wrangler secret put TTN_BASIC_AUTH_PASS
wrangler secret put TOTP_SECRET
wrangler secret put COOKIE_SECRET
wrangler secret put EXPECTED_DEV_EUI

# Schema migrations (every time you add a new .sql in migrations/)
wrangler d1 migrations apply tracker --remote

# Ship
npm run deploy
```

## Routes

| Path | Auth | Notes |
|---|---|---|
| `/` | session cookie | SSR landing — mini map + latest position + sensor card |
| `/map` | session cookie | Leaflet + OSM, polyline by range, auto-refresh checkbox |
| `/timeline` | session cookie | uPlot charts for every captured field, range dropdown, auto-refresh |
| `/settings` | session cookie | Forwarder config + audit log |
| `/login` | none | TOTP form |
| `/api/ingest` | Basic auth (TTN) | POST endpoint for TTN webhook |
| `/api/points` | session cookie | GET, `?range=1h|6h|24h|7d|30d|all&with_fix=1` |
| `/api/auth/verify` | rate-limited | POST 6-digit code, returns session cookie |
| `/api/auth/logout` | session cookie | Clears cookie |

## Schema

See `migrations/`:
- `0001_init.sql` — `uplinks(dev_eui, f_cnt, …)` keyed for idempotency
- `0002_auth_attempts.sql` — sliding-window rate-limit for `/api/auth/verify`
- `0003_settings_and_forward_log.sql` — generic K/V settings + outbound forward audit log
- `0004_ttnmapper_headers.sql` — TTN Mapper email + experiment header keys
- `0005_spreading_factor.sql` — capture SF per uplink

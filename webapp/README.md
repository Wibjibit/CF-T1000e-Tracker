# Webapp

Cloudflare-hosted Astro dashboard for the T1000-E tracker. SSR + Static Assets + D1. See the [top-level README](../README.md) for the project context.

## Prerequisites

- **Node.js 24+** — check with `node --version`.
- **Cloudflare account** — free tier is enough. [Sign up here](https://dash.cloudflare.com/sign-up) if you don't have one. `wrangler` will prompt you to log in on first use.
- **wrangler** — installed locally as a dev dependency via `npm install` below, so all commands in this doc use `npx wrangler …`. If you'd rather a global install (`npm i -g wrangler`), drop the `npx` prefix everywhere.

## Quick start (local dev)

```bash
npm install

# Secrets template -> real file (gitignored). Edit it to set
# TTN_BASIC_AUTH_USER, TTN_BASIC_AUTH_PASS, and EXPECTED_DEV_EUI.
cp .dev.vars.example .dev.vars

# Create a local D1 (the dev server uses a local SQLite shadow, not the
# remote DB). Then apply the schema. Both required *before* `npm run dev`
# — the dev server uses D1 from the first request, including the rate-limit
# table in /api/auth/verify.
npx wrangler d1 create tracker     # safe on first run; idempotent if already created
npx wrangler d1 migrations apply tracker --local

# Generate TOTP_SECRET + COOKIE_SECRET and (when prompted) write them
# straight into .dev.vars. Scan the printed QR with an authenticator app.
npm run totp:init

# Start the dev server at http://localhost:4321
npm run dev
```

You should land on a login screen; enter the current 6-digit code from your authenticator. The dashboard will say "No uplinks recorded yet" until your TTN webhook starts firing — see *Wiring TTN* below.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `astro dev` — workerd-backed dev server with full bindings |
| `npm run build` | `astro build` — produces `dist/` with static assets + server entry |
| `npm run preview` | Build + `wrangler dev --config dist/server/wrangler.json` |
| `npm run deploy` | Build + `wrangler deploy` — ships to your bound Worker |
| `npm run check` | `astro check && tsc --noEmit` — typecheck |
| `npm run totp:init` | Generate a new 160-bit TOTP secret + `COOKIE_SECRET`; can write directly into `.dev.vars` |

## Deploy to your own Cloudflare account

This walks through a clean fork. If you're inheriting this exact repo, the first three steps may already be done.

```bash
npx wrangler login

# Create the production D1 and capture the returned database_id.
npx wrangler d1 create tracker
# -> "✅ Successfully created DB 'tracker' ... database_id: <UUID>"
```

Paste that UUID into `wrangler.jsonc` next to `database_id:` (look for the FORK SETUP comment block at the top of the file; also confirm `account_id` is yours).

```bash
# Apply migrations to the remote DB.
npx wrangler d1 migrations apply tracker --remote

# Push secrets. Each command prompts for a value, hidden.
npx wrangler secret put TTN_BASIC_AUTH_USER
npx wrangler secret put TTN_BASIC_AUTH_PASS
npx wrangler secret put TOTP_SECRET
npx wrangler secret put COOKIE_SECRET
npx wrangler secret put EXPECTED_DEV_EUI

# Ship. First deploy creates the Worker, provisions the auto-bound KV
# (for Astro's session driver — we don't use it but the adapter wants it),
# and prints the URL you'll be reachable on.
npm run deploy
```

If `wrangler.jsonc` has a `routes` block pointing at a custom domain you don't own, either edit the pattern to a zone on your account, or delete the whole `routes` block to deploy on the auto-assigned `*.workers.dev` URL.

## Wiring TTN

Once the Worker is reachable, point your TTN application at it:

1. TTN Console → your application → **Integrations** → **Webhooks** → **Add webhook** → **Custom webhook**.
2. Settings:
   - **Webhook format:** JSON
   - **Base URL:** `https://<your-deploy>/api/ingest`
   - **Request authentication:** tick *"Use basic access authentication"*, fill in the same username + password you pushed as `TTN_BASIC_AUTH_USER` / `TTN_BASIC_AUTH_PASS`.
   - **Enabled event types:** tick **Uplink message** only. Leave the path field blank (the base URL is the endpoint).
3. Save. Within ~2 minutes you should see the first uplink land — verify in TTN Console → Live Data (should show 200 status for `as.up.data.forward`), and on the dashboard landing card.

## Routes

| Path | Auth | Notes |
|---|---|---|
| `/` | session cookie | SSR landing — mini map + latest position + sensor card |
| `/map` | session cookie | Leaflet + OSM, polyline by range, auto-refresh checkbox |
| `/timeline` | session cookie | uPlot charts for every captured field, range dropdown, auto-refresh |
| `/beams` | session cookie | Leaflet, gateway-to-device beams colored by RSSI/SNR, range selector |
| `/gateways` | session cookie | Sortable management table — aggregates, sanity badges, manual location override, hide-from-beams |
| `/settings` | session cookie | Forwarder + TTN gateway-API config, audit log |
| `/login` | none | TOTP form |
| `/api/ingest` | TTN Basic auth | POST endpoint for the TTN webhook |
| `/api/points` | session cookie | GET, `?range=1h\|6h\|24h\|7d\|30d\|all&with_fix=1` |
| `/api/beams` | session cookie | GET, `?range=…` — one row per (uplink × gateway) for /beams |
| `/api/gateways` | session cookie | GET = list w/ aggregates. POST = `{action: refresh\|refresh_all\|set_manual_location\|clear_manual_location\|hide\|unhide, gateway_id?, latitude?, longitude?, altitude?}` |
| `/api/auth/verify` | rate-limited | POST 6-digit code, returns session cookie |
| `/api/auth/logout` | session cookie | Clears cookie |

## Schema

See `migrations/`:
- `0001_init.sql` — `uplinks(dev_eui, f_cnt, …)` keyed for idempotency
- `0002_auth_attempts.sql` — sliding-window rate-limit for `/api/auth/verify`
- `0003_settings_and_forward_log.sql` — generic K/V settings + outbound forward audit log
- `0004_ttnmapper_headers.sql` — TTN Mapper email + experiment header keys
- `0005_spreading_factor.sql` — capture SF per uplink
- `0006_gateways.sql` — gateway metadata cache (TTN-fetched location + manual override + hide flag); seeds `ttn_api_key` / `ttn_ns_host` settings keys

After applying `0006_gateways.sql`, paste a TTN API key with `view-gateway-info` rights into `/settings` to enable gateway lookups. Without it, `/beams` and `/gateways` still work but show only gateway IDs and aggregated radio stats — no names or coordinates, so no beam lines drawn.

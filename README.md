# CF-T1000e-Tracker

Cloudflare-hosted map + timeline dashboard for a [SenseCAP T1000-E](https://wiki.seeedstudio.com/sensecap_t1000_tracker_intro/) LoRaWAN GPS tracker, paired with custom firmware that uplinks position + battery + temperature + light + motion every two minutes via The Things Network.

Designed to run entirely on Cloudflare's free tier (Workers, D1, Static Assets). Single device, single user, TOTP-gated dashboard.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Repo + Astro/Cloudflare scaffold | **in progress** |
| 2 | D1 schema + TTN ingest endpoint | pending |
| 3 | Read API + map page | pending |
| 4 | TOTP auth | pending |
| 5 | Timeline / sensor charts | pending |
| 6 | Production deploy | pending |

## Architecture

```
TTN webhook (HTTP POST, Basic auth)
        |
        v
Cloudflare Worker (this repo)
   - /api/ingest   -> validate + idempotent insert into D1
   - /api/points   -> read API for the dashboard
   - /             -> SSR landing (latest position)
   - /map, /timeline, /login -> static + client fetch
        |
        v
D1 (positions + sensor readings, keyed on dev_eui + f_cnt)
```

The firmware-side payload format is documented in [`docs/payload.md`](docs/payload.md). The decoder JavaScript in [`decoder/ttn_decoder.js`](decoder/ttn_decoder.js) is the same code used inside the TTN console formatter and the webapp's ingest path.

## Local dev

```bash
# 1. Install deps
npm install

# 2. Copy secrets template and fill in placeholders
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set TTN_BASIC_AUTH_USER, TTN_BASIC_AUTH_PASS, EXPECTED_DEV_EUI etc.

# 3. Run the dev server (workerd + Astro)
npm run dev
```

Once Phase 2 lands you'll also need a local D1 database; `wrangler d1 create tracker` then update `wrangler.jsonc` with the returned ID.

## Deploy

```bash
# Push secrets once
wrangler secret put TTN_BASIC_AUTH_USER
wrangler secret put TTN_BASIC_AUTH_PASS
wrangler secret put TOTP_SECRET
wrangler secret put COOKIE_SECRET

# Build + ship
npm run deploy
```

## License

MIT &mdash; see [`LICENSE`](LICENSE).

## Firmware

This repository hosts the webapp. The firmware fork (Seeed open LoRaWAN dev kit + AG3335 init fixes + sensor payload extensions) is tracked separately for now &mdash; its credentials live in a gitignored sibling file and have not yet been published. Watch this space.

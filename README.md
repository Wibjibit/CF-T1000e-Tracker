# T1000-E Tracker

A complete personal LoRaWAN GPS tracker stack on a £40 dev board: custom firmware on the [SenseCAP T1000-E](https://wiki.seeedstudio.com/sensecap_t1000_tracker_intro/) that uplinks position, battery, temperature, light and motion via The Things Network, plus a Cloudflare-hosted dashboard (map + sensor timeline) that consumes those uplinks.

Designed to run end-to-end on Cloudflare's **free tier** — no paid plan, no third-party SaaS. Single device, single user, TOTP-gated dashboard, your own custom domain.

```
┌──────────────┐  LoRa SF12 EU868   ┌─────────────┐  HTTPS webhook   ┌──────────────────┐
│  T1000-E     │ ─────────────────▶ │ TTN gateway │ ───────────────▶ │ Cloudflare Worker │
│  (firmware/) │   one uplink/3min  │             │   Basic auth     │   (webapp/)       │
└──────────────┘                    └─────────────┘                  └──────────────────┘
                                                                              │
                                                                              ▼
                                                            ┌───────────────────────────────┐
                                                            │ D1: uplinks, settings, audit  │
                                                            │ Dashboard: map + timeline +   │
                                                            │   /settings + optional        │
                                                            │   TTN-Mapper forwarder        │
                                                            │ TOTP-gated, your domain       │
                                                            └───────────────────────────────┘
```

## What you get

- **Live map** with a 1h / 6h / 24h / 7d / 30d / all-time selector; current position marker + track polyline; optional auto-refresh every 5 minutes.
- **Sensor timeline** — battery %, battery mV, PCB temperature, ambient light, RSSI, SNR, spreading factor, GPS fix quality, sats tracked, sats in view, HDOP, speed, motion events.
- **Landing dashboard** with a zoomed-in mini map and grouped GPS / Sensors / Radio detail cards.
- **TOTP login** (works with Google Authenticator, Authy, 1Password, anything RFC 6238).
- **Configurable downstream forwarder** that fans out each uplink to e.g. TTN Mapper *after* responding 200 to TTN, so TTN's webhook timeout never trips. Audit log of every forward attempt visible in `/settings`.
- **Honest hardware-side firmware** — fixes Seeed's stock example so the AG3335 GPS chip actually gets a fix in EU868, exposes battery / temperature / light / motion in a 26-byte payload, and pins SF12 for maximum range.

## Hardware

- [SenseCAP T1000-E dev kit](https://www.seeedstudio.com/SenseCAP-Card-Tracker-T1000-E-for-Meshtastic-p-5913.html) — ~£40 / $50
- A LoRaWAN gateway within range (anything on [The Things Network](https://www.thethingsnetwork.org/community)) — many cities have community gateways; otherwise a [RAK WisGate Edge Lite 2](https://store.rakwireless.com/products/wisgate-edge-lite-2) is the popular self-host pick.

## Software prerequisites

For the **webapp**:
- Node.js 24+
- A Cloudflare account (free tier is enough)
- A Cloudflare-managed domain if you want a custom hostname (otherwise the auto-assigned `*.workers.dev` URL works fine)

For the **firmware** (only if you're modifying / rebuilding):
- [SEGGER Embedded Studio 5.68+](https://www.segger.com/downloads/embedded-studio/) (free for Nordic targets)
- [Nordic nRF5 SDK 17.1.0](https://www.nordicsemi.com/Products/Development-software/nrf5-sdk)
- Python 3.10+ plus `pip install adafruit-nrfutil` for the flashing step

If you're happy running the dashboard against a tracker you've already flashed elsewhere (or hand the firmware to a friend), you can skip the firmware toolchain entirely.

## Quick start

### Dashboard (webapp)

```bash
git clone https://github.com/<you>/CF-T1000e-Tracker.git
cd CF-T1000e-Tracker/webapp

npm install
cp .dev.vars.example .dev.vars                    # template — edit it to set
                                                  #   TTN_BASIC_AUTH_USER/PASS, EXPECTED_DEV_EUI
npm run totp:init                                  # generates TOTP_SECRET + COOKIE_SECRET, can write them in
npx wrangler d1 create tracker                     # one-time, paste the returned database_id into wrangler.jsonc
npx wrangler d1 migrations apply tracker --local   # build the local D1 schema
npm run dev                                        # http://localhost:4321
```

Sign in with the TOTP code from your authenticator app (the `totp:init` script prints the QR). The landing page will show "No uplinks recorded yet" until your TTN webhook fires.

To deploy:

```bash
wrangler login
wrangler d1 create tracker                         # paste the returned database_id into wrangler.jsonc
wrangler d1 migrations apply tracker --remote
# push the 5 secrets (TTN basic auth user/pass, TOTP, cookie, expected DevEUI):
wrangler secret put TTN_BASIC_AUTH_USER
wrangler secret put TTN_BASIC_AUTH_PASS
wrangler secret put TOTP_SECRET
wrangler secret put COOKIE_SECRET
wrangler secret put EXPECTED_DEV_EUI
npm run deploy
```

Then point a TTN webhook (Custom + JSON, Basic auth, Uplink message event only) at `https://<your-deploy>/api/ingest` with the basic auth values you set above. Walk outside, wait a few minutes, watch the map.

Full webapp setup, route reference, and schema notes: [`webapp/README.md`](webapp/README.md).

### Firmware

```bash
cd CF-T1000e-Tracker/firmware

# 1. Point the SES project at your local SDK
node scripts/configure-sdk-path.mjs /path/to/nrf5-sdk-17.1.0

# 2. Set up credentials
cp apps/common/lorawan_key_config_private.example.h apps/common/lorawan_key_config_private.h
# edit the .private.h with your TTN DevEUI / JoinEUI / AppKey

# 3. Build (Windows path shown)
& "C:\Program Files\SEGGER\SEGGER Embedded Studio for ARM 5.68\bin\emBuild.exe" `
    -config Release `
    "pca10056\s140\08_ses_lorawan_gnss\t1000_e_dev_kit_pca10056.emProject"

# 4. Wrap into a Seeed-flavoured DFU zip and flash. The device needs to be in
#    DFU mode first — hold the user button and mag-tap the back of the unit
#    twice (see firmware/README.md "Get the device into DFU mode" for detail).
adafruit-nrfutil dfu genpkg `
    --application "pca10056\s140\08_ses_lorawan_gnss\Output\Release\Exe\t1000_e_dev_kit_pca10056.hex" `
    --application-version 4294967295 --dev-type 0x52 --sd-req 0x123 `
    gnss_ttn.zip
adafruit-nrfutil --verbose dfu serial --package gnss_ttn.zip -p COMx -b 115200 --singlebank
```

Why the magic numbers (`--dev-type 0x52`, `--sd-req 0x123`) matter, full lessons learned, recovery procedures, NTC calibration notes: [`firmware/README.md`](firmware/README.md).

## Repository layout

| Path | What's in it |
|---|---|
| [`firmware/`](firmware/) | Fork of [Seeed's open-source T1000-E firmware](https://github.com/Seeed-Studio/Seeed-Tracker-T1000-E-for-LoRaWAN-dev-board). EU868 region, AG3335 GNSS init fixes, 26-byte payload (battery / temp / lux / motion + GPS), SF12-pinned v10 ADR. Credentials live in a gitignored `lorawan_key_config_private.h`. |
| [`webapp/`](webapp/) | Astro 6 + `@astrojs/cloudflare` v13. Workers + Static Assets + D1. Ingest, map, timeline, settings, TOTP login. Deployed via `npm run deploy`. |
| [`decoder/ttn_decoder.js`](decoder/ttn_decoder.js) | TTN Console uplink formatter (paste-in JS). Mirrored as a typed module at `webapp/src/lib/decoder.ts`. |
| [`docs/payload.md`](docs/payload.md) | Byte-level v9 payload spec — single source of truth shared by firmware and dashboard. |
| [`docs/architecture.md`](docs/architecture.md) | Route table, bindings, D1 schema, auth model, forwarder behaviour. |

The firmware and webapp evolve together but ship independently. A firmware change is a build + flash; a webapp change is `npm run deploy`. The decoder + payload spec are the contract between them.

## Architecture, at a glance

- **One Cloudflare Worker** serves SSR pages, API routes, the TTN webhook, and the static asset bundle. No second Worker, no Queue, no Durable Object — D1 absorbs the writes directly.
- **D1** stores every uplink keyed on `(dev_eui, f_cnt)` for idempotency, plus the raw `ApplicationUp` JSON for future re-parsing if the payload format ever changes.
- **TOTP gate** with a signed `httpOnly` session cookie (HMAC-SHA-256, 7-day lifetime). Sliding-window rate limit on the verify endpoint backed by a D1 table.
- **Outbound forwarder** runs via `ctx.waitUntil(...)` so a slow downstream (TTN Mapper, in our experience) can't extend our response time to TTN. Every attempt is logged.

See [`docs/architecture.md`](docs/architecture.md) for the full picture.

## What's shipped

- Astro / Cloudflare Workers scaffold with D1 + Static Assets
- TTN ingest webhook (Basic auth, idempotent on `(dev_eui, f_cnt)`)
- Read API + map page (Leaflet + OSM, polyline by selectable range)
- TOTP auth (signed session cookie, D1-backed rate limit)
- Sensor timeline with charts for every captured field (uPlot)
- Production deploy on a custom domain (Cloudflare auto-TLS)
- Configurable downstream forwarder with audit log (currently TTN Mapper, runs via `waitUntil` so their slowness can't time us out from TTN's side)
- Firmware in the repo with credentials split out into a gitignored sibling header

## Future work

- **`/coverage` page** — heatmap + reception "beams" overlaid on OSM. Data is already in D1: every uplink has `lat`, `lon`, `rssi`, `snr`, `gateway_id`. Needs a gateway-coordinates lookup.
- **NTC temperature calibration** — firmware reads ~10 °C cold; see [`firmware/README.md`](firmware/README.md) for the back-solve approach.
- **Motion-triggered uplinks** — Seeed's `11_lorawan_tracker` reference. Better battery life by sleeping while still.
- **Self-host a TTN Mapper successor** — the forwarder is already generic (target URL + headers in D1); pointing at a replacement is a `/settings` edit.

## Cost

Running this stack at ~480 uplinks/day (the v10 cadence) sits comfortably inside Cloudflare's free quotas: ~0.5 % of the daily Workers request limit, ~0.5 % of D1's daily write quota, ~0.001 % of D1's storage. There is no anticipated monthly bill.

## Acknowledgments

- [Seeed-Studio](https://github.com/Seeed-Studio/Seeed-Tracker-T1000-E-for-LoRaWAN-dev-board) for the open-source T1000-E firmware base.
- [Semtech](https://www.semtech.com/) for the LoRa Basics Modem (Clear BSD).
- [Astro](https://astro.build/), [Cloudflare](https://workers.cloudflare.com/), [Leaflet](https://leafletjs.com/), [uPlot](https://github.com/leeoniya/uPlot), and [OpenStreetMap](https://www.openstreetmap.org/) for everything that makes the dashboard tractable on a free tier.
- [TTN Mapper](https://ttnmapper.org/) for a decade of LoRaWAN coverage mapping. The forwarder is generic so it can outlive any single downstream.

## License

MIT for everything in this repo authored as part of this project — see [LICENSE](LICENSE). `firmware/` includes vendored Semtech LoRa Basics Modem (Clear BSD) and Seeed-Studio dev-kit code under their original licenses; both are MIT-compatible.

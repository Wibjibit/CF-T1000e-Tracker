# T1000-E Tracker

End-to-end LoRaWAN GPS tracker on a [SenseCAP T1000-E](https://wiki.seeedstudio.com/sensecap_t1000_tracker_intro/) dev kit: custom firmware that uplinks position + battery + temperature + light + motion via The Things Network, and a Cloudflare-hosted dashboard (map + timeline + ingest webhook + settings) that consumes those uplinks.

```
┌──────────────┐  LoRa SF12 EU868   ┌─────────────┐  HTTPS webhook   ┌──────────────────┐
│  T1000-E     │ ─────────────────▶ │ TTN gateway │ ───────────────▶ │ Cloudflare Worker │
│  (firmware/) │  one uplink/180 s  │             │  Basic auth      │  (webapp/)        │
└──────────────┘                    └─────────────┘                  └──────────────────┘
                                                                              │
                                                                              ▼
                                                            ┌───────────────────────────────┐
                                                            │ D1: uplinks, settings, audit  │
                                                            │ Dashboard: map + timeline +   │
                                                            │   /settings + TTN Mapper      │
                                                            │   forwarder, TOTP-gated       │
                                                            └───────────────────────────────┘
```

Designed to run end-to-end on Cloudflare's free tier (Workers, D1, Static Assets) at a personal-tracker scale. Single device, single user, TOTP-gated dashboard, custom domain on the user's own Cloudflare zone.

## Layout

| Path | Purpose |
|---|---|
| [`firmware/`](firmware/) | Fork of Seeed-Studio's open-source T1000-E dev-kit firmware with EU868 region, AG3335 GNSS init fixes, 26-byte v9 payload (battery/temp/lux/motion + GPS), SF12-pinned v10 ADR profile. See [`firmware/README.md`](firmware/README.md). |
| [`webapp/`](webapp/) | Astro 6 + `@astrojs/cloudflare` v13 dashboard. Workers + Static Assets + D1. TTN webhook ingest, map view, sensor timeline, TOTP login, configurable downstream forwarder. See [`webapp/README.md`](webapp/README.md). |
| [`decoder/ttn_decoder.js`](decoder/ttn_decoder.js) | Reference TTN Console uplink formatter for the v9 payload (paste-in form). Mirrored in TypeScript at `webapp/src/lib/decoder.ts`. |
| [`docs/payload.md`](docs/payload.md) | Byte-level spec of the v9 payload, single source of truth shared between firmware and dashboard. |
| [`docs/architecture.md`](docs/architecture.md) | How the bits fit together — routes, D1 tables, auth model, deployment targets. |

The firmware and webapp evolve together but ship independently. A firmware change is a build + flash; a webapp change is `npm run deploy`. The decoder and payload spec are the contract between them.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Repo + Astro/Cloudflare scaffold | done |
| 2 | D1 schema + TTN ingest endpoint | done |
| 3 | Read API + map page | done |
| 4 | TOTP auth | done |
| 5 | Timeline / sensor charts | done |
| 6 | Production deploy (tracker.wibjibit.com) | done |
| 6.1 | TTN Mapper forwarder (settings + audit log) | done (blocked by upstream — see [`firmware/README.md`](firmware/README.md) and audit log) |
| 7 | Firmware in repo (credentials split) | done — this restructure |

## Future work

- **`/coverage` page** — heatmap + reception "beams" overlaid on OSM. The data is already in D1: every uplink has `lat`, `lon`, `rssi`, `snr`, and `gateway_id`. A heatmap layer (e.g. Leaflet.heat) coloured by RSSI shows where each gateway hears the device; line segments from the device fix to the gateway position visualise the receive path. Gateway coordinates aren't currently stored — either look them up from the TTN gateway API on demand, cache in a `gateways(id, lat, lon)` table, or accept a manual entry in `/settings`.
- **NTC temperature calibration** — firmware reads ~10 °C cold. See notes in [`firmware/README.md`](firmware/README.md).
- **Self-host a TTN Mapper successor** if/when JP Meijers winds down the service. The forwarder is already generic (target URL + headers in D1); pointing at a replacement is a `/settings` edit, not code.
- **Motion-triggered uplinks** — Seeed's `11_lorawan_tracker` reference. Better battery life by sleeping while still.

## License

MIT — see [LICENSE](LICENSE). Note: `firmware/` contains vendored Semtech LoRa Basics Modem code under its own Clear BSD license, and Seeed-Studio dev-kit source under their original license. Both compatible with MIT.

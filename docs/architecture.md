# Architecture

## Goals

- Run entirely on Cloudflare's free tier &mdash; no paid plan, no third-party SaaS.
- Single device, single user (or small group), TOTP-gated.
- Store every uplink (~720/day) with full fidelity for at least a year.
- Map view of current position and timeline view of sensor data, both selectable by time range.

## Components

### Worker (this repo, built by Astro)

One Cloudflare Worker handles everything: SSR pages, API routes, and the TTN webhook. Workers + Static Assets serves the built Astro output; SSR routes run via the `@astrojs/cloudflare` v13 adapter.

Routes (planned):

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/api/ingest` | POST | TTN Basic auth | Receive TTN webhook, validate, insert into D1 |
| `/api/points` | GET | session cookie | Recent positions/sensor data for the dashboard |
| `/api/auth/verify` | POST | rate-limited | TOTP verification, issues session cookie |
| `/` | GET | session cookie | SSR landing &mdash; latest position |
| `/map` | GET | session cookie | Static + client fetch (Leaflet + OSM) |
| `/timeline` | GET | session cookie | Static + client fetch (sensor charts) |
| `/login` | GET, POST | none | TOTP entry form |

### D1 (relational storage)

One table per concern, keyed for idempotency on the LoRaWAN frame counter:

- `uplinks(dev_eui TEXT, f_cnt INTEGER, received_at INTEGER, lat REAL, lon REAL, ...decoded fields..., raw_json TEXT, PRIMARY KEY(dev_eui, f_cnt))`

The raw `ApplicationUp` JSON is retained alongside decoded columns so payload-format changes can be re-applied retroactively without losing data.

### Auth

- **Dashboard:** TOTP shared-secret gate. Secret in Workers env var; `npm run totp:init` (Phase 4) generates one and prints a QR for Google Authenticator / Authy / 1Password / etc. Successful verification sets a signed httpOnly cookie valid for 7 days.
- **TTN webhook:** HTTP Basic auth, credentials in env vars. TTN sends them in the `Authorization` header on every POST.

### Rate limiting

Cloudflare's free Rate Limiting binding gates `/api/auth/verify` to 5 attempts per IP per 10 minutes to keep TOTP brute force impractical.

## Idempotency

TTN's free tier sends each uplink once with no retries. We treat at-most-once delivery as fine for a personal tracker. The `(dev_eui, f_cnt)` primary key still means that if retries are ever enabled (paid plan), duplicate webhook deliveries simply collide on insert and become no-ops.

## What's deliberately not here

- **Queues / Durable Objects** &mdash; not needed at 720 writes/day; D1 absorbs the writes directly.
- **Real-time push to the browser** &mdash; the dashboard polls; WebSockets / DOs add complexity without proportional value at this cadence.
- **Multi-device support** &mdash; one device, single `EXPECTED_DEV_EUI` filter. Trivial to generalise later.
- **Downlink command UI** &mdash; out of scope for v1; could be added once the firmware grows downlink handlers.

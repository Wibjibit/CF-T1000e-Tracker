# Uplink Payload Format (v9)

The tracker firmware sends a 26-byte custom binary payload on FPort 2. Period was 120 s through firmware v9 and is **180 s in firmware v10** &mdash; the payload bytes are identical between v9 and v10, only the LoRa link parameters (SF12 lock, slower cadence) differ. All multi-byte fields are big-endian.

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0&ndash;3 | 4 | latitude | int32 | degrees &times; 1&nbsp;000&nbsp;000 |
| 4&ndash;7 | 4 | longitude | int32 | degrees &times; 1&nbsp;000&nbsp;000 |
| 8&ndash;9 | 2 | altitude | int16 | metres |
| 10 | 1 | hdop_x10 | uint8 | HDOP &times; 10 |
| 11 | 1 | sats_tracked | uint8 | sats in current fix (GGA) |
| 12 | 1 | sats_in_view | uint8 | last GSV sentence's per-constellation count |
| 13 | 1 | fix_quality | uint8 | 0 = invalid, 1 = GPS, 2 = DGPS |
| 14 | 1 | speed_kmh | uint8 | |
| 15&ndash;16 | 2 | uart_bytes_rx | uint16 | diagnostic, per-scan, capped 65535 |
| 17&ndash;18 | 2 | uart_lines_parsed | uint16 | diagnostic, per-scan, capped 65535 |
| 19 | 1 | battery_pct | uint8 | 0&ndash;100 |
| 20&ndash;21 | 2 | battery_mv | uint16 | millivolts |
| 22&ndash;23 | 2 | temp_c_x100 | int16 | &deg;C &times; 100 (PCB NTC; biased ~10 &deg;C cold &mdash; treat as relative) |
| 24 | 1 | lux_pct | uint8 | 0&ndash;100 (on-board LDR) |
| 25 | 1 | flags | uint8 | bit0 = motion since last uplink, bits 1&ndash;7 reserved |

## Fix-failure semantics

When the GPS chip fails to obtain a fix, `latitude` and `longitude` are written as zero and `fix_quality` is zero. Consumers should treat `(0, 0, fix_quality=0)` as "no fix this scan" rather than a Null Island uplink. The diagnostic UART counters remain populated even on failure &mdash; they're useful for distinguishing chip-power problems from sky-view problems.

## Decoder

A reference decoder is in [`../decoder/ttn_decoder.js`](../decoder/ttn_decoder.js) (paste into the TTN console as the Uplink payload formatter). The webapp has a typed TypeScript port at [`../webapp/src/lib/decoder.ts`](../webapp/src/lib/decoder.ts) used by `/api/ingest`; both files share a `SYNC:` comment so they're updated together when the byte layout changes.

## DevStatusAns

The firmware also responds to the LoRaWAN MAC layer `DevStatusReq` command with the same battery percentage rescaled to LoRaWAN's 1&ndash;254 range. So `last_battery_percentage` in the TTN application API reflects the real value as well, though that field only updates whenever the network server happens to issue `DevStatusReq` (sporadically &mdash; typically once per session).

## Stored vs transmitted

The webapp's `uplinks` table stores more than the 26 transmitted bytes &mdash; specifically it captures TTN-side metadata that lives outside the payload:

- `rssi`, `snr`, `gateway_id` &mdash; picked from `rx_metadata[]`, choosing the gateway with the highest RSSI
- `spreading_factor` &mdash; from `uplink_message.settings.data_rate.lora.spreading_factor`
- `raw_json` &mdash; the full `ApplicationUp` body for re-decoding if the payload format evolves

So when `/timeline` or `/map` plot RSSI / SNR / SF, those are TTN-reported per-uplink values, not part of the device's transmitted payload.

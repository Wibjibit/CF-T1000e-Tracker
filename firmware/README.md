# T1000-E Firmware

LoRaWAN GPS tracker firmware for the [SenseCAP T1000-E dev kit](https://wiki.seeedstudio.com/sensecap_t1000_tracker_intro/). Forked from Seeed-Studio's [open-source dev-kit firmware](https://github.com/Seeed-Studio/Seeed-Tracker-T1000-E-for-LoRaWAN-dev-board) with the following changes:

- **EU868 region** (Seeed's prebuilts target US915).
- **AG3335 GNSS init fixes** — `$PAIR066,1,1,1,1,0,0` to enable GPS+GLONASS+GALILEO+BDS, `$PAIR062,3,1` to re-enable `$xGSV` sentences (Meshtastic/MeshCore had disabled them in chip NVM), `$PAIR513` to persist, plus hard-reset wake instead of RTC-pulse wake.
- **26-byte custom payload (v9 format)** with battery %/mV, NTC temperature, ambient light, QMA6100P motion flag in addition to GPS — see [`../docs/payload.md`](../docs/payload.md).
- **Real `DevStatusAns` battery level** instead of the upstream's hardcoded `254`.
- **SF12 pinned via custom ADR profile (v10)**, 180 s uplink period — maximises range, stays under EU868's 1 % duty cycle.
- **Credentials split** into a gitignored sibling header so this tree is shareable.

The decoder paired with this payload is in [`../decoder/ttn_decoder.js`](../decoder/ttn_decoder.js) (paste into TTN Console as the uplink formatter) and [`../webapp/src/lib/decoder.ts`](../webapp/src/lib/decoder.ts) (used by the companion dashboard).

## One-time setup

```powershell
# 1. Tooling
#    - SEGGER Embedded Studio for ARM 5.68+   https://www.segger.com/downloads/embedded-studio/
#    - Nordic nRF5 SDK 17.1.0                  https://www.nordicsemi.com/Products/Development-software/nrf5-sdk
#    - Python 3.10+ and:
pip install adafruit-nrfutil

# 2. Point the SES project files at your local SDK checkout
node firmware/scripts/configure-sdk-path.mjs D:/nrf5-sdk-17.1.0

# 3. Copy the credentials template and fill in your TTN values
cp firmware/apps/common/lorawan_key_config_private.example.h firmware/apps/common/lorawan_key_config_private.h
# Edit lorawan_key_config_private.h: DevEUI / JoinEUI / AppKey from your TTN device
```

## Build

```powershell
& "C:\Program Files\SEGGER\SEGGER Embedded Studio for ARM 5.68\bin\emBuild.exe" `
    -config Release `
    "firmware\pca10056\s140\08_ses_lorawan_gnss\t1000_e_dev_kit_pca10056.emProject"
```

Output `.hex` lands in `firmware/pca10056/s140/08_ses_lorawan_gnss/Output/Release/Exe/`.

The build emits ~50 implicit-declaration warnings from Seeed's HAL code. These are pre-existing and harmless — only watch for `error:` lines.

## Package + flash

```powershell
# Wrap the .hex into a Seeed-flavoured Nordic DFU zip
adafruit-nrfutil dfu genpkg `
    --application "firmware\pca10056\s140\08_ses_lorawan_gnss\Output\Release\Exe\t1000_e_dev_kit_pca10056.hex" `
    --application-version 4294967295 `
    --dev-type 82 `
    --sd-req 0x123 `
    gnss_ttn.zip

# Put the device in DFU mode: hold the user button + mag-tap twice
# (solid green LED). Confirm USB shows VID 2886:0057.
$dfu = Get-PnpDevice -Class Ports -PresentOnly | Where-Object { $_.InstanceId -match "VID_2886.PID_0057" } | Select-Object -First 1
$com = ($dfu.FriendlyName -replace '.*\((COM\d+)\)', '$1')

adafruit-nrfutil --verbose dfu serial `
    --package gnss_ttn.zip `
    -p $com -b 115200 --singlebank
```

### Why the magic numbers

| Flag | Value | Why |
|---|---|---|
| `--dev-type` | `82` (0x52) | Seeed's bootloader requires this exact `device_type`. Anything else → USB STALL mid-flash. |
| `--sd-req`   | `0x123` (291) | Seeed's custom SoftDevice ID (not the standard Nordic S140 `0xCA`). Discovered by diffing against the official MeshCore manifest. |
| `--application-version` | `0xFFFFFFFF` | Stops the bootloader rejecting the package as "older than what's installed". |
| `--singlebank` | — | Seeed's bootloader is single-bank; without this `adafruit-nrfutil` uses dual-bank semantics and fails. |

## Layout

```
firmware/
├── apps/
│   ├── common/
│   │   ├── lorawan_key_config.h                      ← Wrapper #include'ing the private header
│   │   ├── lorawan_key_config_private.example.h      ← Template you copy
│   │   └── lorawan_key_config_private.h              ← gitignored, your real DevEUI/AppKey
│   └── examples/08_lorawan_gnss/                     ← Main app (the only one we maintain)
├── t1000_e/peripherals/                              ← Board drivers (AG3335, QMA6100P, sensors)
├── smtc_hal/                                          ← Semtech HAL + Seeed extensions
├── lora_basics_modem/                                 ← Vendored Semtech LBM (unchanged)
├── pca10056/s140/08_ses_lorawan_gnss/                ← SEGGER Embedded Studio project
└── scripts/configure-sdk-path.mjs                    ← One-time SDK location setup
```

## Recovery if a flash goes bad

1. **DFU mode broken on the running app:** mag-tap-twice should always work as long as our LoRaWAN firmware is the running app (it doesn't consume USB events). If you ever add USB CDC, it may stop working.
2. **App misbehaves but bootloader works:** mag-tap → flash a previous known-good `.zip`.
3. **No path into DFU mode at all:** either drain the battery completely (several days unplugged, then cold plug + immediate mag-tap before app starts), or re-flash MeshCore via the [MeshCore Configurator](https://meshcore.co.uk/configurator/) BLE flow first to get a clean slate.
4. **Bootloader itself broken:** SWD probe via the unexposed pads is the last resort. The original Seeed bootloader UF2 is `firmware/firmware/t1000_e_bootloader_1th_ota_uf2.uf2` but reflashing this is dangerous — only attempt if everything else fails.

## Files in `firmware/firmware/` are NOT for flashing

Seeed ships prebuilt example `.uf2` files at `firmware/firmware/`. **All of them are built for US915** (and target other applications). Flashing them on a EU868 device is wrong on three levels: wrong region, possibly wrong app, and the bootloader UF2 in the same directory will replace the bootloader rather than the app.

## Firmware-level lessons learned

These are the non-obvious things real-world testing uncovered, in chronological order:

### Bootloader compatibility
Seeed's bootloader is the Adafruit nRF52 bootloader with three changes: `device_type=0x52`, `softdevice_req=0x123`, and relaxed signature requirements for unsigned packages carrying the right metadata. Mag-tap-twice DFU is *firmware-mediated*, not hardware; "quiet" apps that don't consume USB events keep it working.

### GPS chip wouldn't track satellites
Three things combined to fix it:
1. `$PAIR066,1,1,1,1,0,0*3A` — enables GPS+GLONASS+GALILEO+BDS. Chip may default to all-off or a prior firmware (Meshtastic / MeshCore) saved a partial constellation set to NVM.
2. `$PAIR513*3D` — saves config to NVM. Persists constellation choice across power cycles for faster cold-start.
3. Scan time 30 s → 90 s. AG3335 cold-start TTFF is 15–30 s in clear sky.

### GSV NMEA sentences disabled in chip NVM
Prior Meshtastic use likely saved `$PAIR062,3,0` (GSV OFF) plus `$PAIR513`. The parser never saw GSV, so `sats_in_view` was always 0 even on a working fix. Fix: `$PAIR062,3,1*3C` before `$PAIR513`.

### RTC wake vs hard reset
Seeed's `gnss_scan_start()` originally woke the chip from RTC backup mode via an RTC_INT pulse. MeshCore's `start_gps()` does a hard reset (RESET HIGH → LOW). Hard reset improved fix quality: 12 sats / HDOP 0.8 → 18 sats / HDOP 0.6.

### Stale-fix bug
`main_lorawan_gnss.c` had a static `lat`/`lon` only updated on successful fix. Subsequent failed fixes left it with old data — TTN would still see "valid" coordinates. Fix: zero out lat/lon when fix is invalid.

### NTC temperature reads ~10 °C cold
The `temp_c` field is biased cold by ~10–12 °C (observed 2.42 °C when actual ambient was 12–14 °C). Root cause: `t1000_e/peripherals/src/sensor.c` was reused from Seeed's industrial *heater*-probe reference (`HEATER_NTC_BX = 4250`, `HEATER_NTC_RP = 8250`); those constants don't match the thermistor + divider populated on the T1000-E PCB. Reading is monotonic and stable, so still useful as a *relative* indicator. To fix properly: capture raw `ntc_volt` at 3–4 known reference temps and back-solve for the right `RP` / `B`.

### Latent risk: AG3335 default baud is 9600
Per Airoha/LOCOSYS docs, the AG3335 ships with a default UART baud of **9600 bps**. The firmware listens at **115200 bps**. This works on devices that previously ran Meshtastic / MeshCore (which already sent the baud-change command and persisted it via `$PAIR513`). A brand-new T1000-E with factory-default GPS chip → chip outputs NMEA at 9600, our firmware listens at 115200, you'd see `uart_bytes_rx = 0` or garbage. Fix when it bites: add a baud-config step early in `gnss_scan_start()` that talks to the chip at 9600 first to set 115200, then re-init the UART. Relevant AG3335 command: `$PAIR864` (UART config) + `$PAIR513` to persist.

### `sats_tracked > sats_in_view` is expected
GGA's satellites_tracked is the cross-constellation count used in the current fix. The GSV `total_sats` we capture is whichever constellation's GSV sentence was parsed last (`$GPGSV`, `$GLGSV`, etc.) — only one constellation's count at a time. Aggregating across constellations would require accumulating GSV messages between `$xGSV,N,N,...` ranges, which we don't do.

### Power consumption tradeoff
v10 runs the GPS chip 90 s out of every 180 s = 50 % duty cycle for the AG3335. Battery life is much shorter than Meshtastic's "scan once, sleep long" pattern. Tuning options for the future: shorter scan with hot-restart from RTC backup (we removed RTC mode in v8; adding it back is a careful change), or motion-triggered scans (see Seeed's `11_lorawan_tracker` example).

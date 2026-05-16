// TTN payload decoder for the SenseCAP T1000-E custom firmware in this repo.
// Paste into TTN Console → device → Payload formatters → Uplink →
// Formatter type: "Custom JavaScript formatter".
//
// SYNC: this file is the TTN-console copy of webapp/src/lib/decoder.ts.
// They differ deliberately:
//   - This file emits `latitude` / `longitude` / `altitude` (no _m suffix)
//     and an extra `sats` alias because TTN auto-populates
//     locations.frm-payload + TTN Mapper integrations from those exact keys.
//   - The TS port uses DB-column naming (`altitude_m`, no `sats` alias)
//     because it's consumed by our webapp, not by TTN.
// When the byte layout changes, update both files in the same commit.
//
// Matches firmware payload v9 (26 bytes); v10 keeps the same payload, only
// the LoRa parameters (SF lock, period) differ.
//
//   0..3   latitude          int32, deg × 1e6
//   4..7   longitude         int32, deg × 1e6
//   8..9   altitude          int16, meters
//   10     hdop × 10         uint8
//   11     sats_tracked      uint8 (used in fix, from GGA)
//   12     sats_in_view      uint8 (last GSV's count, per-constellation)
//   13     fix_quality       uint8 (0=invalid, 1=GPS, 2=DGPS)
//   14     speed_kmh         uint8
//   15..16 uart_bytes_rx     uint16 (per-scan, capped 65535) — diagnostic
//   17..18 uart_lines_parsed uint16 (per-scan, capped 65535) — diagnostic
//   19     battery_pct       uint8  (0..100)
//   20..21 battery_mv        uint16 (millivolts)
//   22..23 temp_c_x100       int16  (°C × 100)
//   24     lux_pct           uint8  (0..100, ambient light)
//   25     flags             uint8  bit0 = motion_since_last_uplink

function decodeUplink(input) {
  if (input.bytes.length !== 26) {
    return { errors: ["Expected 26 bytes, got " + input.bytes.length] };
  }
  var b = input.bytes;
  var latRaw = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
  var lonRaw = (b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7];
  var fixQuality = b[13];
  var hasFix = fixQuality !== 0 && !(latRaw === 0 && lonRaw === 0);

  var altRaw = (b[8] << 8) | b[9];
  if (altRaw & 0x8000) altRaw = altRaw - 0x10000;
  var tempRaw = (b[22] << 8) | b[23];
  if (tempRaw & 0x8000) tempRaw = tempRaw - 0x10000;

  // Explicit null on no-fix mirrors the TS port; without this, downstream
  // consumers had to feature-test the keys instead of just checking for null.
  var data = {
    latitude:          hasFix ? latRaw / 1e6 : null,
    longitude:         hasFix ? lonRaw / 1e6 : null,
    altitude:          altRaw,
    hdop:              b[10] / 10,
    sats_tracked:      b[11],
    sats_in_view:      b[12],
    sats:              b[11], // TTN Mapper integration historically reads `sats`
    fix_quality:       fixQuality,
    speed_kmh:         b[14],
    uart_bytes_rx:     (b[15] << 8) | b[16],
    uart_lines_parsed: (b[17] << 8) | b[18],
    battery_pct:       b[19],
    battery_mv:        (b[20] << 8) | b[21],
    temp_c:            tempRaw / 100,
    lux_pct:           b[24],
    motion:            (b[25] & 0x01) === 0x01
  };

  var warnings = [];

  if (data.battery_pct < 20) {
    warnings.push("Low battery: " + data.battery_pct + "% (" + data.battery_mv + " mV)");
  }

  if (!hasFix) {
    var warn;
    if (data.uart_bytes_rx === 0) {
      warn = "UART RX dead - no bytes received from GPS chip";
    } else if (data.uart_lines_parsed === 0) {
      warn = "UART receiving (" + data.uart_bytes_rx + " bytes) but no NMEA lines parsed";
    } else if (data.sats_in_view === 0 && data.sats_tracked === 0) {
      warn = "NMEA flowing (" + data.uart_lines_parsed + " lines) but chip reports no sats";
    } else {
      warn = "Chip sees " + (data.sats_tracked || data.sats_in_view) + " sats, waiting for fix";
    }
    warnings.push(warn);
  }

  if (warnings.length) return { warnings: warnings, data: data };
  return { data: data };
}

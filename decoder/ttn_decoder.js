// TTN payload decoder for SenseCAP T1000-E custom LoRaWAN firmware.
// Paste into TTN Console → device → Payload formatters → Uplink →
// Formatter type: "Custom JavaScript formatter".
//
// Matches firmware payload layout in apps/examples/08_lorawan_gnss/main_lorawan_gnss.c
// (gnss_ttn_v9). v8 was 19 bytes; v9 appends 7 bytes of environment data.
//
// 26-byte payload, all multi-byte fields big-endian:
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
  var lat = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) / 1e6;
  var lon = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) / 1e6;
  var altRaw = (b[8] << 8) | b[9];
  if (altRaw & 0x8000) altRaw = altRaw - 0x10000;
  var tempRaw = (b[22] << 8) | b[23];
  if (tempRaw & 0x8000) tempRaw = tempRaw - 0x10000;

  var data = {
    altitude:          altRaw,
    hdop:              b[10] / 10,
    sats_tracked:      b[11],
    sats_in_view:      b[12],
    sats:              b[11], // alias TTN Mapper prefers
    fix_quality:       b[13],
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

  if (b[13] === 0 || (lat === 0 && lon === 0)) {
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
    return { warnings: warnings, data: data };
  }

  data.latitude = lat;
  data.longitude = lon;
  if (warnings.length) return { warnings: warnings, data: data };
  return { data: data };
}

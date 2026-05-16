/*!
 * Per-device LoRaWAN credentials and region. Copy this file to
 *
 *   lorawan_key_config_private.h
 *
 * (which is gitignored) and fill in the values from your TTN console:
 *   TTN -> your application -> end device -> "MAC settings" / "Activation".
 *
 * The crypto element supports both 1.0.x and 1.1.x LoRaWAN versions. The
 * Semtech LBM API names match 1.1.x; mapping vs 1.0.x:
 *   LORAWAN_DEVICE_EUI = both
 *   LORAWAN_JOIN_EUI   = 1.0.x AppEUI
 *   LORAWAN_APP_KEY    = 1.0.x AppKey (also 1.1.x NwkKey)
 */

#ifndef LORAWAN_KEY_CONFIG_PRIVATE_H
#define LORAWAN_KEY_CONFIG_PRIVATE_H

/* Region. See smtc_modem_region_t.
 * Common choices: SMTC_MODEM_REGION_EU_868, _US_915, _AU_915, _AS_923_GRP1, _KR_920, _IN_865.
 */
#define LORAWAN_REGION      SMTC_MODEM_REGION_EU_868

/* Class. Almost always Class A for battery-powered trackers. */
#define LORAWAN_CLASS       SMTC_MODEM_CLASS_A

/* 16-hex-char DevEUI (8 bytes). You pick this when registering the end
 * device in TTN — typical practice is either to derive one from the Seeed
 * OUI prefix `70B3D5` plus a per-device serial, or accept the random one
 * TTN suggests. The same value goes into your TTN device registration. */
#define LORAWAN_DEVICE_EUI  "0000000000000000"

/* 16-hex-char JoinEUI (8 bytes). Zeros is fine for community TTN — match the
 * value you set on the TTN device. */
#define LORAWAN_JOIN_EUI    "0000000000000000"

/* 32-hex-char AppKey (16 bytes). Copy from TTN; treat like a password. */
#define LORAWAN_APP_KEY     "00000000000000000000000000000000"

#endif  /* LORAWAN_KEY_CONFIG_PRIVATE_H */

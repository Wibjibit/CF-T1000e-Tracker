#ifndef MAIN_LORAWAN_GNSS_H
#define MAIN_LORAWAN_GNSS_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * -----------------------------------------------------------------------------
 * --- DEPENDENCIES ------------------------------------------------------------
 */

#include <stdint.h>

/*
 * -----------------------------------------------------------------------------
 * --- PUBLIC MACROS -----------------------------------------------------------
 */

/*
 * -----------------------------------------------------------------------------
 * --- PUBLIC CONSTANTS --------------------------------------------------------
 */

/*!
 * @brief Defines the application data transmission duty cycle. 180s, value in [s].
 * v10: bumped from 120s -> 180s to stay under EU868's 1% airtime limit when
 * ADR is pinned to SF12 (DR0). SF12 + 26-byte payload = ~1.5s airtime; at
 * 180s cadence that's ~0.83% duty cycle, comfortably legal with headroom
 * for the join + occasional MAC-command uplinks.
 */
#define GNSS_SCAN_PERIOD_DEFAULT 180

/*!
 * @brief Defines the application gnss scan time. 90s, value in [s].
 * AG3335 cold-start TTFF is typically 25-30s in clear sky; allow margin.
 */
#define GNSS_SCAN_TIME 90

/*!
 * @brief LoRaWAN application port
 */
#define LORAWAN_APP_PORT 2

/*!
 * @brief User application data buffer size
 */
#define LORAWAN_APP_DATA_MAX_SIZE 242

/*!
 * @brief If true, then the system will not power down all peripherals when going to low power mode. This is necessary
 * to keep the LEDs active in low power mode.
 */
#define APP_PARTIAL_SLEEP true

/*
 * -----------------------------------------------------------------------------
 * --- LoRaWAN Configuration ---------------------------------------------------
 */

/*!
 * @brief LoRaWAN confirmed messages
 */
#define LORAWAN_CONFIRMED_MSG_ON false

/*
 * -----------------------------------------------------------------------------
 * --- PUBLIC TYPES ------------------------------------------------------------
 */

/*
 * -----------------------------------------------------------------------------
 * --- PUBLIC FUNCTIONS PROTOTYPES ---------------------------------------------
 */

#ifdef __cplusplus
}
#endif

#endif  // MAIN_TRACKER_H

/* --- EOF ------------------------------------------------------------------ */

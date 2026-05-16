
#ifndef __PERIPHERAL_AG3335_H__
#define __PERIPHERAL_AG3335_H__

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/*!
 * @brief Init gnss
 */
void gnss_init( void );

/*!
 * @brief Start gnss scan
 */
bool gnss_scan_start( void );

/*!
 * @brief Stop gnss scan
 */
void gnss_scan_stop( void );

/*!
 * @brief Get gnss fix status
 * 
 * @return Fix status
 */
bool gnss_get_fix_status( void );

/*!
 * @brief Get gnss fix status
 * 
 * @param [out] lat Pointer to buffer to be saved for latitude
 * @param [out] lon Pointer to buffer to be saved for longitude
 */
void gnss_get_position( int32_t *lat, int32_t *lon );

/*!
 * @brief Get extended gnss telemetry from the last parsed GGA + GSV + RMC sentences
 *
 * @param [out] altitude_m     Altitude above MSL in meters (int16, clamped)
 * @param [out] hdop_x10       Horizontal dilution of precision × 10 (uint8, clamped)
 * @param [out] sats_tracked   Satellites used in current fix (uint8, from GGA)
 * @param [out] sats_in_view   Satellites visible to the antenna (uint8, from GSV)
 * @param [out] fix_quality    GGA fix quality (0=invalid, 1=GPS, 2=DGPS, ...)
 * @param [out] speed_kmh      Ground speed in km/h (uint8, clamped)
 */
void gnss_get_telemetry( int16_t *altitude_m, uint8_t *hdop_x10, uint8_t *sats_tracked, uint8_t *sats_in_view, uint8_t *fix_quality, uint8_t *speed_kmh );

/*!
 * @brief Parse gnss nmea data
 * 
 * @param [in] nmea Pointer to buffer to be parsed
 */
void gnss_parse_handler( char *nmea );

#ifdef __cplusplus
}
#endif

#endif

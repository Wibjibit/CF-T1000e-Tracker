
#include "smtc_hal.h"
#include "minmea.h"

#define GPS_INFO_PRINTF false

#define MINMEA_MAX_SENTENCE_LENGTH  128
static char gps_nmea_line[MINMEA_MAX_SENTENCE_LENGTH] = { 0 };

static struct minmea_sentence_rmc frame_rmc;
static struct minmea_sentence_gga frame_gga;
static struct minmea_sentence_gst frame_gst;
static struct minmea_sentence_gsv frame_gsv;
static struct minmea_sentence_vtg frame_vtg;
static struct minmea_sentence_zda frame_zda;

static int32_t latitude_i32 = 0, longitude_i32 = 0, speed_i32 = 0;

static uint8_t app_nmea_check_sum( char *buf )
{
    uint8_t i = 0;
    uint8_t chk = 0;
    uint8_t len = strlen( buf );

	for( chk=buf[1], i = 2; i < len; i++ )
	{
		chk ^= buf[i];
	}

	return chk;
}

void gnss_nmea_parse_line( char *line )
{
    // PRINTF( "%s\r\n", line );
    switch( minmea_sentence_id( line, false ))
    {
        case MINMEA_SENTENCE_RMC: // use for app
        {
            if( minmea_parse_rmc( &frame_rmc, line ))
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxRMC: raw coordinates and speed: (%d/%d,%d/%d) %d/%d\r\n",
                        frame_rmc.latitude.value, frame_rmc.latitude.scale,
                        frame_rmc.longitude.value, frame_rmc.longitude.scale,
                        frame_rmc.speed.value, frame_rmc.speed.scale );
                PRINTF( "$xxRMC fixed-point coordinates and speed scaled to three decimal places: (%d,%d) %d\r\n",
                        minmea_rescale( &frame_rmc.latitude, 1000 ),
                        minmea_rescale( &frame_rmc.longitude, 1000 ),
                        minmea_rescale( &frame_rmc.speed, 1000 ));
                PRINTF( "$xxRMC floating point degree coordinates and speed: (%f,%f) %f\r\n",
                        minmea_tocoord( &frame_rmc.latitude ),
                        minmea_tocoord( &frame_rmc.longitude ),
                        minmea_tofloat( &frame_rmc.speed ));
#endif
            }
            else
            {
#if GPS_INFO_PRINTF
                PRINTF(  "$xxRMC sentence is not parsed\r\n" );
#endif
            }
            break;
        }

        case MINMEA_SENTENCE_GGA: // use for app
        {
            if( minmea_parse_gga( &frame_gga, line ))
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxGGA: fix quality: %d\r\n", frame_gga.fix_quality );
#endif
            }
            else
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxGGA sentence is not parsed\r\n" );
#endif
            }
            break;
        }

        case MINMEA_SENTENCE_GST:
        {
            if( minmea_parse_gst( &frame_gst, line ))
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxGST: raw latitude,longitude and altitude error deviation: (%d/%d,%d/%d,%d/%d)\r\n",
                        frame_gst.latitude_error_deviation.value, frame_gst.latitude_error_deviation.scale,
                        frame_gst.longitude_error_deviation.value, frame_gst.longitude_error_deviation.scale,
                        frame_gst.altitude_error_deviation.value, frame_gst.altitude_error_deviation.scale );
                PRINTF( "$xxGST fixed point latitude,longitude and altitude error deviation"
                        " scaled to one decimal place: (%d,%d,%d)\r\n",
                        minmea_rescale( &frame_gst.latitude_error_deviation, 10 ),
                        minmea_rescale( &frame_gst.longitude_error_deviation, 10 ),
                        minmea_rescale( &frame_gst.altitude_error_deviation, 10 ));
                PRINTF( "$xxGST floating point degree latitude, longitude and altitude error deviation: (%f,%f,%f)\r\n",
                        minmea_tofloat( &frame_gst.latitude_error_deviation ),
                        minmea_tofloat( &frame_gst.longitude_error_deviation ),
                        minmea_tofloat( &frame_gst.altitude_error_deviation ));
#endif
            }
            else
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxGST sentence is not parsed\r\n" );
#endif
            }
            break;
        }

        case MINMEA_SENTENCE_GSV:
        {
            if( minmea_parse_gsv( &frame_gsv, line ))
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxGSV: message %d of %d\r\n", frame_gsv.msg_nr, frame_gsv.total_msgs );
                PRINTF( "$xxGSV: satellites in view: %d\r\n", frame_gsv.total_sats );
                for( int i = 0; i < 4; i++ )
                    PRINTF( "$xxGSV: sat nr %d, elevation: %d, azimuth: %d, snr: %d dbm\r\n",
                        frame_gsv.sats[i].nr,
                        frame_gsv.sats[i].elevation,
                        frame_gsv.sats[i].azimuth,
                        frame_gsv.sats[i].snr );
#endif
            }
            else
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxGSV sentence is not parsed\r\n");
#endif
            }
            break;
        }

        case MINMEA_SENTENCE_VTG:
        {
            if( minmea_parse_vtg( &frame_vtg, line ))
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxVTG: true track degrees = %f\r\n",
                        minmea_tofloat( &frame_vtg.true_track_degrees ));
                PRINTF( "        magnetic track degrees = %f\r\n",
                        minmea_tofloat( &frame_vtg.magnetic_track_degrees ));
                PRINTF( "        speed knots = %f\r\n",
                        minmea_tofloat( &frame_vtg.speed_knots ));
                PRINTF( "        speed kph = %f\r\n",
                        minmea_tofloat( &frame_vtg.speed_kph ));
#endif
            }
            else
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxVTG sentence is not parsed\r\n" );
#endif
            }
            break;
        }

        case MINMEA_SENTENCE_ZDA: // use for app
        {
            if( minmea_parse_zda( &frame_zda, line ))
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxZDA: %d:%d:%d %02d.%02d.%d UTC%+03d:%02d\r\n",
                        frame_zda.time.hours,
                        frame_zda.time.minutes,
                        frame_zda.time.seconds,
                        frame_zda.date.day,
                        frame_zda.date.month,
                        frame_zda.date.year,
                        frame_zda.hour_offset,
                        frame_zda.minute_offset );
#endif
            }
            else
            {
#if GPS_INFO_PRINTF
                PRINTF( "$xxZDA sentence is not parsed\r\n" );
#endif
            }
            break;
        }

        case MINMEA_INVALID:
        {
#if GPS_INFO_PRINTF
            PRINTF( "$xxxxx sentence is not valid\r\n" );
#endif
        }
        break;

        default:
        {
#if GPS_INFO_PRINTF
            PRINTF( "$xxxxx sentence is not parsed\r\n" );
#endif
        }
        break;
    }
}

void gnss_nmea_parse( char *str )
{
    uint16_t len = strlen( str );
    uint16_t begin = 0, end = 0;
    for( uint16_t i = 0; i < len; i++ )
    {
        if( str[i] == '$' ) begin = i;
        if( str[i] == '\r' ) end = i;

        if( end && end > begin )
        {
            memset( gps_nmea_line, 0, sizeof( gps_nmea_line ));
            memcpy( gps_nmea_line, str + begin, end - begin );
            if( strncmp( gps_nmea_line,"$PAIR",5 ) == 0 ) // ag3335 cmd parse
            {
                //TODO get version
            }
            else
            {
                gnss_nmea_parse_line( gps_nmea_line );  //          
            }
            begin = 0;
            end = 0;
        }
    }
}

void gnss_init( void )
{
    // Enable the SENSE 3.3V rail (P1.06) — powers the GPS antenna LNA / RF front-end.
    // Meshtastic's variant.cpp enables this on boot; Seeed's board init leaves it LOW,
    // which is why the GPS chip runs and outputs NMEA but reports 0 satellites in view.
    hal_gpio_init_out( SENSE_POWER_EN, HAL_GPIO_SET );
    hal_mcu_wait_ms( 10 );

    hal_gpio_init_out( AG3335_POWER_EN, HAL_GPIO_SET ); // GPS_POWER_EN_PIN
    hal_mcu_wait_ms( 10 );
    hal_gpio_init_out( AG3335_VRTC_EN, HAL_GPIO_SET ); // GPS_VRTC_EN_PIN
    hal_mcu_wait_ms( 10 );

    hal_gpio_init_out( AG3335_RESET, HAL_GPIO_SET ); // GPS_RST_PIN, reset by high
    hal_mcu_wait_ms( 10 );
    hal_gpio_set_value( AG3335_RESET, HAL_GPIO_RESET );

    hal_gpio_init_out( AG3335_SLEEP_INT, HAL_GPIO_SET ); // GPS_SLEEP_INT_PIN, set GPS quit sleep mode, low active
    hal_gpio_init_out( AG3335_RTC_INT, HAL_GPIO_RESET ); // GPS_RTC_INT_PIN, set GPS quit rtc mode, high pulse(1ms)active
    hal_gpio_init_in( AG3335_RESETB_OUT, HAL_GPIO_PULL_MODE_UP, HAL_GPIO_IRQ_MODE_OFF, NULL ); // GPS_RESETB_OUT_PIN, gps reset ok, to mcu
}

void gnss_scan_lock_sleep( void )
{
    char command[32] = { 0 };
    uint8_t check_sum = app_nmea_check_sum( "$PAIR382,1" );
    sprintf( command, "$PAIR382,1*%02X\r\n", check_sum );
    for( uint8_t i = 0; i < 25; i++ )
    {
        hal_uart_0_tx(( uint8_t *)command, strlen( command ));
        hal_mcu_wait_ms( 40 );
    }
}

void gnss_scan_unlock_sleep( void )
{
    char command[32] = { 0 };
    uint8_t check_sum = app_nmea_check_sum( "$PAIR382,0" );
    sprintf( command, "$PAIR382,0*%02X\r\n", check_sum );
    for( uint8_t i = 0; i < 4; i++ )
    {
        hal_uart_0_tx(( uint8_t *)command, strlen( command ));
        hal_mcu_wait_ms( 40 );
    }
}

void gnss_scan_enter_rtc_mode( void )
{
    char *command = "$PAIR650,0*25\r\n";
    for( uint8_t i = 0; i < 25; i++ )
    {
        hal_uart_0_tx(( uint8_t *)command, strlen( command ));
        hal_mcu_wait_ms( 40 );
    }
}

void gnss_scan_clean( void )
{
    memset( &frame_rmc, 0, sizeof( struct minmea_sentence_rmc ));
    memset( &frame_gga, 0, sizeof( struct minmea_sentence_gga ));
    memset( &frame_gst, 0, sizeof( struct minmea_sentence_gst ));
    memset( &frame_gsv, 0, sizeof( struct minmea_sentence_gsv ));
    memset( &frame_vtg, 0, sizeof( struct minmea_sentence_vtg ));
    memset( &frame_zda, 0, sizeof( struct minmea_sentence_zda ));
    // Clear cached fix values so stale data is not reported on subsequent failed scans.
    latitude_i32  = 0;
    longitude_i32 = 0;
    speed_i32     = 0;
}

extern volatile uint32_t g_uart0_bytes_rx;
extern volatile uint32_t g_uart0_lines_parsed;

bool gnss_scan_start( void )
{
    gnss_scan_clean( );

    // Reset diagnostic counters so per-scan stats are visible in uplinks.
    g_uart0_bytes_rx     = 0;
    g_uart0_lines_parsed = 0;

    hal_uart_0_init( );

    // Power on, then hard-reset the chip. Matches MeshCore's start_gps() flow.
    // Avoids the RTC-wake path which appears to leave the chip in a state where
    // it streams NMEA but doesn't reacquire reliably.
    hal_gpio_set_value( AG3335_POWER_EN, HAL_GPIO_SET );
    hal_mcu_wait_ms( 10 );
    hal_gpio_set_value( AG3335_RESET, HAL_GPIO_SET );    // hold in reset
    hal_mcu_wait_ms( 10 );
    hal_gpio_set_value( AG3335_RESET, HAL_GPIO_RESET );  // release reset
    hal_mcu_wait_ms( 200 ); // give chip time to come up before sending commands

    gnss_scan_lock_sleep( );

    // Enable constellations: GPS + GLONASS + GALILEO + BDS (QZSS/NAVIC off).
    hal_mcu_wait_ms( 100 );
    char *constellation_cmd = "$PAIR066,1,1,1,1,0,0*3A\r\n";
    for( uint8_t i = 0; i < 5; i++ )
    {
        hal_uart_0_tx(( uint8_t *)constellation_cmd, strlen( constellation_cmd ));
        hal_mcu_wait_ms( 50 );
    }

    // Enable GSV NMEA output so sats_in_view reports a non-zero value.
    // Prior Meshtastic/MeshCore use may have saved $PAIR062,3,0 (GSV OFF)
    // to NVM, suppressing GSV permanently. Re-enable it.
    char *gsv_on_cmd = "$PAIR062,3,1*3C\r\n";
    hal_uart_0_tx(( uint8_t *)gsv_on_cmd, strlen( gsv_on_cmd ));
    hal_mcu_wait_ms( 50 );

    // Persist updated NMEA + constellation config to NVM for fast subsequent starts.
    char *save_cmd = "$PAIR513*3D\r\n";
    hal_uart_0_tx(( uint8_t *)save_cmd, strlen( save_cmd ));
    hal_mcu_wait_ms( 100 );

    return true;
}

void gnss_scan_stop( void )
{
    // Skip enter_rtc_mode — we hard-reset on scan_start now, so the chip's
    // RTC backup state isn't relied on. Just unlock sleep, then power off.
    gnss_scan_unlock_sleep( );
    hal_mcu_wait_ms( 20 );
    hal_gpio_set_value( AG3335_POWER_EN, HAL_GPIO_RESET );
    hal_uart_0_deinit( );
}

bool gnss_get_fix_status( void )
{
    bool result = false;
    float latitude = 0, longitude = 0, speed = 0;

    if( frame_rmc.latitude.scale && frame_rmc.longitude.scale && frame_rmc.speed.scale )
    {
        latitude = minmea_tocoord( &frame_rmc.latitude );
        longitude = minmea_tocoord( &frame_rmc.longitude );
        speed = minmea_tofloat( &frame_rmc.speed );
        if( latitude <= 180 && longitude <= 360 )
        {
            latitude *= 1000000;
            longitude *= 1000000;
            speed *= 1000000;

            latitude_i32 = latitude;
            longitude_i32 = longitude;
            speed_i32 = speed;

            result =  true;
        }
    }

    return result;
}

void gnss_get_position( int32_t *lat, int32_t *lon )
{
    *lat = latitude_i32;
    *lon = longitude_i32;
}

void gnss_get_telemetry( int16_t *altitude_m, uint8_t *hdop_x10, uint8_t *sats_tracked, uint8_t *sats_in_view, uint8_t *fix_quality, uint8_t *speed_kmh )
{
    *altitude_m   = 0;
    *hdop_x10     = 0;
    *sats_tracked = 0;
    *sats_in_view = 0;
    *fix_quality  = 0;
    *speed_kmh    = 0;

    // GGA: fix quality, satellites used in fix, HDOP, altitude. Report even when no fix.
    *fix_quality  = ( uint8_t ) frame_gga.fix_quality;
    *sats_tracked = ( uint8_t ) frame_gga.satellites_tracked;

    if( frame_gga.hdop.scale )
    {
        float h = minmea_tofloat( &frame_gga.hdop ) * 10.0f;
        if( h < 0 )   h = 0;
        if( h > 255 ) h = 255;
        *hdop_x10 = ( uint8_t ) h;
    }

    if( frame_gga.altitude.scale )
    {
        float a = minmea_tofloat( &frame_gga.altitude );
        if( a < -32768 ) a = -32768;
        if( a > 32767 )  a = 32767;
        *altitude_m = ( int16_t ) a;
    }

    // GSV: total satellites visible to antenna (whether or not used in fix). Key diagnostic.
    *sats_in_view = ( uint8_t ) frame_gsv.total_sats;

    // RMC: ground speed
    if( frame_rmc.speed.scale )
    {
        float kmh = minmea_tofloat( &frame_rmc.speed ) * 1.852f;
        if( kmh < 0 )   kmh = 0;
        if( kmh > 255 ) kmh = 255;
        *speed_kmh = ( uint8_t ) kmh;
    }
}

void gnss_parse_handler( char *nmea )
{
    gnss_nmea_parse( nmea );
}
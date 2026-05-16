/*!
 * @file      lorawan_key_config.h
 *
 * @brief     End device LoRaWAN key configuration — wrapper.
 *
 * Per-device credentials (DevEUI, JoinEUI, AppKey) and region selection live
 * in a sibling header `lorawan_key_config_private.h` which is gitignored.
 *
 * To set up a fresh checkout:
 *
 *   cp lorawan_key_config_private.example.h lorawan_key_config_private.h
 *   # edit lorawan_key_config_private.h with your TTN values
 *
 * The example template explains every macro. The Semtech BSD license below
 * still applies to this wrapper as Seeed's original file did.
 *
 * The Clear BSD License
 * Copyright Semtech Corporation 2021. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted (subject to the limitations in the disclaimer
 * below) provided that the following conditions are met:
 *     * Redistributions of source code must retain the above copyright
 *       notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright
 *       notice, this list of conditions and the following disclaimer in the
 *       documentation and/or other materials provided with the distribution.
 *     * Neither the name of the Semtech corporation nor the
 *       names of its contributors may be used to endorse or promote products
 *       derived from this software without specific prior written permission.
 *
 * NO EXPRESS OR IMPLIED LICENSES TO ANY PARTY'S PATENT RIGHTS ARE GRANTED BY
 * THIS LICENSE. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
 * CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT
 * NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
 * PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL SEMTECH CORPORATION BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

#ifndef LORAWAN_KEY_CONFIG_H
#define LORAWAN_KEY_CONFIG_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

/* Credentials are pulled from a sibling header that is gitignored. The build
 * will fail at this include if you haven't copied the .example template to
 * the real name yet — that's intentional, fail-fast beats baking placeholders
 * into a firmware image.
 */
#include "lorawan_key_config_private.h"

#ifdef __cplusplus
}
#endif

#endif  /* LORAWAN_KEY_CONFIG_H */

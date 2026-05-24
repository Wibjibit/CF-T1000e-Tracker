-- One row per PHYSICAL device. Identity, not transport (see
-- docs/architecture.md "Core insight"). A device exists regardless of which
-- networks it currently reports through; tracking mechanisms attach to it via
-- device_sources. device_id is a deliberately opaque slug, NOT the LoRa
-- DevEUI, so a device that changes radio / DevEUI stays one logical device.

CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT    NOT NULL PRIMARY KEY,  -- opaque slug, e.g. 't1000e-<deveui>'
    display_name  TEXT    NOT NULL,
    notes         TEXT,
    added_at      INTEGER NOT NULL               -- unix epoch ms, UTC
);

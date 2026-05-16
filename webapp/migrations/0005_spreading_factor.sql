-- Capture the LoRa spreading factor TTN reports per uplink, sourced from
-- uplink_message.settings.data_rate.lora.spreading_factor. Nullable because
-- pre-existing rows don't carry it (and TTN occasionally omits settings for
-- e.g. confirmed-ack or class-C scheduling chatter we'd reject anyway).

ALTER TABLE uplinks ADD COLUMN spreading_factor INTEGER;

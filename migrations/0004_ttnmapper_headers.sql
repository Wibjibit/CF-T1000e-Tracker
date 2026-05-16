-- TTN Mapper's TTS v3 integration requires the contributor's email in a
-- TTNMAPPERORG-USER request header (see TheThingsNetwork/lorawan-webhook-
-- templates/ttnmapper.yml). The optional TTNMAPPERORG-EXPERIMENT header tags
-- traffic as test data so it doesn't pollute the main coverage map.

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('ttnmapper_email',      '', 0),
    ('ttnmapper_experiment', '', 0);

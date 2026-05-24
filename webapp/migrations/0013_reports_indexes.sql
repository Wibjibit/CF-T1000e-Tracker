-- Map/timeline read performance for `reports`.
--
-- /api/points scans `received_at >= ? [AND device_id = ?] ORDER BY received_at
-- DESC LIMIT ?`. The map now fetches ALL devices for a range (toggling layers
-- client-side), and the timeline filters by one device — so index both shapes:
--   - (received_at)              serves the all-devices range scan + ORDER BY.
--   - (device_id, received_at)   serves the single-device timeline query.
-- The existing UNIQUE(source_id, received_at) index doesn't help either query
-- (wrong leading column). Both are cheap and additive.

CREATE INDEX IF NOT EXISTS idx_reports_received_at
    ON reports (received_at);

CREATE INDEX IF NOT EXISTS idx_reports_device_received
    ON reports (device_id, received_at);

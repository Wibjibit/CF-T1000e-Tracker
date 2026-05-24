-- Phase 4 — static-EID liveness: per-source EID-window refresh tracking.
--
-- The Find Hub refresh cron (UploadPrecomputedPublicKeyIds) slides each MCU
-- tracker's precomputed-EID window forward to [now-3h, now+4d]. Without a
-- refresh the tag falls off Find Hub ~4 days after the last one (the
-- max_truncated_eid_seconds_server window — master-plan §1.1).
--
-- `last_refreshed_at` records the unix-epoch-ms of the last SUCCESSFUL refresh
-- for a findhub source. The /sources UI derives "EID valid until" = this + 4d
-- and flags a stale window; the cron's record-only alerting (master-plan §1.6)
-- reads it alongside accounts.last_error. Additive; existing rows stay NULL
-- (never refreshed) until the first successful tick.

ALTER TABLE device_sources ADD COLUMN last_refreshed_at INTEGER;  -- unix epoch ms of last successful EID-window refresh; NULL = never

-- Phase 3.3 — account credential idempotency + auth-health surfacing.
--
-- Two additive changes to `accounts`, both serving the bootstrap import and the
-- settings UI:
--
-- 1. UNIQUE(provider, account_label) — the anchor that makes
--    scripts/import-google-account.mjs idempotent and RE-RUNNABLE. Re-importing
--    the same Google account (e.g. after an owner_key version bump, risk 1.6.2)
--    upserts the one row via `ON CONFLICT(provider, account_label) DO UPDATE`
--    instead of piling up duplicate credential rows. There is no account yet,
--    so creating the index can never fail on a pre-existing duplicate.
--
-- 2. last_error / last_attempt_at — so a failed credential use (a revoked
--    Master Token, risk 1.6.1) is VISIBLE. The Find Hub poller DO records the
--    error here on a failed tick and clears it on a successful one; the settings
--    page renders it as the account's auth-health badge. This is the Phase 3.3
--    "an induced auth failure surfaces in settings" exit criterion; the Phase 4
--    email/Pushover alerting builds on the same two columns.

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_label
    ON accounts (provider, account_label);

ALTER TABLE accounts ADD COLUMN last_error TEXT;          -- last credential-use error; NULL = healthy
ALTER TABLE accounts ADD COLUMN last_attempt_at INTEGER;  -- unix epoch ms of the last poll attempt (ok or not)

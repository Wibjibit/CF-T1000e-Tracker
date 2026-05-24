-- One row per (provider, account-identity) pair. Holds the encrypted
-- credentials needed to call a provider's API (Google Master Token, Apple ID
-- token, Maps cookies, ...). Decoupled from device_sources so one Google login
-- covers many devices and re-auth / key rotation touches ONE row, not N.
--
-- Credentials at rest (see docs/architecture.md "Credentials at rest"):
-- AES-GCM via WebCrypto against the BLOB_ENC_KEY Workers Secret. The 12-byte
-- nonce and the ciphertext live in SEPARATE BLOB columns by design -- never
-- collapse them into one column with an inline IV. All access goes through
-- src/lib/crypto/blob.ts; no ad-hoc WebCrypto in handlers.

CREATE TABLE IF NOT EXISTS accounts (
    account_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider                TEXT    NOT NULL,            -- 'google' | 'apple' | 'google_maps_sharing' | ...
    account_label           TEXT    NOT NULL,            -- human-readable, e.g. 'personal gmail'
    credentials_nonce       BLOB    NOT NULL,            -- 12 bytes, AES-GCM IV
    credentials_ciphertext  BLOB    NOT NULL,            -- AES-GCM-encrypted JSON credential blob
    key_version             INTEGER NOT NULL DEFAULT 1,  -- bumps on BLOB_ENC_KEY rotation
    added_at                INTEGER NOT NULL,            -- unix epoch ms, UTC
    last_refreshed_at       INTEGER                      -- unix epoch ms of last successful credential use
);

-- Sliding-window rate limit for /api/auth/verify. One row per attempt; old
-- rows expire on read (DELETE WHERE ts < cutoff) before the count query.
-- IP comes from cf-connecting-ip on incoming requests.

CREATE TABLE IF NOT EXISTS auth_attempts (
    ip  TEXT    NOT NULL,
    ts  INTEGER NOT NULL  -- unix epoch ms
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip_ts ON auth_attempts (ip, ts);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_ts    ON auth_attempts (ts);

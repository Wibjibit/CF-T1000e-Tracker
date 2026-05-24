// EID-window constants + status math — dependency-free on purpose.
//
// Split out of refresh.ts so the Astro site (the /sources page) can show
// "EID valid until / stale" WITHOUT pulling the whole @noble crypto stack
// (curve/AES) into the site bundle. refresh.ts re-exports these so its own
// importers are unaffected.

/** SpotApi/CreateBleDevice/config.py: hours_to_seconds(4*24) — the server-side
 *  truncated-EID window. A refresh must re-cover this many seconds. */
export const MAX_TRUNCATED_EID_SECONDS_SERVER = 4 * 24 * 3600; // 345600

/** `refresh_custom_trackers` backdates the window start by 3h so a just-missed
 *  rotation boundary still overlaps (master-plan §1.4). */
export const REFRESH_BACKDATE_SECONDS = 3 * 3600; // 10800

/** When the current precomputed-EID window expires: last successful refresh +
 *  the 4-day server window. (Slightly conservative — the real last bucket is
 *  ~3h earlier due to the backdate — but that margin only helps.) */
export function eidWindowValidUntilMs(lastRefreshedAtMs: number): number {
  return lastRefreshedAtMs + MAX_TRUNCATED_EID_SECONDS_SERVER * 1000;
}

/**
 * Whether a findhub source's EID window is stale enough to surface a warning:
 * never refreshed (null), or within `marginMs` of expiry (or past it). The cron
 * runs daily, so a default 24h margin flags trouble a full day before the tag
 * would actually drop off Find Hub.
 */
export function isEidWindowStale(
  lastRefreshedAtMs: number | null,
  nowMs: number,
  marginMs = 24 * 3600 * 1000,
): boolean {
  if (lastRefreshedAtMs == null) return true;
  return nowMs >= eidWindowValidUntilMs(lastRefreshedAtMs) - marginMs;
}

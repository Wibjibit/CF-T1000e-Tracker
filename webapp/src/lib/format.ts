// Small formatting helpers shared between SSR pages and client-side scripts.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function formatAgo(thenMs: number, nowMs: number = Date.now()): string {
  const diff = nowMs - thenMs;
  if (!Number.isFinite(diff) || diff < 0) return 'in the future';
  if (diff < MIN)  return `${Math.floor(diff / 1000)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY)  return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

export function formatLatLon(lat: number, lon: number, decimals: number = 5): string {
  return `${lat.toFixed(decimals)}, ${lon.toFixed(decimals)}`;
}

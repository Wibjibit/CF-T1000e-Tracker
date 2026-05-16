// Time-range parsing for the read API. The client-side counterpart
// (`webapp/src/scripts/dashboard.ts`) keeps its own VALID_RANGES list since
// it can't import server-side modules into bundled page scripts cleanly.
// Keep the two lists in sync.

export type Range = '1h' | '6h' | '24h' | '7d' | '30d' | 'all';

const MS = 1000;
const HOUR = 60 * 60 * MS;
const DAY = 24 * HOUR;

export const RANGES: Range[] = ['1h', '6h', '24h', '7d', '30d', 'all'];

export function isRange(v: unknown): v is Range {
  return typeof v === 'string' && (RANGES as string[]).includes(v);
}

/**
 * Resolve a range query into a unix-ms "since" bound. `all` returns 0.
 * Falls back to '24h' for unknown values.
 */
export function rangeToSinceMs(range: Range, now: number = Date.now()): number {
  switch (range) {
    case 'all': return 0;
    case '30d': return now - 30 * DAY;
    case '7d':  return now -  7 * DAY;
    case '24h': return now - 24 * HOUR;
    case '6h':  return now -  6 * HOUR;
    case '1h':  return now -      HOUR;
    default:    return now - 24 * HOUR;
  }
}

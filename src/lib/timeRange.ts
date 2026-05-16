// Time-range parsing shared between the read API and the map page.

export type Range = '24h' | '7d' | '30d' | 'all';

const MS = 1000;
const HOUR = 60 * 60 * MS;
const DAY = 24 * HOUR;

export const RANGES: Range[] = ['24h', '7d', '30d', 'all'];

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
    case '24h':
    default:    return now - 24 * HOUR;
  }
}

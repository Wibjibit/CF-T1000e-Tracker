// Time-range parsing shared between the read API and the map page.

export type Range = '1h' | '6h' | '24h' | '7d' | '30d' | 'all';

const MS = 1000;
const HOUR = 60 * 60 * MS;
const DAY = 24 * HOUR;

// Ordered short-to-long for menu rendering.
export const RANGES: Range[] = ['1h', '6h', '24h', '7d', '30d', 'all'];

export const RANGE_LABELS: Record<Range, string> = {
  '1h':  'Last hour',
  '6h':  'Last 6 hours',
  '24h': 'Last 24 hours',
  '7d':  'Last 7 days',
  '30d': 'Last 30 days',
  'all': 'All time',
};

export const DEFAULT_RANGE: Range = '24h';

export function isRange(v: unknown): v is Range {
  return typeof v === 'string' && (RANGES as string[]).includes(v);
}

/**
 * Resolve a range query into a unix-ms "since" bound. `all` returns 0.
 * Falls back to DEFAULT_RANGE for unknown values.
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

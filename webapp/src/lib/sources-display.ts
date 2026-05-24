// Source-type presentation — the single source of truth for the colour + label
// of each tracking mechanism, shared by the map (client bundle), the /sources
// management page (SSR), and anywhere else a source needs a consistent look.
//
// Deliberately free of any server/D1 import so it is safe to bundle into a
// client <script> (map.astro) as well as import server-side. lib/sources.ts
// (the D1 CRUD helpers) re-exports SOURCE_TYPES/isSourceType from here so there
// is exactly one list of valid source types in the codebase.

export const SOURCE_TYPES = ['lora', 'findhub', 'findmy', 'google_maps_sharing'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export function isSourceType(value: string): value is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(value);
}

/** Pin / track / badge colour per source (docs/architecture.md "UI"). */
export const SOURCE_COLORS: Record<SourceType, string> = {
  lora: '#3aaa3a', // green
  findhub: '#1d68d0', // blue
  findmy: '#e8730c', // orange
  google_maps_sharing: '#8a44d3', // purple
};

/** Human-readable label per source. */
export const SOURCE_LABELS: Record<SourceType, string> = {
  lora: 'LoRaWAN',
  findhub: 'Find Hub',
  findmy: 'Apple Find My',
  google_maps_sharing: 'Maps sharing',
};

/** Colour for any source string, falling back to grey for the unknown. */
export function colorFor(source: string): string {
  return (SOURCE_COLORS as Record<string, string>)[source] ?? '#888888';
}

/** Label for any source string, falling back to the raw value. */
export function labelFor(source: string): string {
  return (SOURCE_LABELS as Record<string, string>)[source] ?? source;
}

// ── Map appearance (user-customisable colours, stored in D1 settings) ───────
//
// The /settings "Map appearance" card writes a JSON blob; this resolver merges
// it over the built-in defaults and drops anything that isn't a #hex colour.
// Pure + D1-free so the bundled map script resolves it the same way the SSR
// pages do. settings.ts owns the D1 read/write; this owns the shape + defaults.

/** Every customisable colour on the map. Source colours drive pins, popups,
 *  panel dots, accuracy circles, and the position marker; track is the route
 *  line + its contrast casing; cluster is the aggregation bubble. */
export interface Appearance {
  sources: Record<SourceType, string>;
  /** Track route line colour. */
  track: string;
  /** Track casing (the wide halo under the line) colour. */
  trackCasing: string;
  /** Cluster bubble colour. */
  cluster: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  sources: { ...SOURCE_COLORS },
  track: '#1f3a8a', // matches the hardcoded track introduced for visibility
  trackCasing: '#ffffff',
  cluster: '#5aaf3c', // ~ the default markercluster green
};

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** True if `v` is a `#rgb` or `#rrggbb` colour string (the only values we store
 *  — keeps an injected value safe to drop straight into a style attribute). */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR.test(v);
}

/**
 * Resolve the stored appearance JSON (or null) into a complete `Appearance`,
 * falling back to {@link DEFAULT_APPEARANCE} for anything missing or invalid.
 * Per-key validation: one bad colour never discards the rest. Always returns a
 * fresh object (callers may mutate it).
 */
export function resolveAppearance(raw: string | null | undefined): Appearance {
  const out: Appearance = {
    sources: { ...DEFAULT_APPEARANCE.sources },
    track: DEFAULT_APPEARANCE.track,
    trackCasing: DEFAULT_APPEARANCE.trackCasing,
    cluster: DEFAULT_APPEARANCE.cluster,
  };
  if (!raw) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const o = parsed as Record<string, unknown>;

  const srcs = o.sources;
  if (srcs && typeof srcs === 'object') {
    for (const t of SOURCE_TYPES) {
      const v = (srcs as Record<string, unknown>)[t];
      if (isHexColor(v)) out.sources[t] = v;
    }
  }
  if (isHexColor(o.track)) out.track = o.track;
  if (isHexColor(o.trackCasing)) out.trackCasing = o.trackCasing;
  if (isHexColor(o.cluster)) out.cluster = o.cluster;

  return out;
}

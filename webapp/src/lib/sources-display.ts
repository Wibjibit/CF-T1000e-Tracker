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

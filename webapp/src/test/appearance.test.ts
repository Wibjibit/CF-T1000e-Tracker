// Map appearance resolver — parse/validate the user's colour overrides (stored
// as JSON in D1 settings) against the built-in defaults. Pure + client-safe, so
// both the SSR pages and the bundled map script can resolve the same way.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APPEARANCE,
  resolveAppearance,
  SOURCE_COLORS,
} from '../lib/sources-display';

describe('resolveAppearance', () => {
  it('null/empty → the built-in defaults', () => {
    expect(resolveAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(resolveAppearance('')).toEqual(DEFAULT_APPEARANCE);
    expect(resolveAppearance('{}')).toEqual(DEFAULT_APPEARANCE);
  });

  it('defaults mirror SOURCE_COLORS for the source palette', () => {
    expect(DEFAULT_APPEARANCE.sources).toEqual(SOURCE_COLORS);
  });

  it('applies a full valid override', () => {
    const raw = JSON.stringify({
      sources: { lora: '#111111', findhub: '#222222', findmy: '#333333', google_maps_sharing: '#444444' },
      track: '#555555',
      trackCasing: '#000000',
      cluster: '#abcdef',
    });
    const a = resolveAppearance(raw);
    expect(a.sources.lora).toBe('#111111');
    expect(a.sources.google_maps_sharing).toBe('#444444');
    expect(a.track).toBe('#555555');
    expect(a.trackCasing).toBe('#000000');
    expect(a.cluster).toBe('#abcdef');
  });

  it('merges a partial override with defaults', () => {
    const a = resolveAppearance(JSON.stringify({ sources: { findhub: '#ff0000' }, track: '#00ff00' }));
    expect(a.sources.findhub).toBe('#ff0000');
    expect(a.sources.lora).toBe(DEFAULT_APPEARANCE.sources.lora); // untouched
    expect(a.track).toBe('#00ff00');
    expect(a.trackCasing).toBe(DEFAULT_APPEARANCE.trackCasing); // untouched
  });

  it('rejects non-hex values per-key, keeping the default for just that key', () => {
    const a = resolveAppearance(
      JSON.stringify({ sources: { lora: 'red', findhub: '#0a0' }, track: 'javascript:evil', cluster: '#GGGGGG' }),
    );
    expect(a.sources.lora).toBe(DEFAULT_APPEARANCE.sources.lora); // 'red' rejected
    expect(a.sources.findhub).toBe('#0a0'); // 3-digit hex accepted
    expect(a.track).toBe(DEFAULT_APPEARANCE.track); // non-hex rejected
    expect(a.cluster).toBe(DEFAULT_APPEARANCE.cluster); // bad hex rejected
  });

  it('ignores unknown source keys + malformed JSON', () => {
    const a = resolveAppearance(JSON.stringify({ sources: { bogus: '#fff' } }));
    expect(a.sources).toEqual(DEFAULT_APPEARANCE.sources);
    expect(resolveAppearance('{not json')).toEqual(DEFAULT_APPEARANCE);
  });

  it('returns a fresh object (no shared default references to mutate)', () => {
    const a = resolveAppearance(null);
    a.sources.lora = '#000000';
    expect(DEFAULT_APPEARANCE.sources.lora).not.toBe('#000000');
  });
});

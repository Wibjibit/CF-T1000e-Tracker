// /api/points SQL builder — the filter logic the timeline table + map share.
// Pure (string + binds), so the time-window / device / source-type / fix
// filters are unit-tested without a live D1.

import { describe, it, expect } from 'vitest';
import { buildPointsQuery, resolveEffectivePosition } from '../lib/points-query';

describe('buildPointsQuery', () => {
  it('the base case filters by lower bound + orders newest-last with the limit', () => {
    const { sql, binds } = buildPointsQuery({ sinceMs: 1000, limit: 5000 });
    expect(sql).toContain('received_at >= ?');
    expect(sql).toContain('ORDER BY r.received_at DESC');
    expect(sql).toContain('raw_payload'); // table view needs it
    expect(binds).toEqual([1000, 5000]); // since, then the LIMIT
  });

  it('adds an upper bound when untilMs is set', () => {
    const { sql, binds } = buildPointsQuery({ sinceMs: 1000, untilMs: 9000, limit: 100 });
    expect(sql).toContain('received_at <= ?');
    expect(binds).toEqual([1000, 9000, 100]);
  });

  it('adds a device filter', () => {
    const { sql, binds } = buildPointsQuery({ sinceMs: 0, deviceId: 't1000e-abc', limit: 10 });
    expect(sql).toContain('device_id = ?');
    expect(binds).toEqual([0, 't1000e-abc', 10]);
  });

  it('adds a source_type IN (...) for valid source types, dropping unknowns', () => {
    const { sql, binds } = buildPointsQuery({
      sinceMs: 0,
      sourceTypes: ['lora', 'findhub', 'bogus'],
      limit: 10,
    });
    expect(sql).toContain('source_type IN (?, ?)');
    expect(binds).toEqual([0, 'lora', 'findhub', 10]);
  });

  it('omits the source_type clause when all requested types are invalid/empty', () => {
    expect(buildPointsQuery({ sinceMs: 0, sourceTypes: ['nope'], limit: 10 }).sql)
      .not.toContain('source_type IN');
    expect(buildPointsQuery({ sinceMs: 0, sourceTypes: [], limit: 10 }).sql)
      .not.toContain('source_type IN');
  });

  it('adds the with-fix clause', () => {
    expect(buildPointsQuery({ sinceMs: 0, onlyWithFix: true, limit: 10 }).sql)
      .toContain('latitude IS NOT NULL');
  });

  it('orders the binds: since, [until], [device], [sources...], limit', () => {
    const { binds } = buildPointsQuery({
      sinceMs: 1,
      untilMs: 2,
      deviceId: 'd',
      sourceTypes: ['lora'],
      onlyWithFix: true,
      limit: 50,
    });
    expect(binds).toEqual([1, 2, 'd', 'lora', 50]);
  });

  it('joins device_sources (for pin_no_fix) and selects the pinned columns', () => {
    const { sql } = buildPointsQuery({ sinceMs: 0, limit: 10 });
    expect(sql).toContain('device_sources');
    expect(sql).toContain('pin_no_fix');
    expect(sql).toContain('pinned_latitude');
    expect(sql).toContain('report_id');
  });
});

describe('resolveEffectivePosition (Home-pinning)', () => {
  const HOME = { lat: 52.5, lon: -2.0 };
  const base = { lat: null, lon: null, pinned_lat: null, pinned_lon: null, source_type: 'findhub', pin_no_fix: 1 };

  it('a real fix is used verbatim (never pinned, never stamped)', () => {
    const r = resolveEffectivePosition({ ...base, lat: 51.1, lon: -1.1, pinned_lat: 99, pinned_lon: 99 }, HOME);
    expect(r).toEqual({ lat: 51.1, lon: -1.1, pinned: false, needsStamp: false });
  });

  it('an already-pinned row reuses its snapshot (no re-stamp, immune to Home moving)', () => {
    const r = resolveEffectivePosition({ ...base, pinned_lat: 50.0, pinned_lon: -3.0 }, { lat: 1, lon: 1 });
    expect(r).toEqual({ lat: 50.0, lon: -3.0, pinned: true, needsStamp: false });
  });

  it('an eligible no-fix row (findhub + pin_no_fix + Home set) applies Home and flags a stamp', () => {
    const r = resolveEffectivePosition(base, HOME);
    expect(r).toEqual({ lat: 52.5, lon: -2.0, pinned: true, needsStamp: true });
  });

  it('does not pin when Home is unset', () => {
    expect(resolveEffectivePosition(base, { lat: null, lon: null })).toEqual({ lat: null, lon: null, pinned: false, needsStamp: false });
  });

  it('does not pin a source that has not opted in', () => {
    expect(resolveEffectivePosition({ ...base, pin_no_fix: 0 }, HOME).lat).toBeNull();
  });

  it('does not pin a non-findhub no-fix row', () => {
    expect(resolveEffectivePosition({ ...base, source_type: 'lora' }, HOME).lat).toBeNull();
  });
});

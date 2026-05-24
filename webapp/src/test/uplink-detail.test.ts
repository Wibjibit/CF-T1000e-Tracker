// Per-gateway radio detail — parse a stored TTN ApplicationUp's rx_metadata[]
// (the report row only keeps the best gateway; the full fan-out lives in
// uplinks.raw_json). Pure, so it's tested without D1.

import { describe, it, expect } from 'vitest';
import { parseRxMetadata } from '../lib/uplink-detail';

const SAMPLE = JSON.stringify({
  uplink_message: {
    f_cnt: 42,
    rx_metadata: [
      {
        gateway_ids: { gateway_id: 'gw-alpha', eui: 'AA' },
        rssi: -71,
        channel_rssi: -71,
        snr: 9.2,
        location: { latitude: 52.7, longitude: -2.7 },
        time: '2026-05-24T10:00:00Z',
      },
      {
        gateway_ids: { gateway_id: 'gw-beta' },
        rssi: -104,
        snr: -3.5,
      },
    ],
  },
});

describe('parseRxMetadata', () => {
  it('maps each rx_metadata entry to a flat gateway record', () => {
    const gws = parseRxMetadata(SAMPLE);
    expect(gws).toHaveLength(2);
    expect(gws[0]).toMatchObject({ gateway_id: 'gw-alpha', rssi: -71, snr: 9.2, channel_rssi: -71 });
    expect(gws[0].location).toMatchObject({ latitude: 52.7, longitude: -2.7 });
    expect(gws[1]).toMatchObject({ gateway_id: 'gw-beta', rssi: -104, snr: -3.5 });
  });

  it('sorts strongest-RSSI first', () => {
    const gws = parseRxMetadata(SAMPLE);
    expect(gws.map((g) => g.gateway_id)).toEqual(['gw-alpha', 'gw-beta']);
  });

  it('returns [] on malformed / empty / missing rx_metadata', () => {
    expect(parseRxMetadata('{not json')).toEqual([]);
    expect(parseRxMetadata('{}')).toEqual([]);
    expect(parseRxMetadata(JSON.stringify({ uplink_message: {} }))).toEqual([]);
    expect(parseRxMetadata(null)).toEqual([]);
  });

  it('tolerates entries missing a gateway_id (labels them unknown)', () => {
    const gws = parseRxMetadata(JSON.stringify({ uplink_message: { rx_metadata: [{ rssi: -80 }] } }));
    expect(gws).toHaveLength(1);
    expect(gws[0].gateway_id).toBe('(unknown)');
    expect(gws[0].rssi).toBe(-80);
  });
});

// gpsoauth sub-token minting. Both mints hit the same endpoint and parse the
// `Auth=` line; they differ only in the `app` + `service` they request. The
// Spot mint (Phase 4) feeds the off-Workers `spot-pa` refresh; the ADM mint
// (Phase 3) feeds the Nova read path. We mock `fetch` to pin the request shape
// (the params Google keys on) without a network/account.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mintAdmToken, mintSpotToken } from '../lib/google/auth';

function mockFetch(body: string, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  });
  return calls;
}

function paramsOf(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

afterEach(() => vi.unstubAllGlobals());

describe('mintSpotToken', () => {
  it('requests the spot scope under the GMS app and returns the Auth token', async () => {
    const calls = mockFetch('Auth=ya29.spot-token-value\nExpiry=123\n');
    const res = await mintSpotToken('user@gmail.com', 'master-tok', '987654321');

    expect(res.ok).toBe(true);
    expect(res.token).toBe('ya29.spot-token-value');

    expect(calls).toHaveLength(1);
    const p = paramsOf(calls[0].init);
    expect(p.get('app')).toBe('com.google.android.gms');
    expect(p.get('service')).toBe('oauth2:https://www.googleapis.com/auth/spot');
    expect(p.get('Email')).toBe('user@gmail.com');
    expect(p.get('EncryptedPasswd')).toBe('master-tok');
    expect(p.get('androidId')).toBe('987654321');
  });

  it('reports failure (no Auth line) without throwing', async () => {
    mockFetch('Error=BadAuthentication\n', 403);
    const res = await mintSpotToken('user@gmail.com', 'bad', '1');
    expect(res.ok).toBe(false);
    expect(res.token).toBeUndefined();
    expect(res.bodyHead).toContain('BadAuthentication');
  });
});

describe('mintAdmToken (regression — unchanged by the Spot addition)', () => {
  it('still requests the android_device_manager scope under the ADM app', async () => {
    const calls = mockFetch('Auth=ya29.adm-token\n');
    const res = await mintAdmToken('user@gmail.com', 'master-tok', '987654321');

    expect(res.ok).toBe(true);
    expect(res.token).toBe('ya29.adm-token');
    const p = paramsOf(calls[0].init);
    expect(p.get('app')).toBe('com.google.android.apps.adm');
    expect(p.get('service')).toBe('oauth2:https://www.googleapis.com/auth/android_device_manager');
  });
});

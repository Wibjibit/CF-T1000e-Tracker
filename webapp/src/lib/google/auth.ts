// Google gpsoauth token minting — plain HTTPS, no gRPC.
//
// Mints a scoped sub-token from the stored Master Token via the gpsoauth
// "second leg". The Phase 3.0 spike PROVED this works from Workers `fetch()`
// (HTTP 200) despite gpsoauth's TLS/ALPN cipher tweaks — so neither the read
// path nor the Phase 4 refresh needs an off-edge auth step (only the `spot-pa`
// gRPC call itself does — master-plan §1.5). Ported from GoogleFindMyTools
// Auth/token_retrieval.py + the desktop-app auth path; lifted from
// `spike/findhub-mcs/src/nova.ts`.
//
// Two mints share this leg, differing only in `app` + `service`:
//   - ADM  (Phase 3 read):    app com.google.android.apps.adm, scope android_device_manager.
//   - Spot (Phase 4 refresh): app com.google.android.gms,       scope spot.
// `com.google.android.gms` is gpsoauth's `play_services=True` app id.

const AUTH_URL = 'https://android.clients.google.com/auth';
const ADM_APP = 'com.google.android.apps.adm';
const ADM_SERVICE = 'oauth2:https://www.googleapis.com/auth/android_device_manager';
const GMS_APP = 'com.google.android.gms';
const SPOT_SERVICE = 'oauth2:https://www.googleapis.com/auth/spot';
const CLIENT_SIG = '38918a453d07199354f8b19af05ec6562ced5788';

export interface AdmResult {
  ok: boolean;
  status: number;
  token?: string;
  /** First 160 chars of the body, populated only when no token was returned. */
  bodyHead?: string;
  error?: string;
}

/** Shared gpsoauth second-leg POST. The response body is `Key=Value` lines; the
 * bearer token is the `Auth` value. Differs per call only by `app`/`service`. */
async function mintToken(
  username: string,
  masterToken: string,
  androidId: string,
  app: string,
  service: string,
): Promise<AdmResult> {
  const body = new URLSearchParams({
    accountType: 'HOSTED_OR_GOOGLE',
    Email: username,
    has_permission: '1',
    EncryptedPasswd: masterToken,
    service,
    source: 'android',
    androidId,
    app,
    client_sig: CLIENT_SIG,
    device_country: 'us',
    operatorCountry: 'us',
    lang: 'en',
    sdk_version: '17',
    google_play_services_version: '240913000',
  });

  let res: Response;
  try {
    res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'GoogleAuth/1.4',
        'Accept-Encoding': 'identity',
      },
      body: body.toString(),
    });
  } catch (e) {
    return { ok: false, status: 0, error: `fetch threw: ${String(e)}` };
  }

  const text = await res.text();
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const token = map.get('Auth');
  return {
    ok: res.status === 200 && Boolean(token),
    status: res.status,
    token,
    bodyHead: token ? undefined : text.slice(0, 160),
  };
}

/**
 * Mint the ADM (android_device_manager) sub-token from the Master Token. Feeds
 * the Nova read path (ListDevices / LocateTracker).
 */
export function mintAdmToken(
  username: string,
  masterToken: string,
  androidId: string,
): Promise<AdmResult> {
  return mintToken(username, masterToken, androidId, ADM_APP, ADM_SERVICE);
}

/**
 * Mint the Spot sub-token from the Master Token. Feeds the off-Workers
 * `spot-pa` gRPC refresh (UploadPrecomputedPublicKeyIds) that keeps the
 * static-EID window topped up (master-plan §1.3, Phase 4).
 */
export function mintSpotToken(
  username: string,
  masterToken: string,
  androidId: string,
): Promise<AdmResult> {
  return mintToken(username, masterToken, androidId, GMS_APP, SPOT_SERVICE);
}

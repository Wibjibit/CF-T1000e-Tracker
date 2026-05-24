// Google gpsoauth token minting (read path) — plain HTTPS, no gRPC.
//
// Mints the ADM (`android_device_manager`) sub-token from the stored Master
// Token via the gpsoauth "second leg". The Phase 3.0 spike PROVED this works
// from Workers `fetch()` (HTTP 200) despite gpsoauth's TLS/ALPN cipher tweaks —
// so the read path needs no off-edge auth step. Ported from
// GoogleFindMyTools NovaApi/* + the desktop-app auth path; lifted from
// `spike/findhub-mcs/src/nova.ts`.

const AUTH_URL = 'https://android.clients.google.com/auth';
const ADM_APP = 'com.google.android.apps.adm';
const ADM_SERVICE = 'oauth2:https://www.googleapis.com/auth/android_device_manager';
const CLIENT_SIG = '38918a453d07199354f8b19af05ec6562ced5788';

export interface AdmResult {
  ok: boolean;
  status: number;
  token?: string;
  /** First 160 chars of the body, populated only when no token was returned. */
  bodyHead?: string;
  error?: string;
}

/**
 * Mint the ADM (android_device_manager) sub-token from the Master Token via the
 * gpsoauth second leg. The response body is `Key=Value` lines; the bearer token
 * is the `Auth` value.
 */
export async function mintAdmToken(
  username: string,
  masterToken: string,
  androidId: string,
): Promise<AdmResult> {
  const body = new URLSearchParams({
    accountType: 'HOSTED_OR_GOOGLE',
    Email: username,
    has_permission: '1',
    EncryptedPasswd: masterToken,
    service: ADM_SERVICE,
    source: 'android',
    androidId,
    app: ADM_APP,
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

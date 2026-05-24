// Shared client-side wiring for the dashboard pages (/map, /timeline):
// the time-range dropdown, the optional device selector, and the auto-refresh
// checkbox. Both pages call `wireDashboard({ selectId, checkboxId, load, ... })`
// with their own `load` function — keeps the widget behaviour identical without
// duplicating the state machine.

export const VALID_RANGES = ['1h', '6h', '24h', '7d', '30d', 'all'] as const;
export type Range = (typeof VALID_RANGES)[number];

const STORAGE_KEY = 'tracker.autoRefresh';
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export function isValidRange(v: string): v is Range {
  return (VALID_RANGES as readonly string[]).includes(v);
}

function rangeFromHash(): Range {
  const v = (location.hash || '').replace(/^#/, '');
  return isValidRange(v) ? v : '24h';
}

// The selected device persists in the `?device=` query param (the range lives
// in the hash). Empty string = "all devices".
function deviceFromQuery(): string {
  return new URLSearchParams(location.search).get('device') || '';
}

function setDeviceQuery(device: string): void {
  const url = new URL(location.href);
  if (device) url.searchParams.set('device', device);
  else url.searchParams.delete('device');
  history.replaceState(null, '', url);
}

// ── Device list (fed by /api/devices) ─────────────────────────────────────

export interface DeviceInfo {
  device_id: string;
  display_name: string;
  source_types: string[];
  report_count: number;
  last_report_at: number | null;
}

export async function fetchDevices(): Promise<DeviceInfo[]> {
  try {
    const res = await fetch('/api/devices', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const body = (await res.json()) as { devices?: DeviceInfo[] };
    return body.devices ?? [];
  } catch {
    return [];
  }
}

/**
 * Fill a <select> with an "All devices" option plus one option per device, and
 * restore `selected` (from the URL) if that device still exists. Returns the
 * value actually selected so the caller's first load uses the right filter.
 */
export function populateDeviceSelect(
  select: HTMLSelectElement,
  devices: DeviceInfo[],
  selected: string,
): string {
  select.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = devices.length > 1 ? `All devices (${devices.length})` : 'All devices';
  select.appendChild(all);

  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.device_id;
    opt.textContent = d.display_name;
    select.appendChild(opt);
  }

  const exists = selected && devices.some((d) => d.device_id === selected);
  select.value = exists ? selected : '';
  return select.value;
}

// ── Wiring ─────────────────────────────────────────────────────────────────

export interface WireDashboardOpts {
  /** id of the <select> element with the range options */
  selectId: string;
  /** id of the auto-refresh <input type="checkbox"> */
  checkboxId: string;
  /** id of the device <select>, if the page has one */
  deviceSelectId?: string;
  /** called on initial render, manual range/device change, auto-refresh tick, and resize */
  load: (range: Range, deviceId: string) => void;
  /** rebuild on window resize? (uPlot needs this; Leaflet does not) */
  resize?: boolean;
}

export interface DashboardController {
  currentRange(): Range;
  currentDevice(): string;
  /** Force a `load(currentRange(), currentDevice())` and re-arm the timer if auto-refresh is on. */
  refresh(): void;
}

export function wireDashboard(opts: WireDashboardOpts): DashboardController {
  const select = document.getElementById(opts.selectId) as HTMLSelectElement | null;
  const checkbox = document.getElementById(opts.checkboxId) as HTMLInputElement | null;
  const deviceSelect = opts.deviceSelectId
    ? (document.getElementById(opts.deviceSelectId) as HTMLSelectElement | null)
    : null;

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const currentRange = (): Range =>
    select && isValidRange(select.value) ? select.value : '24h';
  const currentDevice = (): string => (deviceSelect ? deviceSelect.value : '');
  const fire = () => opts.load(currentRange(), currentDevice());
  const start = () => {
    stop();
    timer = setInterval(fire, AUTO_REFRESH_MS);
  };

  // Initial render.
  const initial = rangeFromHash();
  if (select) select.value = initial;
  fire();

  if (select) {
    select.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (!isValidRange(v)) return;
      location.hash = v;
      fire();
      if (checkbox?.checked) start(); // re-arm so next auto-tick is a full interval from now
    });
  }

  if (deviceSelect) {
    deviceSelect.addEventListener('change', () => {
      setDeviceQuery(currentDevice());
      fire();
      if (checkbox?.checked) start();
    });
  }

  if (checkbox) {
    checkbox.checked = localStorage.getItem(STORAGE_KEY) === '1';
    if (checkbox.checked) start();
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        localStorage.setItem(STORAGE_KEY, '1');
        start();
      } else {
        localStorage.removeItem(STORAGE_KEY);
        stop();
      }
    });
    // Don't burn requests on a backgrounded tab. Resume + fresh fetch on focus.
    document.addEventListener('visibilitychange', () => {
      if (!checkbox.checked) return;
      if (document.hidden) {
        stop();
      } else {
        fire();
        start();
      }
    });
  }

  if (opts.resize) {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
      if (resizeTimer != null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fire, 200);
    });
  }

  return {
    currentRange,
    currentDevice,
    refresh: () => {
      fire();
      if (checkbox?.checked) start();
    },
  };
}

// Re-export so pages can read the initial device from the URL before wiring.
export { deviceFromQuery };

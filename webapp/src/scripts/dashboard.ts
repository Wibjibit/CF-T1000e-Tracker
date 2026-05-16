// Shared client-side wiring for the dashboard pages (/map, /timeline):
// the time-range dropdown and the auto-refresh checkbox. Both pages call
// `wireDashboard({ selectId, checkboxId, load })` with their own `load`
// function — keeps the widget behaviour identical without duplicating the
// state machine.

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

export interface WireDashboardOpts {
  /** id of the <select> element with the range options */
  selectId: string;
  /** id of the auto-refresh <input type="checkbox"> */
  checkboxId: string;
  /** called on initial render, manual range change, auto-refresh tick, and resize */
  load: (range: Range) => void;
  /** rebuild on window resize? (uPlot needs this; Leaflet does not) */
  resize?: boolean;
}

export interface DashboardController {
  currentRange(): Range;
  /** Force a `load(currentRange())` and re-arm the timer if auto-refresh is on. */
  refresh(): void;
}

export function wireDashboard(opts: WireDashboardOpts): DashboardController {
  const select = document.getElementById(opts.selectId) as HTMLSelectElement | null;
  const checkbox = document.getElementById(opts.checkboxId) as HTMLInputElement | null;

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const start = () => {
    stop();
    timer = setInterval(() => opts.load(currentRange()), AUTO_REFRESH_MS);
  };
  const currentRange = (): Range =>
    select && isValidRange(select.value) ? select.value : '24h';

  // Initial render.
  const initial = rangeFromHash();
  if (select) select.value = initial;
  opts.load(initial);

  if (select) {
    select.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (!isValidRange(v)) return;
      location.hash = v;
      opts.load(v);
      if (checkbox?.checked) start(); // re-arm so next auto-tick is a full interval from now
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
        opts.load(currentRange());
        start();
      }
    });
  }

  if (opts.resize) {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
      if (resizeTimer != null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => opts.load(currentRange()), 200);
    });
  }

  return {
    currentRange,
    refresh: () => {
      opts.load(currentRange());
      if (checkbox?.checked) start();
    },
  };
}

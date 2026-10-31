/**
 * HALOFLUX for DSH — shared parameter store.
 *
 * Two slots render from this one module-scope store: the frame overlay
 * (`shell.overlay`) and the settings page (`settings.section`). They are
 * different React trees, so neither can own the state: moving a slider in
 * Settings must reach the live canvas at once, and the in-page console (C)
 * must agree with both.
 *
 * Persistence keeps the two keys the earlier build already used, so existing
 * saved parameters survive the upgrade:
 *   dsh-haloflux:params:v2          live, every change
 *   dsh-haloflux:params:default:v2  explicit "save as default"
 */
const HalofluxState = (() => {
  const STORAGE_KEY = 'dsh-haloflux:params:v2';
  const PARAMS_KEY = 'dsh-haloflux:params:default:v2';

  function readJson(key) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return undefined;
      const value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function writeJson(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }

  /** shipped defaults: the author's MINE look + this port's UI composition */
  function baseParams() {
    const P = HalofluxEngine;
    const start = { ...P.BASE, ...(P.PRESETS.MINE || {}) };
    const plugin = {
      // UI-background composition: the author's MINE look, scaled and shifted so the
      // halo sits over the left column and its beams sweep across the transcript.
      opacity: 0.45, blend: 0, activityGain: 1,
      centerX: -0.15, centerY: 0, scale: 0.6, hudOn: 0, feedOn: 1, dataMode: 1,
      // the author's auto camera (occasional push-in on a detail) is off by default;
      // the Stats bar button and the `camera` slider both switch it back on.
      camera: 0,
      // three-state envelope: running / silent-session / no-session, with independent
      // attack and release so starting and stopping a call never snaps.
      // idle 0.18 = a faint halo that still breathes; void 0 = gone on the hero page.
      idleMotion: 0.18, runLevel: 1, voidLevel: 0,
      attackMs: 800, releaseMs: 2600, easeCurve: 1,
      revolveOnSwitch: 1, revolveMs: 1500,
    };
    return { ...start, ...plugin };
  }

  function initialParams() {
    const defaults = readJson(PARAMS_KEY);
    const saved = readJson(STORAGE_KEY);
    return { ...baseParams(), ...(defaults || {}), ...(saved || {}) };
  }

  let current = initialParams();
  const listeners = new Set();

  function get() { return current; }

  function notify() {
    for (const fn of Array.from(listeners)) {
      try { fn(); } catch { /* one bad subscriber must not stop the others */ }
    }
  }

  /** merge a partial patch; every subscriber (canvas, console, settings) re-renders */
  function set(partial) {
    if (!partial || typeof partial !== 'object') return;
    current = { ...current, ...partial };
    writeJson(STORAGE_KEY, current);
    notify();
  }

  /** replace everything, keeping base defaults for keys the patch omits */
  function setAll(next) {
    current = { ...baseParams(), ...(next && typeof next === 'object' ? next : {}) };
    writeJson(STORAGE_KEY, current);
    notify();
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  function saveDefault() { writeJson(PARAMS_KEY, current); }

  function resetDefault() {
    try { window.localStorage.removeItem(PARAMS_KEY); } catch { /* ignore */ }
    current = baseParams();
    writeJson(STORAGE_KEY, current);
    notify();
  }

  function exportJson() { return JSON.stringify(current, null, 2); }

  function importJson(text) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return false;
      setAll(parsed);
      return true;
    } catch {
      return false;
    }
  }

  /** React binding: `useSyncExternalStore` needs a stable snapshot object */
  function useParams() {
    const useSyncExternalStore = React && React.useSyncExternalStore;
    if (typeof useSyncExternalStore === 'function') {
      return useSyncExternalStore(subscribe, get, get);
    }
    // very old React: fall back to state + effect
    const [value, setValue] = React.useState(get);
    React.useEffect(() => subscribe(() => setValue(get())), []);
    return value;
  }

  return {
    STORAGE_KEY, PARAMS_KEY,
    readJson, writeJson,
    baseParams, initialParams,
    get, set, setAll, subscribe,
    saveDefault, resetDefault, exportJson, importJson,
    useParams,
  };
})();

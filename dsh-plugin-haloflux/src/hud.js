/**
 * HALOFLUX for DSH — HUD overlay (React, no JSX, no imports).
 *
 * Declares exactly one global: `HalofluxHud = { Stats, Feed, Tools, Console }`.
 * `React` is injected as a shared const by build.mjs; every element is built
 * with `h(...)`, never JSX.
 *
 * Layout contract: the four pieces live inside `shell.overlay`'s transparent
 * full-frame layer (`.hfx-root`, pointer-events:none). Stats/Feed/Tools stay
 * pointer-events:none so they never steal a click from the chat; only Console
 * is interactive. Live data is read straight off the mutable `props.live`
 * singleton and re-rendered when mount bumps `props.liveTick` — nothing here
 * polls, schedules frames, or writes to `document`.
 */
const HalofluxHud = (() => {
  const h = React.createElement;
  const memo = typeof React.memo === 'function' ? React.memo : (component) => component;

  /* ------------------------------------------------------------------ *
   * tuning
   * ------------------------------------------------------------------ */

  const MAX_ROWS = 8;          // feed lines / tool rows kept in the DOM
  const COMMIT_MS = 120;       // slider idle delay before we push to params
  const FLASH_MS = 2000;       // "copied" note lifetime
  const TOKEN_TAIL = 140;      // chars of token stream shown
  const PRESET_ORDER = ['A', 'B', 'MINE'];
  const FONT_STACK = '"JetBrains Mono",Consolas,ui-monospace,monospace';

  /** Plugin-owned defaults, mirroring mount.js `baseParams()`. */
  const PLUGIN_DEFAULTS = {
    opacity: 0.55, blend: 0, idleMotion: 0.15, activityGain: 1,
    centerX: 0, centerY: 0, scale: 1, hudOn: 1, feedOn: 1,
  };

  /* ------------------------------------------------------------------ *
   * value helpers
   * ------------------------------------------------------------------ */

  const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const asList = (v) => (Array.isArray(v) ? v : []);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const trimZero = (s) => s.replace(/\.0$/, '');

  /** 12432 -> "12.4k" (thousands only, as the HUD contract asks). */
  function fmtCount(n) {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '0';
    if (v >= 1e6) return trimZero((v / 1e6).toFixed(1)) + 'M';
    if (v >= 1e3) return trimZero((v / 1e3).toFixed(1)) + 'k';
    return String(Math.round(v));
  }

  /** 0..1 decimal below 10, integers above. */
  function fmtRate(n) {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '0';
    return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
  }

  /** integer percent, "--" while the context limit is unknown. */
  function fmtPct(part, whole) {
    const p = Number(part) || 0;
    const w = Number(whole) || 0;
    if (!(w > 0)) return '--';
    return Math.round(clamp(p / w, 0, 1) * 100) + '%';
  }

  function fmtClock(t) {
    const ms = Number(t);
    const d = new Date(isFinite(ms) && ms > 0 ? ms : Date.now());
    if (isNaN(d.getTime())) return '';
    const p = (x) => (x < 10 ? '0' : '') + x;
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** Slider readout: decimal places follow the step, so 0.01 shows 0.55. */
  function fmtValue(v, step) {
    const n = Number(v);
    if (!isFinite(n)) return '--';
    const s = Number(step);
    let digits = 0;
    if (isFinite(s) && s > 0 && s < 1) digits = Math.min(3, (String(s).split('.')[1] || '').length);
    return n.toFixed(digits);
  }

  function clip(s, max) {
    const v = asText(s).replace(/\s+/g, ' ').trim();
    return v.length > max ? v.slice(0, max - 1) + '\u2026' : v;
  }

  function safeT(props) {
    return typeof props.t === 'function' ? props.t : (key) => key;
  }

  /* ------------------------------------------------------------------ *
   * engine introspection (PARAMS / BASE / PRESETS)
   * ------------------------------------------------------------------ */

  /** Normalises `HalofluxEngine.PARAMS` — accepts object rows or lab.html's tuples. */
  function readParamEntries() {
    const out = [];
    const src = (() => {
      try { return HalofluxEngine && HalofluxEngine.PARAMS; } catch { return undefined; }
    })();
    for (const raw of asList(src)) {
      let row = null;
      if (Array.isArray(raw)) {
        row = { key: raw[0], label: raw[1], min: raw[2], max: raw[3], step: raw[4], group: raw[5] };
      } else if (raw && typeof raw === 'object' && typeof raw.key === 'string') {
        row = raw;
      }
      if (!row || typeof row.key !== 'string') continue;
      const min = Number(row.min);
      const max = Number(row.max);
      const step = Number(row.step);
      out.push({
        key: row.key,
        label: asText(row.label) || row.key,
        min: isFinite(min) ? min : 0,
        max: isFinite(max) ? max : 1,
        step: isFinite(step) && step > 0 ? step : 0.01,
        group: asText(row.group) || '--',
      });
    }
    return out;
  }

  /** Group rows, preserving PARAMS order. */
  function groupEntries(entries) {
    const groups = [];
    const seen = Object.create(null);
    for (const entry of entries) {
      let bucket = seen[entry.group];
      if (!bucket) {
        bucket = { name: entry.group, items: [] };
        seen[entry.group] = bucket;
        groups.push(bucket);
      }
      bucket.items.push(entry);
    }
    return groups;
  }

  /** BASE + PRESETS.MINE + the plugin's own defaults: the double-click target. */
  function defaultValues() {
    let base = {};
    try { base = Object.assign({}, (HalofluxEngine && HalofluxEngine.BASE) || {}); } catch { base = {}; }
    try {
      const mine = HalofluxEngine && HalofluxEngine.PRESETS && HalofluxEngine.PRESETS.MINE;
      if (mine && typeof mine === 'object') base = Object.assign(base, mine);
    } catch { /* preset optional */ }
    return Object.assign(base, PLUGIN_DEFAULTS);
  }

  function matchesPreset(params, preset) {
    if (!preset || typeof preset !== 'object') return false;
    const keys = Object.keys(preset);
    if (!keys.length) return false;
    for (const key of keys) {
      const a = Number(params[key]);
      const b = Number(preset[key]);
      if (!isFinite(a) || !isFinite(b) || Math.abs(a - b) > 1e-9) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * theme tokens (--dsw-alias-*), fallbacks match the shipped theme pack
   * ------------------------------------------------------------------ */

  const T_LABEL_1 = 'var(--dsw-alias-label-primary,#e6ecff)';
  const T_LABEL_2 = 'var(--dsw-alias-label-secondary,#8b93a7)';
  const T_LABEL_3 = 'var(--dsw-alias-label-tertiary,#6a7285)';
  const T_CAPTION = 'var(--dsw-alias-label-caption,#5d6474)';
  const T_ACCENT = 'var(--dsw-alias-brand-primary,#6ea8ff)';
  const T_OK = 'var(--dsw-alias-state-success-primary,#49d17b)';
  const T_ERR = 'var(--dsw-alias-state-error-primary,#ff6b6b)';
  const T_WARN = 'var(--dsw-alias-state-warn-primary,#ffb648)';
  const T_BUSY = 'var(--dsw-alias-state-business-primary,#7fd8ff)';

  /* ------------------------------------------------------------------ *
   * shared bits
   * ------------------------------------------------------------------ */

  function Pane(props) {
    return h('div', { className: 'hfx-pane' + (props.extra ? ' ' + props.extra : '') },
      h('div', { className: 'hfx-hd' }, props.title),
      props.children
    );
  }

  function Kpi(props) {
    return h('div', { className: 'hfx-kpi', style: props.w ? { minWidth: props.w } : null },
      h('span', { className: 'hfx-k' }, props.label),
      h('span', { className: 'hfx-v', style: props.tone ? { color: props.tone } : null }, props.value)
    );
  }

  /* ------------------------------------------------------------------ *
   * Stats — the one always-on row
   * ------------------------------------------------------------------ */

  const CSS_STATS = `
.hfx-stats{position:absolute;top:var(--hfx-hud-top,6px);left:var(--hfx-hud-x,50%);transform:translateX(-50%);display:flex;align-items:center;gap:10px;
  max-width:calc(100vw - 320px);overflow:hidden;padding:4px 9px;border-radius:8px;box-sizing:border-box;
  pointer-events:none;contain:layout style;
  font:11px/1.3 ${FONT_STACK};letter-spacing:.06em;color:${T_LABEL_2};
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b0d10) 72%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 70%,transparent);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.hfx-stats .hfx-kpi{display:flex;align-items:baseline;gap:5px;min-width:56px;overflow:hidden}
.hfx-stats .hfx-k{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:${T_CAPTION};white-space:nowrap}
.hfx-stats .hfx-v{font-variant-numeric:tabular-nums;color:${T_LABEL_1};white-space:nowrap}
.hfx-stats .hfx-state{font-weight:700;letter-spacing:.14em;white-space:nowrap;color:${T_LABEL_3}}
.hfx-stats .hfx-state-run{color:${T_WARN}}
.hfx-stats .hfx-dot{width:6px;height:6px;border-radius:50%;flex:none;display:inline-block;background:${T_LABEL_3}}
.hfx-stats .hfx-dot-run{background:${T_WARN};animation:hfx-pulse 1.15s ease-in-out infinite}
.hfx-stats .hfx-gear{pointer-events:auto;flex:none;width:20px;height:18px;line-height:1;font:inherit;font-size:11px;
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
  color:${T_LABEL_2};background:transparent;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l3,#3a3e46) 70%,transparent);
  border-radius:5px;padding:0}
.hfx-stats .hfx-gear:hover{color:${T_LABEL_1};border-color:${T_ACCENT};background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hfx-stats .hfx-camera{pointer-events:auto;flex:none;height:18px;min-width:34px;line-height:1;font:inherit;
  font-size:9px;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0 6px;
  color:${T_LABEL_3};background:transparent;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l3,#3a3e46) 70%,transparent);
  border-radius:5px}
.hfx-stats .hfx-camera:hover{color:${T_LABEL_1};border-color:${T_ACCENT};background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hfx-stats .hfx-camera-on,.hfx-stats .hfx-camera-on:hover{color:${T_WARN};
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffb648) 62%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffb648) 15%,transparent)}
@keyframes hfx-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.7)}}
@media (prefers-reduced-motion:reduce){.hfx-stats .hfx-dot-run{animation:none}}
`;

  function Stats(props) {
    const t = safeT(props);
    const live = props.live || {};
    const cameraOn = Number((props.params || {}).camera) >= 0.5;
    const view = React.useMemo(() => ({
      running: live.running === true,
      total: fmtCount(live.totalTokens),
      rate: fmtRate(live.tps),
      ctx: fmtPct(live.contextTokens, live.contextLimit),
      step: String(Math.max(0, Number(live.step) || 0)),
      tools: String(asList(live.tools).length),
    }), [live, props.liveTick]);

    return h('div', { className: 'hfx-stats', style: { pointerEvents: 'none' } },
      h('style', null, CSS_STATS),
      h('span', { className: 'hfx-dot' + (view.running ? ' hfx-dot-run' : ''), 'aria-hidden': 'true' }),
      h('span', { className: 'hfx-state' + (view.running ? ' hfx-state-run' : '') },
        t(view.running ? 'ui.running' : 'ui.idle')),
      h(Kpi, { label: t('ui.tokens'), value: view.total, w: 56 }),
      h(Kpi, { label: t('ui.rate'), value: view.rate, w: 56 }),
      h(Kpi, { label: t('ui.context'), value: view.ctx, w: 56 }),
      h(Kpi, { label: t('ui.steps'), value: view.step, w: 40 }),
      h(Kpi, { label: t('ui.tools'), value: view.tools, w: 40 }),
      h('button', {
        type: 'button', className: 'hfx-camera' + (cameraOn ? ' hfx-camera-on' : ''),
        style: { pointerEvents: 'auto' }, 'aria-pressed': cameraOn ? 'true' : 'false',
        title: t('ui.cameraHint'), 'aria-label': t('ui.camera'),
        onClick: () => {
          if (typeof props.setParams !== 'function') return;
          props.setParams({ camera: cameraOn ? 0 : 1 });
        },
      }, t('ui.camera')),
      h('button', {
        type: 'button', className: 'hfx-gear', style: { pointerEvents: 'auto' },
        title: t('ui.console'), 'aria-label': t('ui.console'),
        onClick: () => { if (typeof props.setOpen === 'function') props.setOpen(!props.open); },
      }, '\u2699')
    );
  }

  /* ------------------------------------------------------------------ *
   * Feed — bottom-left event stream + token ticker
   * ------------------------------------------------------------------ */

  const CSS_FEED = `
.hfx-feed{position:absolute;left:var(--hfx-hud-inset,12px);bottom:var(--hfx-hud-inset,12px);width:302px;pointer-events:none;
  display:flex;flex-direction:column;gap:6px;contain:layout style;
  font:11px/1.45 ${FONT_STACK};letter-spacing:.06em;color:${T_LABEL_2}}
.hfx-pane{box-sizing:border-box;padding:5px 8px 6px;border-radius:8px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b0d10) 72%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 62%,transparent);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.hfx-pane .hfx-hd{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:${T_CAPTION};
  padding-bottom:3px;margin-bottom:3px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#22262f) 60%,transparent)}
.hfx-feed .hfx-line{display:flex;gap:6px;align-items:baseline;min-width:0;white-space:nowrap}
.hfx-feed .hfx-ts{color:${T_CAPTION};flex:none;font-variant-numeric:tabular-nums}
.hfx-feed .hfx-kind{flex:none;width:62px;font-weight:700;overflow:hidden;text-overflow:ellipsis}
.hfx-feed .hfx-msg{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;color:${T_LABEL_2}}
.hfx-feed .hfx-empty{color:${T_CAPTION}}
.hfx-kt-user{color:${T_ACCENT}}
.hfx-kt-assistant{color:${T_LABEL_1}}
.hfx-kt-tool{color:${T_BUSY}}
.hfx-kt-error{color:${T_ERR}}
.hfx-kt-turn{color:${T_WARN}}
.hfx-kt-system{color:${T_LABEL_3}}
.hfx-feed .hfx-tok{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${T_LABEL_1};
  font-variant-numeric:tabular-nums;min-height:16px}
.hfx-feed .hfx-tok-idle{color:${T_CAPTION}}
`;

  function Feed(props) {
    const t = safeT(props);
    const live = props.live || {};
    const view = React.useMemo(() => {
      const source = asList(live.feed);
      const rows = [];
      for (let i = source.length - 1; i >= 0 && rows.length < MAX_ROWS; i--) {
        const item = source[i] || {};
        const kind = asText(item.kind || 'system').toLowerCase().replace(/[^a-z]/g, '') || 'system';
        rows.push({ key: 'f' + i, clock: fmtClock(item.t), kind, text: clip(item.text, 160) });
      }
      // live.recentText is a HUD-owned ring buffer that pullTokens() never drains;
      // fall back to the queue only if a live source does not provide it.
      const tail = typeof live.recentText === 'string' && live.recentText
        ? live.recentText
        : asList(live.tokenQueue).slice(-48).map(asText).join('');
      return { rows, tail: clip(tail, TOKEN_TAIL) };
    }, [live, props.liveTick]);

    return h('div', { className: 'hfx-feed', style: { pointerEvents: 'none' } },
      h('style', null, CSS_FEED),
      h(Pane, { title: t('ui.feed') },
        view.rows.length
          ? view.rows.map((row, index) => h('div', {
            key: row.key, className: 'hfx-line', style: { opacity: Math.max(0.3, 1 - index * 0.1).toFixed(2) },
          },
          h('span', { className: 'hfx-ts' }, '[' + row.clock + ']'),
          h('span', { className: 'hfx-kind hfx-kt-' + row.kind }, row.kind.toUpperCase()),
          h('span', { className: 'hfx-msg' }, row.text)))
          : h('div', { className: 'hfx-line hfx-empty' }, t('ui.empty'))
      ),
      h(Pane, { title: t('ui.tokensFeed') },
        h('div', { className: 'hfx-tok' + (view.tail ? '' : ' hfx-tok-idle') }, view.tail || t('ui.empty'))
      )
    );
  }

  /* ------------------------------------------------------------------ *
   * Tools — bottom-right dispatch list
   * ------------------------------------------------------------------ */

  const CSS_TOOLS = `
.hfx-tools{position:absolute;right:var(--hfx-hud-inset,12px);bottom:var(--hfx-hud-inset,12px);width:252px;pointer-events:none;box-sizing:border-box;
  padding:5px 8px 6px;border-radius:8px;contain:layout style;
  font:11px/1.45 ${FONT_STACK};letter-spacing:.06em;color:${T_LABEL_2};
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b0d10) 72%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 62%,transparent);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.hfx-tools .hfx-hd{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:${T_CAPTION};
  padding-bottom:3px;margin-bottom:3px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#22262f) 60%,transparent)}
.hfx-tools .hfx-trow{display:flex;gap:6px;align-items:center;white-space:nowrap;min-width:0}
.hfx-tools .hfx-tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:${T_LABEL_2}}
.hfx-tools .hfx-tstate{flex:none;color:${T_CAPTION}}
.hfx-tools .hfx-tstate-run{color:${T_WARN}}
.hfx-tools .hfx-tstate-ok{color:${T_OK}}
.hfx-tools .hfx-tstate-error{color:${T_ERR}}
.hfx-tools .hfx-dot{width:6px;height:6px;border-radius:50%;flex:none;display:inline-block;background:${T_LABEL_3}}
.hfx-tools .hfx-dot-run{background:${T_WARN};animation:hfx-pulse 1.15s ease-in-out infinite}
.hfx-tools .hfx-dot-ok{background:${T_OK}}
.hfx-tools .hfx-dot-error{background:${T_ERR}}
.hfx-tools .hfx-empty{color:${T_CAPTION}}
@keyframes hfx-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.7)}}
@media (prefers-reduced-motion:reduce){.hfx-tools .hfx-dot-run{animation:none}}
`;

  function Tools(props) {
    const t = safeT(props);
    const live = props.live || {};
    const view = React.useMemo(() => {
      const source = asList(live.tools);
      const rows = [];
      for (let i = source.length - 1; i >= 0 && rows.length < MAX_ROWS; i--) {
        const item = source[i] || {};
        const state = item.state === 'ok' || item.state === 'error' ? item.state : 'running';
        rows.push({ key: 't' + i, name: clip(item.name || item.id || 'tool', 30), state });
      }
      return { rows };
    }, [live, props.liveTick]);

    return h('div', { className: 'hfx-tools', style: { pointerEvents: 'none' } },
      h('style', null, CSS_TOOLS),
      h('div', { className: 'hfx-hd' }, t('ui.dispatch')),
      view.rows.length
        ? view.rows.map((row, index) => h('div', {
          key: row.key, className: 'hfx-trow', style: { opacity: Math.max(0.32, 1 - index * 0.1).toFixed(2) },
        },
        h('span', { className: 'hfx-dot hfx-dot-' + row.state, 'aria-hidden': 'true' }),
        h('span', { className: 'hfx-tname' }, row.name),
        h('span', { className: 'hfx-tstate hfx-tstate-' + row.state }, '\u00b7 ' + row.state)))
        : h('div', { className: 'hfx-trow hfx-empty' }, t('ui.empty'))
    );
  }

  /* ------------------------------------------------------------------ *
   * Console — grouped parameter panel
   * ------------------------------------------------------------------ */

  const CSS_CONSOLE = `
.hfx-console{position:absolute;top:var(--hfx-hud-top,8px);right:var(--hfx-hud-inset,12px);width:380px;max-width:calc(100vw - 24px);
  max-height:76vh;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;
  pointer-events:auto;border-radius:10px;contain:layout style;
  font:11px/1.45 ${FONT_STACK};letter-spacing:.06em;color:${T_LABEL_2};
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#0e0f12) 88%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l3,#3a3e46) 78%,transparent);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  box-shadow:0 12px 34px rgba(0,0,0,.45);outline:none}
.hfx-console .hfx-console-top{display:flex;flex-wrap:wrap;align-items:center;gap:5px;
  padding:7px 9px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 70%,transparent)}
.hfx-console .hfx-title{flex:1 1 auto;min-width:0;font-size:10px;font-weight:700;letter-spacing:.16em;
  text-transform:uppercase;color:${T_LABEL_1};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-right:2px}
.hfx-console .hfx-btn{font:inherit;letter-spacing:.06em;cursor:pointer;padding:2px 7px;border-radius:5px;
  color:${T_LABEL_2};background:transparent;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l3,#3a3e46) 72%,transparent)}
.hfx-console .hfx-btn:hover{color:${T_LABEL_1};border-color:${T_ACCENT};
  background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hfx-console .hfx-btn.on{color:var(--dsw-alias-label-primary-inverted,#0b0d10);
  background:var(--dsw-alias-button-primary-fill,#6ea8ff);border-color:transparent}
.hfx-console .hfx-btn-danger:hover{color:${T_ERR};border-color:${T_ERR}}
.hfx-console .hfx-btn-close{padding:2px 6px}
.hfx-console .hfx-ta{box-sizing:border-box;width:100%;height:88px;resize:vertical;margin:0;
  padding:6px 9px;border:0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 70%,transparent);
  font:inherit;font-size:10px;letter-spacing:0;
  color:${T_LABEL_1};background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b0d10) 55%,transparent);outline:none}
.hfx-console .hfx-body{overflow:auto;flex:1 1 auto;min-height:0;padding:2px 9px 10px;
  scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,#2a2f3a) transparent}
.hfx-console .hfx-body::-webkit-scrollbar{width:8px;height:8px}
.hfx-console .hfx-body::-webkit-scrollbar-track{background:transparent}
.hfx-console .hfx-body::-webkit-scrollbar-thumb{border-radius:4px;
  background:var(--dsw-alias-scrollbar-bg-l2,#2a2f3a)}
.hfx-console .hfx-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,#3a3e46)}
.hfx-params .hfx-group-h{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;
  font:inherit;font-weight:700;letter-spacing:.14em;text-transform:uppercase;text-align:left;cursor:pointer;
  color:${T_LABEL_1};background:transparent;border:0;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 55%,transparent);
  padding:7px 0 5px;margin:0}
.hfx-params .hfx-group-h:hover{color:${T_ACCENT}}
.hfx-params .hfx-caret{color:${T_CAPTION};width:9px;flex:none}
.hfx-params .hfx-count{margin-left:auto;font-weight:400;letter-spacing:.06em;color:${T_CAPTION}}
.hfx-params .hfx-rows{padding:3px 0 5px}
.hfx-params .hfx-row{display:grid;grid-template-columns:minmax(0,1fr) 104px 46px;gap:6px;align-items:center;padding:3px 0}
.hfx-params .hfx-row label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default;color:${T_LABEL_3}}
.hfx-params .hfx-row label:hover{color:${T_LABEL_1}}
.hfx-params .hfx-row.chg label{color:${T_ACCENT}}
.hfx-params .hfx-range{width:100%;height:12px;margin:0;padding:0;background:transparent;cursor:pointer;
  accent-color:var(--dsw-alias-brand-primary,#6ea8ff)}
.hfx-params .hfx-num{text-align:right;font-size:10px;color:${T_LABEL_1};font-variant-numeric:tabular-nums}
.hfx-console .hfx-empty{color:${T_CAPTION};padding:8px 0}
.hfx-console .hfx-hint{display:flex;align-items:center;gap:8px;height:26px;box-sizing:border-box;
  padding:0 9px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 70%,transparent);
  font-size:10px;color:${T_CAPTION}}
.hfx-console .hfx-hint-text{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hfx-console .hfx-flash{flex:none;font-weight:700;letter-spacing:.1em}
.hfx-console .hfx-flash-copied,.hfx-console .hfx-flash-ok{color:${T_OK}}
.hfx-console .hfx-flash-err{color:${T_ERR}}
`;

  /** One slider row: local while dragging, committed on release or after 120ms. */
  function ParamRow(props) {
    const t = safeT(props);
    const entry = props.entry;
    const fallback = isFinite(props.def) ? props.def : entry.min;
    const external = isFinite(Number(props.value)) ? Number(props.value) : fallback;
    const [local, setLocal] = React.useState(external);
    const dragging = React.useRef(false);
    const timer = React.useRef(0);

    React.useEffect(() => {
      if (!dragging.current) setLocal(external);
    }, [external]);

    React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const commit = React.useCallback((raw) => {
      const value = Number(raw);
      if (!isFinite(value)) return;
      const next = clamp(value, entry.min, entry.max);
      dragging.current = false;
      setLocal(next);
      if (typeof props.setParams === 'function') {
        const partial = {};
        partial[entry.key] = next;
        props.setParams(partial);
      }
    }, [entry.key, entry.min, entry.max, props.setParams]);

    const onInput = (event) => {
      const value = Number(event.currentTarget.value);
      if (!isFinite(value)) return;
      dragging.current = true;
      setLocal(value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = 0; commit(value); }, COMMIT_MS);
    };

    const onRelease = (event) => {
      if (timer.current) { clearTimeout(timer.current); timer.current = 0; }
      commit(event.currentTarget.value);
    };

    const restoreDefault = () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = 0; }
      if (!isFinite(props.def)) return;
      setLocal(props.def);
      dragging.current = false;
      if (typeof props.setParams === 'function') {
        const partial = {};
        partial[entry.key] = props.def;
        props.setParams(partial);
      }
    };

    const changed = isFinite(props.def) && Math.abs(props.def - external) > 1e-9;

    return h('div', { className: 'hfx-row' + (changed ? ' chg' : '') },
      h('label', {
        title: entry.label + '  [' + entry.min + ' \u2013 ' + entry.max + ']  ' + t('ui.reset'),
        onDoubleClick: restoreDefault,
      }, entry.label),
      h('input', {
        className: 'hfx-range', type: 'range', tabIndex: 0, step: entry.step,
        min: entry.min, max: entry.max, value: local, 'aria-label': entry.label,
        onChange: onInput, onPointerUp: onRelease, onMouseUp: onRelease, onTouchEnd: onRelease,
        onKeyUp: onRelease, onBlur: onRelease,
      }),
      h('span', { className: 'hfx-num' }, fmtValue(local, entry.step))
    );
  }

  /** Rows are memoised: live ticks must not re-render 65 sliders. */
  const ParamList = memo(function ParamList(props) {
    return h('div', { className: 'hfx-rows' }, props.items.map((entry) => h(ParamRow, {
      key: entry.key, entry, t: props.t,
      value: props.params ? props.params[entry.key] : undefined,
      def: props.defaults[entry.key],
      setParams: props.setParams,
    })));
  }, (a, b) => (
    a.items === b.items && a.params === b.params &&
    a.defaults === b.defaults && a.setParams === b.setParams && a.t === b.t
  ));

  function ParamGroup(props) {
    const group = props.group;
    return h('div', { className: 'hfx-group' },
      h('button', {
        type: 'button', className: 'hfx-group-h', 'aria-expanded': props.collapsed ? 'false' : 'true',
        onClick: props.onToggle,
      },
      h('span', { className: 'hfx-caret' }, props.collapsed ? '\u25b8' : '\u25be'),
      h('span', null, group.name),
      h('span', { className: 'hfx-count' }, String(group.items.length))
      ),
      props.collapsed ? null : h(ParamList, {
        items: group.items, params: props.params, defaults: props.defaults,
        setParams: props.setParams, t: props.t,
      })
    );
  }

  function Console(props) {
    const t = safeT(props);
    const open = props.open === true;
    const params = props.params || {};
    const setParams = typeof props.setParams === 'function' ? props.setParams : () => {};
    const presets = props.presets && typeof props.presets === 'object' ? props.presets : {};

    const groups = React.useMemo(() => groupEntries(readParamEntries()), []);
    // mount owns the shipped defaults (author MINE preset + plugin overrides); the
    // local computation is only a fallback for a standalone render.
    const defaults = React.useMemo(
      () => (props.defaults && typeof props.defaults === 'object' ? props.defaults : defaultValues()),
      [props.defaults],
    );
    const presetNames = React.useMemo(() => {
      const keys = Object.keys(presets);
      const ordered = PRESET_ORDER.filter((k) => keys.indexOf(k) >= 0);
      for (const key of keys) if (ordered.indexOf(key) < 0) ordered.push(key);
      return ordered;
    }, [presets]);
    const activePreset = React.useMemo(() => {
      for (const name of presetNames) if (matchesPreset(params, presets[name])) return name;
      return '';
    }, [params, presets, presetNames]);

    // first two groups expanded, like the original console
    const [collapsed, setCollapsed] = React.useState(() => {
      const map = {};
      groups.forEach((group, index) => { map[group.name] = index >= 2; });
      return map;
    });
    const [importOpen, setImportOpen] = React.useState(false);
    const [importText, setImportText] = React.useState('');
    const [flash, setFlash] = React.useState('');

    const timer = React.useRef(0);
    React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    React.useEffect(() => { if (!open && importOpen) setImportOpen(false); }, [open, importOpen]);

    const flashTo = React.useCallback((code) => {
      setFlash(code);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = 0; setFlash(''); }, FLASH_MS);
    }, []);

    const toggleGroup = React.useCallback((name) => {
      setCollapsed((prev) => {
        const next = Object.assign({}, prev);
        next[name] = !next[name];
        return next;
      });
    }, []);

    const close = () => { if (typeof props.setOpen === 'function') props.setOpen(false); };

    const onExport = () => {
      let json = '';
      try { json = typeof props.exportJson === 'function' ? String(props.exportJson()) : ''; } catch { json = ''; }
      if (!json) { flashTo('err'); return; }
      setImportOpen(true);
      setImportText(json);              // written out so it can also be copied by hand
      try {
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (clip && typeof clip.writeText === 'function') clip.writeText(json).then(() => {}, () => {});
      } catch { /* clipboard blocked: the textarea still holds the JSON */ }
      flashTo('copied');
    };

    const onImportKey = (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      let ok = false;
      try { ok = props.importJson(importText) === true; } catch { ok = false; }
      flashTo(ok ? 'ok' : 'err');
      if (ok) setImportOpen(false);
    };

    const onSaveDefault = () => {
      try {
        if (typeof props.saveDefault === 'function') { props.saveDefault(); flashTo('ok'); return; }
      } catch { /* fall through */ }
      flashTo('err');
    };

    const onReset = () => {
      try {
        if (typeof props.resetDefault === 'function') { props.resetDefault(); flashTo('ok'); return; }
      } catch { /* fall through */ }
      flashTo('err');
    };

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };

    if (!open) return null;

    return h('div', {
      className: 'hfx-console', style: { pointerEvents: 'auto' }, tabIndex: -1, role: 'dialog',
      'aria-label': t('ui.consoleTitle'), onKeyDown,
    },
      h('style', null, CSS_CONSOLE),
      h('div', { className: 'hfx-console-top' },
        h('span', { className: 'hfx-title' }, t('ui.consoleTitle')),
        presetNames.map((name) => h('button', {
          key: 'preset-' + name, type: 'button',
          className: 'hfx-btn' + (name === activePreset ? ' on' : ''),
          title: t('ui.presets') + ': ' + name,
          onClick: () => { if (typeof props.applyPreset === 'function') props.applyPreset(name); },
        }, name)),
        h('button', { type: 'button', className: 'hfx-btn', onClick: onExport }, t('ui.export')),
        h('button', {
          type: 'button', className: 'hfx-btn' + (importOpen ? ' on' : ''),
          onClick: () => setImportOpen((v) => !v),
        }, t('ui.import')),
        h('button', { type: 'button', className: 'hfx-btn', onClick: onSaveDefault }, t('ui.saveDefault')),
        h('button', { type: 'button', className: 'hfx-btn hfx-btn-danger', onClick: onReset }, t('ui.reset')),
        h('button', {
          type: 'button', className: 'hfx-btn hfx-btn-close',
          title: t('ui.close'), 'aria-label': t('ui.close'), onClick: close,
        }, '\u2715')
      ),
      importOpen ? h('textarea', {
        className: 'hfx-ta', value: importText, spellCheck: false,
        placeholder: t('ui.import'), 'aria-label': t('ui.import'),
        onChange: (event) => setImportText(event.target.value),
        onKeyDown: onImportKey,
      }) : null,
      h('div', { className: 'hfx-body hfx-params' },
        groups.length
          ? groups.map((group) => h(ParamGroup, {
            key: group.name, group, params, defaults, setParams, t,
            collapsed: collapsed[group.name] === true,
            onToggle: () => toggleGroup(group.name),
          }))
          : h('div', { className: 'hfx-empty' }, t('ui.empty'))
      ),
      h('div', { className: 'hfx-hint' },
        h('span', { className: 'hfx-hint-text' }, t('ui.hint')),
        flash ? h('span', { className: 'hfx-flash hfx-flash-' + flash },
          flash === 'copied' ? t('ui.copied') : flash === 'ok' ? '\u2713' : '\u2717') : null
      )
    );
  }

  return {
    Stats, Feed, Tools, Console,
    /* parameter UI shared with the settings page (settings.section) */
    ParamGroup, ParamList,
    readParamEntries, groupEntries, defaultValues, matchesPreset,
    PRESET_ORDER,
  };
})();

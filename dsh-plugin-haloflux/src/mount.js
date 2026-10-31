/**
 * HALOFLUX for DSH — Client assembly.
 *
 */
const HalofluxPlugin = (() => {
  const NS = 'haloflux';
  const STORAGE_KEY = 'dsh-haloflux:params:v2';
  const PARAMS_KEY = 'dsh-haloflux:params:default:v2';
  /** a Session switch can report "no main session" for a frame or two: never collapse inside it */
  const SWITCH_GRACE_MS = 1200;
  /** a stale "idle" right after a switch is held off only briefly, so a running -> idle
      switch starts dimming WITH the turn instead of spinning at full brightness first */
  const SWITCH_SETTLE_MS = 260;

  const DICT = {
    en: {
      'ui.console': 'CONTROL',
      'ui.consoleTitle': 'HALOFLUX console',
      'ui.presets': 'Presets',
      'ui.export': 'Export',
      'ui.import': 'Import',
      'ui.saveDefault': 'Save as default',
      'ui.reset': 'Reset',
      'ui.close': 'Close',
      'ui.hint': 'C console · H hud · Esc close',
      'ui.idle': 'IDLE',
      'ui.running': 'RUNNING',
      'ui.tokens': 'TOKENS',
      'ui.rate': 'TOK/S',
      'ui.context': 'CONTEXT',
      'ui.steps': 'STEPS',
      'ui.tools': 'TOOLS',
      'ui.feed': 'EVENT FEED',
      'ui.tokensFeed': 'TOKEN STREAM',
      'ui.dispatch': 'TOOL DISPATCH',
      'ui.empty': 'waiting for the next call',
      'ui.copied': 'copied',
      'ui.camera': 'CAMERA',
      'ui.cameraHint': 'Auto camera: occasional push-in on a detail. Off keeps one steady framing.',
      'ui.sectionLabel': 'HALOFLUX',
      'ui.settingsHeading': 'HALOFLUX live ring',
      'ui.settingsDesc': 'A frame-wide light-ring background driven by the current session: ring rotation, token capture and beams follow the running model call and stop when it settles.',
      'ui.dataTitle': 'Data source',
      'ui.dataMode': 'Data capture',
      'ui.mode0': 'Animation only',
      'ui.mode1': 'Mixed 30%',
      'ui.mode2': 'Full capture',
      'ui.mode0Hint': 'Level 0 - pure animation: the ring shows the original HALOFLUX sample words and numbers and never touches the session text stream (pullTokens is skipped). Brightness still follows the running/idle state.',
      'ui.mode1Hint': 'Level 1 - mixed (the current look): ring text comes from the streaming answer whenever tokens are available, while numbers and headers stay synthetic.',
      'ui.mode2Hint': 'Level 2 - full capture: every word and number comes from this session (streaming tokens, tool names, step/turn, tok/s, context). A panel stays blank when there is nothing real to show.',
      'ui.configTitle': 'Presets & config',
      'ui.paramsTitle': 'Parameters',
      'ui.saved': 'saved',
      'ui.failed': 'failed',
      'ui.apply': 'Apply',
      'ui.importHint': 'Paste JSON, then Enter to apply',
    },
    zh: {
      'ui.console': '控制台',
      'ui.consoleTitle': 'HALOFLUX 控制台',
      'ui.presets': '预设',
      'ui.export': '导出',
      'ui.import': '导入',
      'ui.saveDefault': '保存为默认',
      'ui.reset': '重置',
      'ui.close': '关闭',
      'ui.hint': 'C 控制台 · H 面板 · Esc 关闭',
      'ui.idle': '空闲',
      'ui.running': '运行中',
      'ui.tokens': '词元',
      'ui.rate': '词元/秒',
      'ui.context': '上下文',
      'ui.steps': '步数',
      'ui.tools': '工具',
      'ui.feed': '事件流',
      'ui.tokensFeed': '词元流',
      'ui.dispatch': '工具调度',
      'ui.empty': '等待下一次调用',
      'ui.copied': '已复制',
      'ui.camera': '运镜',
      'ui.cameraHint': '自动运镜：不定时推近画面看局部。关闭后保持固定机位。',
      'ui.sectionLabel': 'HALOFLUX',
      'ui.settingsHeading': 'HALOFLUX 实时光环',
      'ui.settingsDesc': '由当前会话驱动的全帧光环背景：圆盘转动、词元抓取与光束跟随模型调用，调用结束即同步停止。',
      'ui.dataTitle': '数据来源',
      'ui.dataMode': '数据抓取档位',
      'ui.mode0': '纯动画',
      'ui.mode1': '混合 30%',
      'ui.mode2': '完全抓取',
      'ui.mode0Hint': '0 档 · 纯动画：环上的词与数字全部来自原作示例，不抓取任何会话文字（不调用词元流）；画面亮度仍随「运行/静默」变化。',
      'ui.mode1Hint': '1 档 · 混合（现在的样子）：有词元时环上的文字来自正在流出的真实回答，数字与表头仍为合成数据。',
      'ui.mode2Hint': '2 档 · 完全抓取：每个词、每个数字都来自当前会话（流式词元、工具名、step/turn、tok/s、上下文）；没有真实数据时面板留空。',
      'ui.configTitle': '预设与配置',
      'ui.paramsTitle': '参数',
      'ui.saved': '已保存',
      'ui.failed': '失败',
      'ui.apply': '应用',
      'ui.importHint': '粘贴 JSON 后按 Enter 应用',
    },
  };

  const BASE_CSS = `
.hfx-root{position:absolute;inset:0;pointer-events:none;z-index:0;isolation:auto}
.hfx-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
.hfx-hud{position:absolute;inset:0;pointer-events:none;font:11px/1.45 "JetBrains Mono",Consolas,ui-monospace,monospace;
  letter-spacing:.06em;color:var(--dsw-alias-label-secondary,#8b93a7);user-select:none}
.hfx-panel{pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b0d10) 82%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 70%,transparent);
  border-radius:10px;backdrop-filter:blur(10px)}
.hfx-dim{color:var(--dsw-alias-label-tertiary,#6a7285)}
.hfx-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6ecff)}
.hfx-pink{color:#ff9ecb}.hfx-cyan{color:#7fd8ff}
`;

  /* ---------- params live in the shared store (src/state.js) ---------- */

  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  /* ---------- locale ---------- */

  function makeT(locale) {
    function activeId() {
      try {
        const snap = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined;
        const id = snap && (snap.locale || snap.id || snap.current);
        if (typeof id === 'string' && id) return id;
      } catch { /* ignore */ }
      try {
        const lang = (navigator.language || 'en').toLowerCase();
        if (lang.startsWith('zh')) return 'zh';
      } catch { /* ignore */ }
      return 'en';
    }
    return function t(key) {
      const id = activeId();
      const dict = DICT[id] || DICT[id.split('-')[0]] || DICT.en;
      return dict[key] || DICT.en[key] || key;
    };
  }

  /* ---------- stable selectors ---------- */

  const selectMainSessionId = (state) => {
    if (!state || !state.byId) return undefined;
    const rows = Object.values(state.byId);
    for (const row of rows) if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.id;
    return rows.length === 1 && rows[0] ? rows[0].id : undefined;
  };

  /** A blank Session is the "new session" hero page: the decoration fades out there. */
  const selectMainBlank = (state) => {
    if (!state || !state.byId) return false;
    const id = selectMainSessionId(state);
    const row = id === undefined ? undefined : state.byId[id];
    return !!(row && row.blank === true);
  };

  /* ---------- the layer ---------- */

  function HalofluxLayer(props) {
    const { useSessions, useSessionStatus } = props;
    const h = React.createElement;

    const sessionsSvc = props.__sessions || undefined;
    const t = props.__t;

    const sessionId = useSessions(selectMainSessionId);
    const blank = useSessions(selectMainBlank);
    const stateSelector = React.useCallback((map) => {
      const hit = map && map.get ? map.get(sessionId) : undefined;
      return hit ? hit.running === true : undefined;
    }, [sessionId]);
    const running = useSessionStatus(stateSelector);

    // "present" = a real conversation is on screen. The blank New Session hero page
    // (and the no-session page) both mean absent, so the halo fades out there.
    const present = sessionId !== undefined && !blank;

    const hostRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const engineRef = React.useRef(null);
    const liveRef = React.useRef(null);
    const sessionRef = React.useRef(sessionId);
    sessionRef.current = sessionId;
    const prevSessionRef = React.useRef(sessionId);
    /** when the current switch started: keeps a fresh Session's stale "not running" out */
    const switchAtRef = React.useRef(0);

    const params = HalofluxState.useParams();
    const [open, setOpen] = React.useState(false);
    const [stats, setStats] = React.useState(null);
    const [liveTick, setLiveTick] = React.useState(0);

    const patchParams = React.useCallback((partial) => { HalofluxState.set(partial); }, []);

    /* live source: created once, bound to the active session */
    React.useEffect(() => {
      const live = createHalofluxLive({
        getSessionId: () => sessionRef.current,
        bindingOf: (id) => {
          try {
            const svc = sessionsSvc || (props.__ctx && props.__ctx.get && props.__ctx.get('sessions'));
            return svc && typeof svc.binding === 'function' ? svc.binding(id) : undefined;
          } catch { return undefined; }
        },
      });
      liveRef.current = live;
      // presence must be right before the first frame, not one effect later
      try { live.sessionPresent = sessionRef.current !== undefined; } catch { /* readonly */ }
      const off = live.subscribe(() => setLiveTick((n) => (n + 1) % 1000000));
      try { if (typeof window !== 'undefined' && window.__HFX_DEBUG) window.__hfx = { live: live, engine: () => engineRef.current }; } catch { /* debug hook */ }
      return () => { off(); live.dispose(); liveRef.current = null; };
    }, []);

    /* live session switch. A switch can report "no main session" for a frame or
       two; skip those gaps so the previous feed (and its level) survives until the
       new Session's binding is actually published. */
    React.useEffect(() => {
      if (sessionId === undefined) return;
      if (liveRef.current) liveRef.current.setSession(sessionId);
    }, [sessionId]);

    /* presence: running conversation vs. New Session hero / no Session at all.
       Applied only after a short grace, otherwise the whole frame collapses to
       voidLevel in the middle of a Session switch. */
    React.useEffect(() => {
      const live = liveRef.current;
      if (!live) return undefined;
      if (present) { live.sessionPresent = true; return undefined; }
      const timer = setTimeout(() => {
        live.sessionPresent = false;
        live.setRunning(false);
        live.setSession(undefined);
      }, SWITCH_GRACE_MS);
      return () => { clearTimeout(timer); };
    }, [present]);

    /* switching to a different real conversation spins the ring exactly one turn.
       The last real id is remembered across a transient undefined gap, so a
       S1 -> (gap) -> S2 switch still revolves instead of resetting silently. */
    React.useEffect(() => {
      if (sessionId === undefined) return;
      const previous = prevSessionRef.current;
      prevSessionRef.current = sessionId;
      if (previous === undefined || previous === sessionId) return;
      switchAtRef.current = Date.now();
      const engine = engineRef.current;
      // the non-revolve switch effects run even when the ring spin is disabled
      if (engine && typeof engine.switchFx === 'function') engine.switchFx();
      if (!(params.revolveOnSwitch >= 0.5)) return;
      if (engine && typeof engine.revolve === 'function') engine.revolve(1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    /* author's default on first run */
    React.useEffect(() => {
      if (prefersReducedMotion() && params.idleMotion > 0.05) patchParams({ idleMotion: 0.05 });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* engine lifecycle */
    React.useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !liveRef.current) return undefined;
      const engine = HalofluxEngine.create({
        canvas,
        live: liveRef.current,
        params,
        onStats: setStats,
      });
      engineRef.current = engine;
      engine.start();
      return () => { engineRef.current = null; engine.dispose(); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* params -> engine */
    React.useEffect(() => {
      const engine = engineRef.current;
      if (engine) engine.setParams(params);
    }, [params]);

    /* running state -> live (a hero/no-session page is never "running").
       Absence is applied by the presence effect above, with its grace period. */
    React.useEffect(() => {
      const live = liveRef.current;
      if (!live) return undefined;
      if (!present) return undefined;
      if (typeof running !== 'boolean') return undefined;
      if (running === false) {
        // A freshly opened Session may project running=false for a beat before its
        // own status arrives; hold it off briefly, then let the release overlap the
        // turn so the light drains while the ring is still moving.
        const left = SWITCH_SETTLE_MS - (Date.now() - switchAtRef.current);
        if (left > 0) {
          const timer = setTimeout(() => { live.setRunning(false); }, left);
          return () => { clearTimeout(timer); };
        }
      }
      live.setRunning(running);
      return undefined;
    }, [running, present]);

    /* container resize */
    React.useEffect(() => {
      const host = hostRef.current;
      if (!host || typeof ResizeObserver === 'undefined') return undefined;
      let raf = 0;
      const ro = new ResizeObserver(() => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (engineRef.current) engineRef.current.resize();
        });
      });
      ro.observe(document.documentElement);
      return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
    }, []);

    /* visibility: stop burning frames on a hidden tab */
    React.useEffect(() => {
      const onVis = () => {
        const engine = engineRef.current;
        if (!engine) return;
        if (document.hidden) engine.stop(); else engine.start();
      };
      document.addEventListener('visibilitychange', onVis);
      return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    /* keyboard: C console, H hud */
    React.useEffect(() => {
      const onKey = (event) => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target;
        const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return;
        const key = String(event.key || '').toLowerCase();
        if (key === 'c') { setOpen((v) => !v); }
        else if (key === 'h') { patchParams({ hudOn: params.hudOn ? 0 : 1 }); }
        else if (key === 'escape') { setOpen(false); }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [params.hudOn, patchParams]);

    const blendMode = ['screen', 'lighten', 'normal'][params.blend | 0] || 'screen';
    const opacity = Math.max(0, Math.min(1, params.opacity));
    const hudVisible = params.hudOn >= 0.5 && params.opacity > 0.02;

    const live = liveRef.current;
    /** stable defaults object: the slider list memoises on reference identity */
    const baseDefaults = React.useMemo(() => HalofluxState.baseParams(), []);

    const hudProps = {
      params, setParams: patchParams, live, t, stats,
      open, setOpen,
      defaults: baseDefaults,
      presets: HalofluxEngine.PRESETS,
      applyPreset: (name) => {
        const preset = HalofluxEngine.PRESETS[name];
        if (preset) patchParams({ ...preset });
      },
      exportJson: () => HalofluxState.exportJson(),
      importJson: (text) => HalofluxState.importJson(text),
      saveDefault: () => HalofluxState.saveDefault(),
      resetDefault: () => HalofluxState.resetDefault(),
    };

    return h('div', { className: 'hfx-root', ref: hostRef, 'aria-hidden': open ? undefined : true, style: { pointerEvents: 'none' } },
      h('style', null, BASE_CSS),
      h('canvas', {
        ref: canvasRef,
        className: 'hfx-canvas',
        style: { opacity, mixBlendMode: blendMode === 'normal' ? undefined : blendMode },
      }),
      hudVisible && HalofluxHud && live ? h(HalofluxHud.Stats, { ...hudProps, liveTick }) : null,
      hudVisible && HalofluxHud && live ? h(HalofluxHud.Feed, { ...hudProps, liveTick }) : null,
      hudVisible && HalofluxHud && live ? h(HalofluxHud.Tools, { ...hudProps, liveTick }) : null,
      HalofluxHud && live ? h(HalofluxHud.Console, { ...hudProps, liveTick }) : null,
    );
  }

  /**
   * Root-scoped slot entries cannot read the plugin's own context from props,
   * so the registration closes over it here.
   */
  function makeLayer(ctx, t) {
    return function HalofluxLayerBound(props) {
      return HalofluxLayer({ ...props, __ctx: ctx, __t: t, __sessions: ctx.get('sessions') });
    };
  }

  /**
   * The settings page lives in the Settings panel's own React tree, so it only
   * receives the locale closure; parameters travel through HalofluxState.
   */
  function makeSettingsPage(t) {
    return function HalofluxSettingsPage() {
      return React.createElement(HalofluxSettings.SettingsPage, { __t: t });
    };
  }

  return {
    inject: ['slots', 'sessions'],
    apply(ctx) {
      let t = makeT(undefined);
      try {
        const locale = ctx.get('locale');
        if (locale) {
          try { locale.register(NS, 'en', DICT.en); } catch { /* already registered */ }
          try { locale.register(NS, 'zh', DICT.zh); } catch { /* already registered */ }
          t = makeT(locale);
        }
      } catch { /* locale absent: fall back to navigator */ }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'haloflux',
        order: -10,
        label: () => t('ui.consoleTitle'),
      }, makeLayer(ctx, t)));

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'haloflux',
        order: 50,
        label: () => t('ui.sectionLabel'),
      }, makeSettingsPage(t)));
    },
  };
})();
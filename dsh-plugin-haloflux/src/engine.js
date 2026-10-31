/**
 * Canvas rendering engine for the live ring decoration.
 *
 * Plain script fragment: no import / export / top-level require. Defines exactly
 * one global symbol, `HalofluxEngine`. Every surface it touches is either the
 * canvas handed to create() or an offscreen canvas it created itself: no
 * getElementById, no DOM writes, no global listeners. Resize is driven by the
 * host calling resize(); the render loop by start()/stop().
 */
const HalofluxEngine = (() => {
  'use strict';

  /* =========================================================
     helpers
     ========================================================= */
  const TAU = Math.PI * 2;
  const rnd = Math.random;
  const rr = (a, b) => a + rnd() * (b - a);
  const pick = a => a[(rnd() * a.length) | 0];
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const normA = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const hash = x => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };
  const easeIO = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeO = t => 1 - Math.pow(1 - t, 3);
  const easeOX = t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
  const FONT = '"JetBrains Mono",Consolas,ui-monospace,monospace';
  const rgba = (t, a) => `rgba(${t[0]},${t[1]},${t[2]},${a})`;

  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const rafFn = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(nowMs()), 16);
  const cafFn = (typeof cancelAnimationFrame === 'function')
    ? cancelAnimationFrame
    : (id) => clearTimeout(id);

  /** create an offscreen canvas without ever touching the host DOM tree */
  function newCanvas(w, h) {
    const cw = Math.max(1, Math.ceil(w || 1)), ch = Math.max(1, Math.ceil(h || 1));
    if (typeof document !== 'undefined' && document.createElement) {
      try { return document.createElement('canvas'); } catch (e) { /* fall through */ }
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      try { return new OffscreenCanvas(cw, ch); } catch (e) { /* fall through */ }
    }
    return null;
  }
  function release(c) {
    if (!c) return;
    try { c.width = 1; c.height = 1; } catch (e) { /* ignore */ }
  }

  /* =========================================================
     live configuration (driven by the console)
     [key, label, min, max, step, group, rebuild]
     The first 56 entries are byte-identical to lab.html (key/label/min/max/step/group/rebuild).
     The trailing 9 entries live in the '插件' group and are added by this port.
     ========================================================= */
  const PARAMS = [
    ['tempo', '整体节拍速度', 0.4, 2.5, 0.05, '全局'],
    ['camera', '自动运镜 (0关 1开)', 0, 1, 1, '全局'],
    ['camZoom', '运镜推近幅度', 0, 2, 0.05, '全局'],
    ['glow', '柔光层强度', 0, 1.5, 0.05, '全局'],
    ['scan', '扫描线 (0关 1开)', 0, 1, 1, '全局'],

    ['ringSpeed', '圆环转动幅度/速度', 0, 3, 0.05, '圆环'],
    ['ringPause', '圆环停顿时长', 0, 3, 0.05, '圆环'],
    ['ringWidth', '环带厚度', 0.6, 1.6, 0.02, '圆环', 'resize'],
    ['rimBright', '内外缘细线亮度', 0, 2, 0.05, '圆环'],
    ['rimWidth', '内外缘细线带宽度', 0.3, 2.5, 0.05, '圆环', 'slots'],
    ['dataFlicker', '数据块刷新/闪烁', 0, 4, 0.1, '圆环'],

    ['webBright', '底层网线亮度', 0.1, 3, 0.05, '圈内', 'web'],
    ['webPulseBase', '网线闪烁层基础亮度', 0, 1, 0.02, '圈内'],
    ['webPulseAmp', '网线闪烁层节拍亮度', 0, 1, 0.02, '圈内'],
    ['webSpin', '网线整体转速', 0, 5, 0.1, '圈内'],
    ['runnerCount', '单独亮线 数量', 0, 900, 1, '圈内'],
    ['runnerBright', '单独亮线 亮度', 0, 2, 0.05, '圈内'],
    ['runnerWidth', '单独亮线 粗细', 0.3, 3, 0.05, '圈内'],
    ['runnerSpeed', '单独亮线 速度', 0.1, 4, 0.05, '圈内'],
    ['runnerVariety', '单独亮线 速度差异', 0, 1, 0.05, '圈内'],
    ['cometPerBeat', '成组光束 每拍数量', 0, 6, 0.1, '圈内'],
    ['cometBurst', '成组光束 重拍爆发数', 0, 12, 0.5, '圈内'],
    ['cometTrickle', '成组光束 拍间零星(每秒)', 0, 6, 0.1, '圈内'],
    ['cometLines', '成组光束 每组线数', 0.3, 3, 0.05, '圈内'],
    ['cometWidth', '成组光束 宽度', 0.3, 3, 0.05, '圈内'],
    ['cometBright', '成组光束 亮度', 0.1, 2.5, 0.05, '圈内'],
    ['cometGlow', '成组光束 柔光', 0, 3, 0.05, '圈内'],
    ['cometSpeed', '成组光束 速度', 0.3, 3, 0.05, '圈内'],
    ['cometFollow', '成组光束 跟随圆环 (0/1)', 0, 1, 1, '圈内'],

    ['beamBright', '伸缩光束 亮度', 0, 2.5, 0.05, '环外'],
    ['beamLen', '伸缩光束 长度', 0.2, 1.8, 0.05, '环外'],
    ['beamWidth', '伸缩光束 线粗细', 0.3, 3, 0.05, '环外'],
    ['beamBounce', '回弹波浪层 强度', 0, 2, 0.05, '环外'],
    ['beamGlow', '伸缩光束 柔光', 0, 6, 0.1, '环外'],
    ['dashBright', '流动短线 亮度', 0, 2, 0.05, '环外'],
    ['hazeCount', '宽光带 数量', 0, 30, 1, '环外'],
    ['hazeBright', '宽光带 亮度', 0, 3, 0.05, '环外'],
    ['flyerCount', '飞出流线(单独) 数量', 0, 3, 0.05, '环外', 'flyers'],
    ['flyerBright', '飞出流线(单独) 亮度', 0, 3, 0.05, '环外'],
    ['flyerWidth', '飞出流线 粗细', 0.3, 3, 0.05, '环外'],
    ['flyerSpeed', '飞出流线 速度', 0.2, 3, 0.05, '环外'],
    ['burstRate', '飞出流线(成组) 频率', 0, 5, 0.1, '环外'],
    ['burstSize', '飞出流线(成组) 每组数量', 0.2, 3, 0.05, '环外'],
    ['burstBright', '飞出流线(成组) 亮度', 0, 2.5, 0.05, '环外'],
    ['flareRate', '根部闪光 频率', 0, 5, 0.1, '环外'],
    ['flareBright', '根部闪光 亮度', 0, 2, 0.05, '环外'],
    ['rimDensity', '内外缘细线 密度', 0.3, 3, 0.05, '圆环'],
    ['depthBlur', '远景虚化 (环外远层)', 0, 5, 0.1, '空间层次'],
    ['depthDim', '远景亮度', 0, 1.5, 0.05, '空间层次'],
    ['webBlur', '圈内底层虚化', 0, 4, 0.1, '空间层次', 'web'],
    ['parallax', '视差 (运镜时远近错位)', 0, 1.5, 0.05, '空间层次'],
    ['bokeh', '前景光斑 数量', 0, 80, 1, '空间层次'],
    ['bokehBright', '前景光斑 亮度', 0, 3, 0.05, '空间层次'],
    ['atmos', '空间雾气', 0, 3, 0.05, '空间层次'],
    ['ringShadow', '圆环遮挡阴影', 0, 2, 0.05, '空间层次'],
    ['vignette', '暗角', 0, 1.5, 0.05, '空间层次'],

    /* ---- added by the DSH port ---- */
    ['opacity', '整体不透明度 (挂载层应用)', 0, 1, 0.05, '插件'],
    ['blend', '混合模式 (0屏幕 1变亮 2正常)', 0, 2, 1, '插件'],
    ['idleMotion', '静默态强度', 0, 1, 0.05, '插件'],
    ['activityGain', '活跃度增益', 0.2, 3, 0.05, '插件'],
    ['centerX', '构图中心 X', -2, 2, 0.05, '插件'],
    ['centerY', '构图中心 Y', -2, 2, 0.05, '插件'],
    ['scale', '整体缩放', 0.5, 2.5, 0.05, '插件'],
    ['hudOn', 'HUD 显示 (0关 1开)', 0, 1, 1, '插件'],
    ['feedOn', '事件流显示 (0关 1开)', 0, 1, 1, '插件'],
    /* ---- round 3: data capture level ---- */
    ['dataMode', '数据抓取档位 (0纯动画 1混合30% 2完全)', 0, 2, 1, '插件'],
    ['backdrop', '深色底 (0=透明发光 1=原作底)', 0, 1, 0.05, '插件'],
    /* ---- second round: state levels + transition timing + session revolve ---- */
    ['runLevel', '运行态强度', 0.2, 2, 0.05, '插件'],
    ['voidLevel', '无会话强度', 0, 1, 0.05, '插件'],
    ['attackMs', '起势时间(ms)', 100, 3000, 20, '插件'],
    ['releaseMs', '收势时间(ms)', 300, 8000, 20, '插件'],
    ['revolveOnSwitch', '切换会话整圈', 0, 1, 1, '插件'],
    ['revolveMs', '整圈用时(ms)', 300, 4000, 50, '插件'],
    ['easeCurve', '过渡曲线(0线性1平滑2更缓)', 0, 2, 1, '插件'],
    /* ---- round 4: session-switch effects (each independently switchable) ---- */
    ['revolveOuter', '切换：外圈光束跟随转 (0关 1开)', 0, 1, 1, '插件'],
    ['switchReveal', '切换：内容逐块揭示 (0关 1开)', 0, 1, 1, '插件'],
    ['switchFlash', '切换：亮度脉冲 强度', 0, 1, 0.05, '插件'],
    ['switchHue', '切换：色相扫过 强度', 0, 1, 0.05, '插件'],
    ['switchCam', '切换：镜头轻推 (0关 1开)', 0, 1, 1, '插件'],
  ];

  const BASE = {
    tempo: 1, camera: 1, camZoom: 1, glow: 1, scan: 1,
    ringSpeed: 1, ringPause: 1, ringWidth: 1, rimBright: 1, rimWidth: 1, dataFlicker: 1,
    webBright: 1, webPulseBase: 0.15, webPulseAmp: 0.85, webSpin: 1,
    runnerCount: 336, runnerBright: 1, runnerWidth: 1, runnerSpeed: 1, runnerVariety: 1,
    cometPerBeat: 1.1, cometBurst: 4, cometTrickle: 0, cometLines: 1, cometWidth: 1, cometBright: 1, cometGlow: 1.1, cometSpeed: 1, cometFollow: 0,
    beamBright: 1, beamBounce: 1, beamLen: 1, beamWidth: 1, beamGlow: 1, dashBright: 1, hazeCount: 8, hazeBright: 1,
    flyerCount: 1, flyerBright: 1, flyerWidth: 1, flyerSpeed: 1, burstRate: 1, burstSize: 1, burstBright: 1, flareRate: 1, flareBright: 1,
    rimDensity: 1, depthBlur: 1.4, depthDim: 0.9, webBlur: 0.7, parallax: 0.6, bokeh: 16, bokehBright: 1, atmos: 1, ringShadow: 1, vignette: 0.7,
    /* port defaults (mount.js applies the same values on top) */
    opacity: 0.55, blend: 0, idleMotion: 0.06, activityGain: 1,
    centerX: 0, centerY: 0, scale: 1, hudOn: 1, feedOn: 1, dataMode: 1, backdrop: 0,
    runLevel: 1, voidLevel: 0, attackMs: 800, releaseMs: 2600,
    revolveOnSwitch: 1, revolveMs: 1500, easeCurve: 1,
    revolveOuter: 1, switchReveal: 1, switchFlash: 0.6, switchHue: 0, switchCam: 1,
  };

  // 作者定稿默认（lab.html: BAKED_MINE, 2026-10-21）
  const BAKED_MINE = {
    tempo: 2.5, camera: 1, camZoom: 1, glow: 1.1, scan: 1, ringSpeed: 3, ringPause: 1.2, ringWidth: 1.3,
    rimBright: 1.8, rimWidth: 1.3, dataFlicker: 1, webBright: 0.9, webPulseBase: 0.1, webPulseAmp: 0.8,
    webSpin: 1, runnerCount: 788, runnerBright: 0.5, runnerWidth: 1, runnerSpeed: 0.6, runnerVariety: 0.4,
    cometPerBeat: 2.3, cometBurst: 9, cometTrickle: 1.5, cometLines: 1, cometWidth: 1, cometBright: 1,
    cometGlow: 1.1, cometSpeed: 0.8, cometFollow: 1, beamBright: 1.8, beamLen: 1.8, beamWidth: 0.7,
    beamBounce: 2, beamGlow: 3.5, dashBright: 1.9, hazeCount: 22, hazeBright: 1.5, flyerCount: 3,
    flyerBright: 3, flyerWidth: 1.4, flyerSpeed: 2.2, burstRate: 3.5, burstSize: 3, burstBright: 2.5,
    flareRate: 3.5, flareBright: 2, rimDensity: 1.2, depthBlur: 0, depthDim: 0.1, webBlur: 0, parallax: 0,
    bokeh: 0, bokehBright: 0, atmos: 0, ringShadow: 0, vignette: 0,
  };

  const PRESETS = {
    A: {
      ...BASE, webBright: 1.25, webPulseBase: 0.3, webPulseAmp: 0.4, runnerCount: 45, runnerVariety: 0,
      cometPerBeat: 2.5, cometBurst: 5, cometTrickle: 1.6, cometFollow: 1, cometGlow: 0.85,
    },
    B: { ...BASE },
  };
  PRESETS.MINE = { ...BASE, ...BAKED_MINE };

  const PMAP = {};
  for (const p of PARAMS) PMAP[p[0]] = { label: p[1], min: p[2], max: p[3], step: p[4], group: p[5], rebuild: p[6] };

  /* =========================================================
     static data (lab.html constants; the fabricated research
     labels were replaced by neutral instrumentation labels so no
     preset fake data ships in the product)
     ========================================================= */
  // original TOK list — fallback text for the ring data blocks when live has no tokens
  const FALLBACK_TOK = ['load_collection()', 'extract_eq', '∂u/∂t', 'rho', 'grad(p)', 'dt=1e-3', 'assert', 'residual', 'solve()',
    'mesh', 'bc.apply', 'flux', 'CFL', '0.0041', 'ok', 'PASS', 'ref#12', 'scene_07', 'u_star', 'div(u)', 'proj', 'advect',
    'step++', 'tol', '1.2e-6', 'kernel', 'paper[37]', 'eq.(4)', 'fig.3', 'table2', 'nu=0.01', 'v_x', 'omega', 'bounce',
    'f_eq', 'stream', 'collide', 'Re=100', 'check', '>>>', 'match', 'diff', 'L2', 'grid64', 'cfg', 'seed=7'];

  const PATTERN = [0.5, 0.25, 0.25, 0.5, 0.5, 0.75, 0.25, 0.25, 0.25, 1.0];
  const NSTEP = 0.0038;          // outer radial line step (lab.html OSTEP)
  const GS = 3;                  // glow buffer downscale
  const FS = 0.5;                // far-layer buffer scale
  const RING_SC = 2.4;           // ring slot pre-render scale
  const EDGE_A = [0.28, 0.62, 1];
  const FLY_A = [0.16, 0.36, 0.7];

  const TINTS = [[232, 234, 240], [232, 234, 240], [232, 234, 240], [232, 234, 240], [232, 234, 240], [232, 234, 240],
    [196, 184, 246], [196, 184, 246], [168, 222, 214], [206, 212, 150]];
  const HEAD = ['CAL/02', 'EXTRACT', 'CHUNK 07', 'STEP 04', 'CHECK', 'RESIDUAL', 'BUFFER 37', 'CH 09', 'HASH A',
    'DIFF FIELD', 'STEP 1284', 'GRID 64x64', 'PROJECT', 'ADVECT', 'BC / WALL', 'QUEUE 2', 'TRACE', 'EQ.04', 'FIG.03',
    'VALIDATE', 'SCENE 12'];
  const KEYS = ['dt', 'CFL', 'nu', 'Re', 'tol', 'iter', 'L2', 'mass', 'div', 'u_max', 'rho', 'err', 'grid', 'seed'];
  const CODE_T = ['load()', 'step(u)', 'proj(p)', 'bc.apply', 'solve()', 'grad p', 'div u', 'assert', 'f_eq', 'stream',
    'collide', 'ok', 'PASS', 'ref#12', 'diff', 'L2<tol', 'u*', '->', '==', 'dt/2', 'emit', 'push', 'read', 'fig03', 'eq04'];
  const CHECKS = [
    ['STABILITY CHECK', 'CFL = |u| Δt / Δx'],
    ['MASS CONSERVATION', 'Σ ρ dV = const'],
    ['RESIDUAL NORM', 'r = ‖b − A·u‖₂'],
    ['BOUNDARY', 'u · n = 0  on ∂Ω'],
    ['PROJECTION', '∇²p = ∇ · u* / Δt'],
  ];
  const BLOCK_W = [['code', 16], ['kv', 11], ['spark', 9], ['bars', 8], ['prog', 7], ['grid', 7], ['gauge', 3], ['wave', 4],
    ['para', 12], ['cols', 7], ['barcode', 6], ['matrix', 8]];
  const NEEDS_H = { code: 18, spark: 18, bars: 20, wave: 18, gauge: 16 };

  /* =========================================================
     engine factory
     ========================================================= */
  function create(cfg) {
    const conf = cfg || {};
    const canvas = conf.canvas;
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('HalofluxEngine.create: a canvas element is required');
    }
    const live = conf.live || null;
    const onStats = typeof conf.onStats === 'function' ? conf.onStats : null;

    /* ---------- params ---------- */
    const C = {};
    (function initParams() {
      for (const k in PRESETS.MINE) C[k] = PRESETS.MINE[k];
      const src = conf.params;
      if (src && typeof src === 'object') {
        for (const k in src) {
          if (!Object.prototype.hasOwnProperty.call(PMAP, k)) continue;
          const v = Number(src[k]);
          if (!isFinite(v)) continue;
          C[k] = clamp(v, PMAP[k].min, PMAP[k].max);
        }
      }
    })();
    const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
    /** 0 = transparent additive overlay (default), 1 = the original opaque dark base */
    const backdrop = () => clamp(num(C.backdrop, 0), 0, 1);

    /* ---------- state ---------- */
    let S = null, S_MAIN = null;
    let DPR = 1, HAS_FILTER = false;
    let W = 0, H = 0, cx = 0, cy = 0, R = 0, RO = 0, RMAX = 0, thV = 0, thS = 0;
    let webBase = null, webLayers = [], trailC = null, glowC = null, laneC = null, farC = null, frameC = null;
    let bokehSpr = null, scanPatDark = null, scanPatLight = null, scanGrad = null, webDisc = null;
    let curves = [], runners = [], comets = [], pulses = [], hazes = [], flares = [], flyers = [], flyBands = [];
    let strandLayers = [], wedges = [], slots = [], shots = [], bokehs = [];
    let GR = {}, layerEnv = [0, 0, 0];
    let webRot = 0, ringRot = 0;
    const rot = { from: 0, to: 0, t: 1, dur: 1, hold: 0, ease: easeIO };
    const cam = { x: 0, y: 0, z: 1 };
    let shotI = 0, shotT = 0, camPhase = 'hold', camFrom = null;
    let beatT = 0.4, beatI = 0, sinceBeat = 9, beatN = 0, benv = 0, T = 0;
    /* round 2: level state machine (present / running / silent) + one-shot revolve */
    let env = 0, out = 0, present = true, sessRunning = false;
    let envFrom = 0, envTarget = 0, envT = 0;      // transition bookkeeping for the level machine
    let spinOffset = 0, spin = null;
    let switchT = -1, switchDur = 1.5;      // session-switch effect clock (s), -1 = idle
    let bld = 0, bldG = 1, coreG = 1;              // build-up gains: out → structure
    let tokPool = [], toolNames = [], pending = [], pendingT = 0;
    let act = 0, live01 = 0, mo = 0;
    let chkI = 0, chkT = 0;
    let ready = false, running = false, disposed = false, dirty = true, painted = false;
    let raf = 0, last = nowMs(), sizeCheck = 0;
    let frames = 0, fpsT = 0, fps = 60, statT = 0;
    let rebuildQ = {};

    const EPS_ACT = 0.004;

    /* ---------- live bridge (never writes to live) ---------- */
    function liveNumber(key) {
      if (!live) return 0;
      const v = Number(live[key]);
      return isFinite(v) ? v : 0;
    }
    /**
     * data capture level: 0 = pure animation (original sample data, no session read),
     * 1 = mixed (live tokens + the original synthetic numbers, the shipped look),
     * 2 = real only (every word and number comes from the session, blank otherwise).
     */
    function dataMode() {
      const m = Math.round(num(C.dataMode, 1));
      return m < 0 ? 0 : (m > 2 ? 2 : m);
    }
    function realOn() { return dataMode() === 2; }
    function pureOn() { return dataMode() === 0; }
    /** real words for the ring blocks: tokens first, then live tool names; null in real-only when empty */
    function pickWord(fallback) {
      if (pureOn()) return pick(fallback);          // level 0 never reads the session
      if (tokPool.length) {
        if (toolNames.length && rnd() < 0.25) return pick(toolNames);
        return pick(tokPool);
      }
      if (toolNames.length && rnd() < 0.4) return pick(toolNames);
      return realOn() ? null : pick(fallback);
    }
    /** one real metric rendered as text, or null when this session has none yet */
    function realNum() {
      if (!live) return null;
      const tps = liveNumber('tps');
      if (tps > 0.5) return tps < 100 ? tps.toFixed(1) : String(Math.round(tps));
      const tt = liveNumber('totalTokens');
      if (tt > 0) return String(tt | 0);
      const ctxTokens = liveNumber('contextTokens');
      if (ctxTokens > 0) return ctxTokens > 9999 ? (ctxTokens / 1000).toFixed(1) + 'k' : String(ctxTokens | 0);
      return null;
    }
    function fmtNum() {
      if (realOn()) { const r = realNum(); return r === null ? '--' : r; }
      if (!pureOn() && live && rnd() < 0.3) {
        const r = realNum();
        if (r !== null) return r;
      }
      const k = rnd();
      return k < 0.3 ? rr(0, 1).toFixed(3)
        : k < 0.55 ? (rr(1, 9).toFixed(1) + 'e-' + (2 + (rnd() * 5 | 0)))
          : k < 0.8 ? String((rnd() * 9999) | 0)
            : rr(0, 100).toFixed(1);
    }
    /** ordered real metrics for the kv block (empty when nothing is known yet) */
    function realKvRows() {
      const rows = [];
      if (!live) return rows;
      const tps = liveNumber('tps');
      if (tps > 0.05) rows.push(['tok/s', tps < 100 ? tps.toFixed(1) : String(Math.round(tps))]);
      const total = liveNumber('totalTokens');
      if (total > 0) rows.push(['tok', String(total | 0)]);
      const ctxTokens = liveNumber('contextTokens');
      if (ctxTokens > 0) rows.push(['ctx', ctxTokens > 9999 ? (ctxTokens / 1000).toFixed(1) + 'k' : String(ctxTokens | 0)]);
      const step = liveNumber('step');
      if (step > 0) rows.push(['step', String(step | 0)]);
      const turn = liveNumber('turn');
      if (turn > 0) rows.push(['turn', String(turn | 0)]);
      if (live.tools && live.tools.length) rows.push(['tools', String(live.tools.length)]);
      return rows;
    }
    /** real label for a panel header ('' when the session has no step/turn/model yet) */
    function realHeaderLabel() {
      if (!live) return '';
      const step = liveNumber('step');
      if (step > 0) return 'STEP ' + (step | 0);
      const turn = liveNumber('turn');
      if (turn > 0) return 'TURN ' + (turn | 0);
      const model = typeof live.model === 'string' ? live.model.trim() : '';
      return model ? model.slice(0, 18).toUpperCase() : '';
    }
    function refreshTools() {
      toolNames = [];
      if (!live || !live.tools || !live.tools.length) return;
      const t = live.tools;
      for (let i = Math.max(0, t.length - 6); i < t.length; i++) {
        const name = t[i] && t[i].name;
        if (name) toolNames.push(String(name).slice(0, 13));
      }
    }
    /** tokens are pulled only while the session is actually active */
    function pullLiveTokens() {
      if (pureOn()) return;                                   // level 0: nothing is read from the session
      if (live01 <= EPS_ACT || !live || typeof live.pullTokens !== 'function') return;
      let got = null;
      try { got = live.pullTokens(Math.max(1, Math.round((0.6 + clamp(C.dataFlicker, 0, 4)) * (0.4 + live01 * 1.6)))); } catch (e) { got = null; }
      if (!got || !got.length) return;
      for (let i = 0; i < got.length; i++) {
        const w = String(got[i] == null ? '' : got[i]).replace(/\s+/g, ' ').trim().slice(0, 14);
        if (w) tokPool.push(w);
      }
      while (tokPool.length > 48) tokPool.shift();
    }

    /* ---------- canvas / buffers ---------- */
    function mkd(w, h, d) {
      const c = newCanvas(w * d, h * d);
      if (!c) return null;
      c.width = Math.max(1, Math.ceil(w * d)); c.height = Math.max(1, Math.ceil(h * d));
      c.x = c.getContext('2d');
      if (c.x) c.x.setTransform(d, 0, 0, d, 0, 0);
      return c;
    }
    function measure() {
      let w = 0, h = 0;
      try {
        if (typeof canvas.getBoundingClientRect === 'function') {
          const r = canvas.getBoundingClientRect();
          if (r && r.width) { w = r.width; h = r.height; }
        }
      } catch (e) { /* ignore */ }
      if (!w || !h) { w = canvas.clientWidth || 0; h = canvas.clientHeight || 0; }
      if (!w || !h) {
        const d = DPR || 1;
        w = (canvas.width || 0) / d; h = (canvas.height || 0) / d;
      }
      return { w: Math.max(0, w), h: Math.max(0, h) };
    }

    /* ---------- setup ---------- */
    function doRebuild(m) {
      if (disposed) return;
      DPR = clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, 2);
      W = m.w; H = m.h;
      canvas.width = Math.max(1, Math.round(W * DPR));
      canvas.height = Math.max(1, Math.round(H * DPR));
      S = canvas.getContext('2d');
      if (!S) { ready = false; return; }
      S.setTransform(DPR, 0, 0, DPR, 0, 0);
      S_MAIN = S;
      HAS_FILTER = 'filter' in S;

      // composition centre: original W*0.07 / H*0.5, now offset by centerX/centerY (-1..1 = half screen)
      const sc = clamp(num(C.scale, 1), 0.05, 4);
      cx = W * (0.07 + clamp(num(C.centerX, 0), -2, 2) * 0.5);
      cy = H * (0.5 + clamp(num(C.centerY, 0), -2, 2) * 0.5);
      R = Math.max(H * 0.78, W * 0.30) * sc;
      RO = R + Math.max(90, Math.min(240, H * 0.3, W * 0.13)) * clamp(num(C.ringWidth, 1), 0.05, 3) * sc;
      RMAX = (Math.max(
        Math.hypot(W - cx, H - cy), Math.hypot(W - cx, cy),
        Math.hypot(cx, H - cy), Math.hypot(cx, cy),
      ) + 60) * sc;
      const dv = Math.min(cy, H - cy) + 60, ds = Math.min(cy, H - cy) + 40;
      thV = Math.asin(Math.min(1, dv / Math.max(1, R)));
      thS = Math.asin(Math.min(1, ds / Math.max(1, RO)));
      // local-space disc reused by backdrop mode (gradient coords are in the web's own space)
      webDisc = null;
      try {
        const wg = S.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
        wg.addColorStop(0, '#111215'); wg.addColorStop(1, '#0c0d0f');
        webDisc = wg;
      } catch (e) { webDisc = null; }

      release(webBase);
      if (webLayers.length) webLayers.forEach(release);
      webBase = null; webLayers = [];
      release(trailC); trailC = null;
      release(glowC); glowC = null;
      release(laneC); laneC = null;
      release(farC); farC = null;

      if (!buildWeb()) { ready = false; return; }   // no offscreen canvas → nothing to draw on
      buildLanes();
      buildCards();
      buildOuter();
      trailC = mkd(2 * R + 4, 2 * R + 4, Math.min(DPR, 1.5));
      farC = newCanvas(W * FS, H * FS);
      if (farC) {
        farC.width = Math.max(1, Math.ceil(W * FS)); farC.height = Math.max(1, Math.ceil(H * FS));
        farC.x = farC.getContext('2d');
      }
      glowC = newCanvas(W / GS, H / GS);
      if (glowC) {
        glowC.width = Math.max(1, Math.ceil(W / GS)); glowC.height = Math.max(1, Math.ceil(H / GS));
        glowC.x = glowC.getContext('2d');
      }
      // full-res compositing buffer: the whole scene is drawn here, then faded onto the
      // visible canvas with globalAlpha = out (see drawStage) — this is the fade mechanism
      release(frameC);
      frameC = newCanvas(canvas.width, canvas.height);
      if (frameC) {
        frameC.width = Math.max(1, canvas.width | 0); frameC.height = Math.max(1, canvas.height | 0);
        frameC.x = frameC.getContext('2d');
      }
      buildScanOverlay();
      syncBokeh();

      runners = [];
      for (let i = 0; i < Math.round(clamp(num(C.runnerCount, 0), 0, 900)); i++) runners.push(newRunner(true));
      comets = []; pulses = []; pending = []; pendingT = 0;
      buildShots();

      rebuildQ = {};
      ready = true;
      dirty = true;
    }
    function applySize(force) {
      if (disposed) return false;
      const m = measure();
      if (m.w < 20 || m.h < 20) { ready = false; return false; }
      if (!force && ready && Math.abs(m.w - W) < 0.5 && Math.abs(m.h - H) < 0.5) return true;
      doRebuild(m);
      return ready;
    }
    /** cheap periodic container check: the host may resize without calling resize() */
    function tickSize() {
      if (++sizeCheck < 15) return;
      sizeCheck = 0;
      if (!ready) applySize(true);
      else {
        const m = measure();
        if (m.w >= 20 && m.h >= 20 && (Math.abs(m.w - W) >= 0.5 || Math.abs(m.h - H) >= 0.5)) doRebuild(m);
      }
    }
    function applyRebuilds() {
      if (!ready || disposed) return;
      if (rebuildQ.resize) { doRebuild(measure()); return; }
      if (rebuildQ.web) { rebuildQ.web = 0; buildWeb(); }
      if (rebuildQ.slots) { rebuildQ.slots = 0; for (const s of slots) { release(s.c); s.c = null; } }
      if (rebuildQ.flyers) { rebuildQ.flyers = 0; initFlyers(); }
      rebuildQ = {};
    }

    /* ---------- inner web ---------- */
    function buildWeb() {
      const size = 2 * R + 4, d = Math.min(DPR, 1.5);
      webBase = mkd(size, size, d);
      webLayers = [0, 1, 2].map(() => mkd(size, size, d));
      if (!webBase || webLayers.some(c => !c)) { webLayers = webLayers.filter(Boolean); return false; }
      const all = [webBase, ...webLayers];
      all.forEach(c => c.x.translate(R + 2, R + 2));
      const b = webBase.x;
      // NOTE: lab.html filled an opaque dark disc (#111215) here. In overlay mode the
      // web base stays transparent and drawStage() paints that disc only when backdrop > 0.
      all.forEach(c => { c.x.save(); c.x.beginPath(); c.x.arc(0, 0, R, 0, TAU); c.x.clip(); });
      curves = [];
      const N = Math.min(2600, Math.round(1000 + (W * H) / 800));
      for (let i = 0; i < N; i++) {
        const a1 = rnd() * TAU, a2 = a1 + rr(0.6, Math.PI * 1.4);
        const p0 = { x: Math.cos(a1) * R, y: Math.sin(a1) * R };
        const p1 = { x: Math.cos(a2) * R, y: Math.sin(a2) * R };
        const cr = Math.sqrt(rnd()) * R * 0.9, ca = rnd() * TAU;
        const c = { x: Math.cos(ca) * cr, y: Math.sin(ca) * cr };
        curves.push({ p0, c, p1 });
        const layer = rnd() < 0.7 ? -1 : (rnd() * 3) | 0;
        const x = layer < 0 ? b : webLayers[layer].x;
        const al = Math.min(1, (layer < 0 ? 0.03 + Math.pow(rnd(), 3) * 0.28 : 0.08 + Math.pow(rnd(), 2) * 0.35) * C.webBright);
        const k = rnd();
        x.strokeStyle = k < 0.05 ? `rgba(240,166,198,${al})` : k < 0.1 ? `rgba(180,170,235,${al})` : `rgba(228,231,238,${al})`;
        x.lineWidth = rr(0.4, 1.1);
        x.beginPath(); x.moveTo(p0.x, p0.y); x.quadraticCurveTo(c.x, c.y, p1.x, p1.y); x.stroke();
      }
      // node markers
      b.font = `6px ${FONT}`; b.textBaseline = 'middle';
      for (let i = 0; i < 70; i++) {
        const rr_ = Math.sqrt(rnd()) * R * 0.92, a = rnd() * TAU;
        const px = Math.cos(a) * rr_, py = Math.sin(a) * rr_, s = rr(2, 4.5);
        b.strokeStyle = `rgba(235,238,244,${rr(0.35, 0.8)})`; b.lineWidth = 0.8;
        b.beginPath(); b.arc(px, py, s, 0, TAU); b.stroke();
        if (rnd() < 0.4) { b.beginPath(); b.arc(px + s * 2.2, py, s * 0.8, 0, TAU); b.stroke(); }
        if (!realOn() && rnd() < 0.35) { b.fillStyle = 'rgba(200,204,212,.5)'; b.fillText('n' + ((rnd() * 99) | 0), px + 7, py); }
      }
      // dotted chains of small rings
      for (let k = 0; k < 3; k++) {
        const rad = R * rr(0.45, 0.85), a0 = rr(0, TAU), cnt = 22 + (rnd() * 14 | 0);
        b.strokeStyle = 'rgba(235,238,244,.55)'; b.lineWidth = 0.8;
        for (let i = 0; i < cnt; i++) { const a = a0 + i * 0.022; b.beginPath(); b.arc(Math.cos(a) * rad, Math.sin(a) * rad, 2.2, 0, TAU); b.stroke(); }
      }
      all.forEach(c => c.x.restore());
      if (HAS_FILTER && C.webBlur > 0) {
        all.forEach((c, i) => {
          const orig = newCanvas(c.width, c.height);
          if (!orig) return;
          orig.width = c.width; orig.height = c.height;
          const ox = orig.getContext('2d');
          if (!ox) return;
          ox.drawImage(c, 0, 0);
          const x = c.x; x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height);
          x.filter = `blur(${(i ? 0.5 : 1) * C.webBlur * d}px)`; x.drawImage(orig, 0, 0); x.filter = 'none';
          x.globalAlpha = Math.max(0.15, 1 - C.webBlur * 0.3); x.drawImage(orig, 0, 0); x.restore();
          release(orig);
        });
      }
      return curves.length > 0;
    }
    const qpt = (cv, t) => {
      const u = 1 - t;
      return { x: u * u * cv.p0.x + 2 * u * t * cv.c.x + t * t * cv.p1.x, y: u * u * cv.p0.y + 2 * u * t * cv.c.y + t * t * cv.p1.y };
    };
    function newRunner(init) {
      if (!curves.length) return { cv: null, t: 1, sp: 0, mode: 0, px: 0, py: 0, b: false };
      const cv = pick(curves), t = init ? rnd() : 0, p = qpt(cv, t);
      const k = rnd(); let mode, sp;
      if (rnd() > C.runnerVariety) { mode = 1; sp = rr(0.12, 0.38); }
      else if (k < 0.3) { mode = 0; sp = rr(0.15, 0.28); }
      else if (k < 0.65) { mode = 1; sp = rr(0.1, 0.3); }
      else if (k < 0.8) { mode = 0; sp = rr(0.04, 0.08); }
      else if (k < 0.92) { mode = 0; sp = rr(0.5, 0.85); }
      else { mode = 2; sp = rr(0.06, 0.12); }
      return { cv, t, sp, mode, px: p.x, py: p.y, b: rnd() < 0.1 };
    }

    /* ---------- comets: short bright bundles sweeping with ease-in-out ---------- */
    function spawnComet() {
      const lines = [], n = Math.max(2, Math.round((8 + (rnd() * 12 | 0)) * C.cometLines));
      if (rnd() < 0.6) {
        const rad = R * rr(0.55, 0.9), a0 = rr(-thV, thV) * 0.85, span = rr(0.35, 0.9) * (rnd() < 0.5 ? -1 : 1), gap = rr(2.6, 4.4) * C.cometWidth;
        for (let k = 0; k < n; k++) lines.push({ arc: true, r: rad - k * gap + gauss() * 0.6, a0: a0 + gauss() * 0.01, span });
      } else {
        const ang = rr(-thV, thV) * 0.8, oa = ang + rr(-1.3, 1.3), orad = R * rr(0.25, 0.75);
        const o = { x: Math.cos(oa) * orad, y: Math.sin(oa) * orad };
        const spread = rr(0.08, 0.25) * C.cometWidth, bend = rr(0.2, 0.5) * (rnd() < 0.5 ? -1 : 1);
        for (let i = 0; i < n; i++) {
          const ta = ang + (i / n - 0.5) * spread;
          const p1 = { x: Math.cos(ta) * (R - 2), y: Math.sin(ta) * (R - 2) };
          const p0 = { x: o.x + gauss() * 10, y: o.y + gauss() * 10 };
          const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2, dx = p1.x - p0.x, dy = p1.y - p0.y;
          lines.push({ p0, c: { x: mx - dy * bend + gauss() * 8, y: my + dx * bend + gauss() * 8 }, p1 });
        }
      }
      comets.push({ lines, life: 0, hit: false, rot0: ringRot, dur: rr(0.4, 0.85) / C.cometSpeed, win: rr(0.22, 0.4), glow: rnd() < 0.4, tint: rnd() < 0.15 });
    }
    const cpt = (l, t) => {
      if (!l.arc) return qpt(l, t);
      const r = l.r + (R - 2 - l.r) * t * t, a = l.a0 + l.span * t;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    };
    function strokeComet(ctx, c, t0, t1, steps) {
      ctx.beginPath();
      for (const l of c.lines) for (let s = 0; s <= steps; s++) {
        const p = cpt(l, t0 + (t1 - t0) * (s / steps));
        if (s) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    }

    /* ---------- outer: stacked, constantly changing layers ---------- */
    function makeProfile(n) {
      const prof = []; let v = rr(0.45, 1), run = 0;
      for (let k = 0; k < n; k++) {
        if (run-- <= 0) { v = clamp(v + gauss() * 0.4, 0.22, 1); run = 2 + (rnd() * 5 | 0); }
        prof.push(clamp(v + gauss() * 0.07, 0.18, 1));
      }
      return prof;
    }
    function makeStrandLayer(stepDeg, rotK, lumK, lw, lenK, solidK, cover, nMin, nMax, brightP, dyn = 'soft') {
      const step = stepDeg * Math.PI / 180, nb = Math.floor(TAU / step), ws = [];
      const count = Math.round(nb * cover / ((nMin + nMax) / 2));
      for (let j = 0; j < count; j++) {
        const n = nMin + (rnd() * (nMax - nMin) | 0), bright = rnd() < brightP;
        ws.push({
          i0: (rnd() * nb) | 0, n, base: rr(0.35, 1), len: rr(0.1, 0.5), kick: 0,
          ph: rnd() * TAU, ph2: rnd() * TAU, f1: rr(0.22, 0.6), f2: rr(0.8, 1.7),
          lum: bright ? rr(0.75, 1) : rr(0.16, 0.55), tint: rnd() < 0.5 ? 1 : 0,
          lwK: rnd() < 0.2 ? rr(1.35, 2.1) : rr(0.6, 1.15), lenS: rr(0.6, 1.25),
          prof: makeProfile(n), pf: Array.from({ length: n }, () => rr(1, 4)), pp: Array.from({ length: n }, () => rnd() * TAU),
          ds: Array.from({ length: n }, () => rnd()), dsp: rr(0.7, 1.8), flow: 0,
        });
      }
      return { step, rotK, lumK, lw, lenK, solidK, wedges: ws, off: rnd() * TAU, dyn };
    }
    function buildOuter() {
      strandLayers = [
        makeStrandLayer(0.22, 0.45, 0.30, 0.55, 1.15, 0.9, 1.1, 20, 90, 0.2),   // far
        makeStrandLayer(0.16, 0.75, 0.58, 0.8, 1.05, 0.7, 0.9, 14, 70, 0.28),   // mid
        makeStrandLayer(0.12, 1.0, 1.0, 1.0, 1.0, 0.5, 0.75, 12, 60, 0.32),     // main
        makeStrandLayer(0.45, 1.0, 0.5, 1.8, 0.8, 0.6, 0.35, 4, 16, 0.3),       // near
        makeStrandLayer(0.12, 1.0, 0.85, 1.0, 1.0, 0.5, 0.55, 14, 70, 0.32, 'bounce'), // wave / rebound
      ];
      // parallax: each outer layer follows the one-shot revolve by its own factor
      [0.35, 0.6, 1.0, 1.15, 0.5].forEach((k, i) => { if (strandLayers[i]) strandLayers[i].revK = k; });
      wedges = strandLayers[2].wedges.concat(strandLayers[4].wedges);
      hazes = []; flares = [];
      GR = {};
      const mkG = (stops, r1) => {
        const g = S.createRadialGradient(cx, cy, RO, cx, cy, r1);
        stops.forEach(s => g.addColorStop(s[0], s[1]));
        return g;
      };
      GR.s0 = mkG([[0, 'rgba(248,248,255,1)'], [0.35, 'rgba(228,226,242,.8)'], [1, 'rgba(190,190,214,.3)']], RMAX * 0.95);
      GR.s2 = mkG([[0, 'rgba(225,245,242,1)'], [0.3, 'rgba(176,214,210,.8)'], [1, 'rgba(140,180,186,.3)']], RMAX * 0.95);
      GR.s1 = mkG([[0, 'rgba(240,236,255,1)'], [0.3, 'rgba(196,182,244,.82)'], [1, 'rgba(160,140,228,.3)']], RMAX * 0.95);
      GR.h0 = mkG([[0, 'rgba(205,190,255,.95)'], [0.25, 'rgba(180,165,240,.7)'], [0.7, 'rgba(150,135,215,.25)'], [1, 'rgba(120,110,190,0)']], RMAX);
      GR.h1 = mkG([[0, 'rgba(250,250,255,1)'], [0.2, 'rgba(225,225,240,.65)'], [0.65, 'rgba(200,200,225,.2)'], [1, 'rgba(180,180,210,0)']], RMAX);
      GR.h2 = mkG([[0, 'rgba(200,230,228,.9)'], [0.25, 'rgba(170,205,210,.6)'], [0.7, 'rgba(140,170,185,.2)'], [1, 'rgba(120,150,170,0)']], RMAX);
      for (let i = 0; i < 14; i++) spawnHaze(true);
      initFlyers();
    }
    function spawnHaze(init) {
      const k = rnd();
      hazes.push({
        a: rr(-thS, thS) - ringRot, w: rnd() < 0.7 ? rr(0.015, 0.07) : rr(0.08, 0.18),
        len: rr(0.35, 1), cur: init ? rr(0.2, 0.8) : 0, age: init ? rr(0, 0.5) : 0,
        life: rr(0.35, 1.6), alpha: rr(0.12, 0.42), tint: k < 0.55 ? 0 : k < 0.85 ? 1 : 2, drift: rr(-0.04, 0.04),
      });
    }
    function spawnFlare(a) {
      flares.push({ a: a == null ? rr(-thS, thS) * 0.95 - ringRot : a, w: rr(0.006, 0.04), len: rr(18, 110), age: 0, life: rr(0.2, 0.55), alpha: rr(0.6, 1) });
    }
    function buildLanes() {
      laneC = mkd(W, H, DPR);
      if (!laneC) return;
      const x = laneC.x;
      for (let i = 0; i < 700; i++) {
        const a = rr(-thS, thS);
        x.strokeStyle = `rgba(210,205,235,${rr(0.01, 0.035)})`; x.lineWidth = rr(0.5, 1);
        const r0 = RO + 4, r1 = rr(RO + 60, RMAX * 0.8);
        x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); x.stroke();
      }
    }
    function onBeatOuter() {
      onBeatFlyers();
      for (let i = 0; i < 2 + (rnd() * 5 | 0); i++) { const w = pick(wedges); w.kick = rr(0.4, 1); if (rnd() < 0.5) w.prof = makeProfile(w.n); }
      for (let i = 0; i < 2; i++) { const w = pick(wedges); w.lum = rnd() < 0.4 ? rr(0.8, 1) : rr(0.25, 0.6); }
      const nh = beatN % 4 === 0 ? 5 + (rnd() * 4 | 0) : 1 + (rnd() * 3 | 0);
      for (let i = 0; i < Math.round(nh * C.hazeCount / 8); i++) spawnHaze(false);
      const nf = Math.round((1 + (rnd() * 4 | 0)) * C.flareRate);
      for (let i = 0; i < nf; i++) spawnFlare(hazes.length && rnd() < 0.6 ? pick(hazes).a : null);
    }
    function hazeEnv(h) {
      const a = Math.min(1, h.age / 0.12);
      const o = h.age > h.life ? Math.max(0, 1 - (h.age - h.life) / 0.6) : 1;
      return a * o * (0.85 + 0.15 * Math.sin(h.age * 30));
    }
    function drawStrands(Lr, collect) {
      const span = RMAX - RO - 20, r0 = RO + 3, rotA = strandRot(Lr);
      S.lineCap = 'butt';
      for (const w of Lr.wedges) {
        if (!w.vis) continue;
        const L = w.len * span * Lr.lenK * C.beamLen;
        if (L < 3) continue;
        const a0 = normA(w.i0 * Lr.step + rotA), a1 = a0 + w.n * Lr.step;
        if (a1 < -thS - 0.03 || a0 > thS + 0.03) continue;
        const alpha = Math.min(1, w.lum * Lr.lumK * (0.3 + 0.7 * Math.min(1, w.len * 1.8)) * C.beamBright * (Lr.dyn === 'bounce' ? C.beamBounce : 1)) * bldG;
        if (alpha < 0.005) continue;
        const lwW = Lr.lw * w.lwK * C.beamWidth;
        const paths = [new Path2D(), new Path2D(), new Path2D()];
        for (let k = 0; k < w.n; k++) {
          const a = a0 + (k + 0.5) * Lr.step, ca = Math.cos(a), sa = Math.sin(a);
          const edge = Math.sin(Math.PI * (k + 0.5) / w.n), b = edge < 0.38 ? 0 : edge < 0.72 ? 1 : 2;
          const pr = w.prof[k];
          const l = L * pr * (0.5 + 0.5 * Math.sqrt(edge)) * (0.92 + 0.08 * Math.sin(T * w.pf[k] + w.pp[k]));
          const solid = l * (Lr.solidK + 0.3 * pr * (1 - Lr.solidK));
          paths[b].moveTo(cx + ca * r0, cy + sa * r0); paths[b].lineTo(cx + ca * (r0 + solid), cy + sa * (r0 + solid));
          if (!collect) continue;
          const tail = l - solid, da = alpha * EDGE_A[b];
          if (tail > 6) for (let d = 0; d < 2; d++) {
            const ph = (w.flow + w.ds[k] + d * 0.5) % 1;
            const s0 = solid + tail * ph, s1 = Math.min(l, s0 + 3 + tail * 0.22 * (1 - ph * 0.5));
            if (s1 > s0) collect.dash.push(ca, sa, s0, s1, da);
          }
          if ((k + (T * 12 | 0)) % 4 === 0) collect.tip.push(ca, sa, l, da);
        }
        S.strokeStyle = GR['s' + w.tint]; S.lineWidth = lwW;
        for (let b = 0; b < 3; b++) { S.globalAlpha = alpha * EDGE_A[b]; S.stroke(paths[b]); }
        if (w.lum > 0.85 && C.beamGlow > 0) { S.globalAlpha = Math.min(1, alpha * 0.06 * C.beamGlow); S.lineWidth = lwW * 2.5; S.stroke(paths[2]); }
      }
    }
    function radialLines(a0, a1, st, r0, L, seed, lo) {
      S.beginPath();
      let k = 0;
      for (let a = a0; a < a1; a += st, k++) {
        const l = L * (lo + (1 - lo) * hash(k + seed)), ca = Math.cos(a), sa = Math.sin(a);
        S.moveTo(cx + ca * r0, cy + sa * r0); S.lineTo(cx + ca * (r0 + l), cy + sa * (r0 + l));
      }
    }
    function newFlyBand() { return { a: rr(-thS, thS), w: rr(0.01, 0.05), life: rr(2, 6) }; }
    function newFlyer(init) {
      let a;
      if (rnd() < 0.5) { const b = pick(flyBands); a = b.a + gauss() * b.w; } else a = rr(-thS, thS);
      return {
        a: a - ringRot, len: 20 + Math.pow(rnd(), 2) * 320, r: init ? rr(RO, RMAX) : RO + rr(0, 25),
        sp: rr(260, 900), lw: rnd() < 0.08 ? rr(1.2, 1.7) : rr(0.5, 1), lv: rnd() < 0.12 ? 1 : 0, tint: rnd() < 0.22 ? 1 : 0, burst: false,
      };
    }
    function spawnFlyBurst() {
      const a = rr(-thS, thS) * 0.95, n = Math.max(1, Math.round((14 + (rnd() * 30 | 0)) * C.burstSize)), spread = rr(0.01, 0.045);
      const sp = rr(450, 1150), len = rr(70, 320), r0 = RO + rr(0, 8), tint = rnd() < 0.3 ? 1 : 0, lv = rnd() < 0.45 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        flyers.push({
          a: a + (i / n - 0.5) * spread + gauss() * 0.0015 - ringRot, len: len * rr(0.7, 1.15), r: r0 - rr(0, len * 0.35),
          sp: sp * rr(0.92, 1.08), lw: rnd() < 0.2 ? 1.3 : rr(0.6, 1), lv, tint, burst: true,
        });
      }
    }
    function initFlyers() {
      flyBands = Array.from({ length: 7 }, newFlyBand);
      const n = Math.round(Math.min(750, 320 + W * 0.25) * clamp(num(C.flyerCount, 1), 0, 3));
      flyers = Array.from({ length: n }, () => newFlyer(true));
    }
    function drawFlyers(bursts) {
      const buckets = {};
      for (const f of flyers) {
        if (f.burst !== bursts) continue;
        const a = normA(f.a + ringRot + revOut() * 0.85);
        if (a < -thS - 0.05 || a > thS + 0.05) continue;
        const key = f.tint * 10 + f.lv + (f.lw > 1.15 ? 100 : 0) + (f.burst ? 1000 : 0);
        (buckets[key] || (buckets[key] = [])).push(f, a);
      }
      for (const key in buckets) {
        const arr = buckets[key], f0 = arr[0];
        S.strokeStyle = f0.tint ? GR.s1 : GR.s0;
        S.globalAlpha = Math.min(1, FLY_A[f0.lv] * (f0.burst ? C.burstBright : C.flyerBright) * bldG);
        S.lineWidth = ((key % 1000) >= 100 ? 1.5 : 0.8) * C.flyerWidth;
        S.beginPath();
        for (let i = 0; i < arr.length; i += 2) {
          const f = arr[i], a = arr[i + 1], r0 = Math.max(RO + 3, f.r - f.len), r1 = f.r;
          if (r1 <= r0) continue;
          const ca = Math.cos(a), sa = Math.sin(a);
          S.moveTo(cx + ca * r0, cy + sa * r0); S.lineTo(cx + ca * r1, cy + sa * r1);
        }
        S.stroke();
      }
      S.globalAlpha = 1;
    }
    function drawOuterFar() {
      const span = RMAX - RO - 20, r0 = RO + 3;
      for (const h of hazes) {
        const e = hazeEnv(h); if (e <= 0.01) continue;
        if (h.seed === undefined) h.seed = rnd() * 1000;
        const L = h.cur * span;
        const ha = h.a + ringRot + revOut() * 0.4;
        radialLines(ha - h.w / 2, ha + h.w / 2, NSTEP * 0.55, r0, L, h.seed, 0.45);
        S.strokeStyle = GR['s' + (h.tint === 1 ? 0 : h.tint === 2 ? 2 : 1)];
        S.globalAlpha = Math.min(1, h.alpha * e * 0.05 * C.hazeBright * bldG); S.lineWidth = 2.2; S.stroke();
        S.globalAlpha = Math.min(1, h.alpha * e * 0.6 * C.hazeBright * bldG); S.lineWidth = 0.55; S.stroke();
      }
      drawStrands(strandLayers[0], null);
      drawStrands(strandLayers[1], null);
      drawFlyers(false);
      S.globalAlpha = 1;
    }
    function drawOuterNear() {
      const r0 = RO + 3;
      const col = { dash: [], tip: [] };
      drawStrands(strandLayers[2], col);
      drawStrands(strandLayers[4], col);
      drawStrands(strandLayers[3], null);
      S.strokeStyle = '#fff'; S.lineWidth = 1.05;
      for (const lv of [0.35, 0.65, 1]) {
        S.globalAlpha = Math.min(1, lv * C.dashBright * bldG); S.beginPath();
        const dp = col.dash;
        for (let i = 0; i < dp.length; i += 5) {
          const a = dp[i + 4]; if (a > lv || a <= lv - 0.35) continue;
          S.moveTo(cx + dp[i] * (r0 + dp[i + 2]), cy + dp[i + 1] * (r0 + dp[i + 2]));
          S.lineTo(cx + dp[i] * (r0 + dp[i + 3]), cy + dp[i + 1] * (r0 + dp[i + 3]));
        }
        S.stroke();
      }
      S.fillStyle = '#fff';
      for (let i = 0; i < col.tip.length; i += 4) {
        S.globalAlpha = Math.min(1, col.tip[i + 3] * 1.2 * bldG);
        const r = r0 + col.tip[i + 2];
        S.fillRect(cx + col.tip[i] * r - 0.8, cy + col.tip[i + 1] * r - 0.8, 1.6, 1.6);
      }
      drawFlyers(true);
      S.strokeStyle = GR.s0;
      for (const f of flares) {
        if (f.seed === undefined) f.seed = rnd() * 1000;
        const t = f.age / f.life, e = (t < 0.15 ? t / 0.15 : Math.pow(1 - (t - 0.15) / 0.85, 2)) * f.alpha;
        const L = f.len * (0.6 + 0.4 * easeO(Math.min(1, t * 3)));
        radialLines(f.a + ringRot - f.w / 2, f.a + ringRot + f.w / 2, NSTEP * 0.45, r0, L, f.seed, 0.4);
        S.globalAlpha = Math.min(1, e * 0.06 * C.flareBright * bldG); S.lineWidth = 2.6; S.stroke();
        S.globalAlpha = Math.min(1, e * C.flareBright * bldG); S.lineWidth = 0.8; S.stroke();
      }
      S.globalAlpha = 1;
    }

    /* ---------- foreground bokeh ---------- */
    function mkBokehSprite() {
      const c = newCanvas(128, 128);
      if (!c) return null;
      c.width = c.height = 128;
      const x = c.getContext('2d');
      if (!x) return null;
      const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(0.5, 'rgba(235,232,255,.5)'); g.addColorStop(0.82, 'rgba(220,215,255,.22)');
      g.addColorStop(0.93, 'rgba(225,220,255,.32)'); g.addColorStop(1, 'rgba(220,215,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      return c;
    }
    function newBokeh() {
      const big = rnd() < 0.3;
      return {
        x: rr(-0.1, 1.1) * W, y: rr(-0.1, 1.1) * H, r: big ? rr(24, 64) : rr(5, 22), a: big ? rr(0.025, 0.07) : rr(0.05, 0.16),
        vx: rr(-10, 10), vy: rr(-6, 6), st: rnd() < 0.3 ? rr(2, 5) : 1, ph: rnd() * TAU,
      };
    }
    function syncBokeh() {
      bokehs = [];
      const n = Math.max(0, Math.round(clamp(num(C.bokeh, 0), 0, 80)));
      for (let i = 0; i < n; i++) bokehs.push(newBokeh());
    }
    function drawBokeh(dtM, actOn) {
      const n = Math.round(clamp(num(C.bokeh, 0), 0, 80));
      // no new bokeh while the session is idle; shrinking always applies
      while (actOn && bokehs.length < n) bokehs.push(newBokeh());
      if (bokehs.length > n) bokehs.length = n;
      if (!n || !bokehs.length) return;
      if (!bokehSpr) bokehSpr = mkBokehSprite();
      if (!bokehSpr) return;
      const k = 1 + 0.6 * C.parallax, z = 1 + (cam.z - 1) * k, ox = (cam.x - W / 2) * k, oy = (cam.y - H / 2) * k;
      S.setTransform(DPR, 0, 0, DPR, 0, 0); S.globalCompositeOperation = 'lighter';
      for (const b of bokehs) {
        b.x += b.vx * dtM; b.y += b.vy * dtM;
        if (b.x < -0.15 * W) b.x += 1.3 * W;
        if (b.x > 1.15 * W) b.x -= 1.3 * W;
        if (b.y < -0.15 * H) b.y += 1.3 * H;
        if (b.y > 1.15 * H) b.y -= 1.3 * H;
        const sx = (b.x - W / 2 - ox) * z + W / 2, sy = (b.y - H / 2 - oy) * z + H / 2, r = b.r * z;
        S.globalAlpha = Math.min(1, b.a * C.bokehBright * (0.75 + 0.25 * Math.sin(T * 0.8 + b.ph)) * (1 + benv * 0.3));
        S.drawImage(bokehSpr, sx - r * b.st, sy - r, 2 * r * b.st, 2 * r);
      }
      S.globalAlpha = 1; S.globalCompositeOperation = 'source-over';
    }

    /* ---------- ring: pre-rendered dot-matrix data blocks on a black band ---------- */
    function rimW() { return Math.max(3, (RO - R) * 0.065 * C.rimWidth); }
    function header(c, x0, x1, y, t) {
      c.font = `700 4.3px ${FONT}`;
      if (realOn()) {
        const w = realHeaderLabel();
        if (w) { c.fillStyle = rgba(t, 0.95); c.fillText(w, x0, y); }
        const n = liveNumber('step') || liveNumber('turn');
        if (n > 0) { c.fillStyle = rgba(t, 0.55); c.fillText(String(n | 0).padStart(2, '0'), x1 - 6, y); }
      } else {
        c.fillStyle = rgba(t, 0.95); c.fillText(pickWord(HEAD), x0, y);
        c.fillStyle = rgba(t, 0.55); c.fillText(String((rnd() * 99) | 0).padStart(2, '0'), x1 - 6, y);
      }
      c.fillStyle = rgba(t, 0.3); c.fillRect(x0, y + 5.6, x1 - x0, 0.45);
      return y + 7.5;
    }
    const BLOCKS = {
      code(c, x0, x1, y0, y1, t) {
        let y = header(c, x0, x1, y0, t);
        if (realOn() && !tokPool.length && !toolNames.length) return;   // nothing real to show yet
        c.font = `500 3.5px ${FONT}`;
        let n = 1 + (rnd() * 40 | 0);
        while (y < y1 - 3.5) {
          c.fillStyle = rgba(t, 0.3); c.fillText(String(n++).padStart(3, '0'), x0, y);
          let xx = x0 + 9;
          const words = 1 + (rnd() * 4 | 0);
          for (let i = 0; i < words && xx < x1 - 4; i++) {
            const w = pickWord(CODE_T);
            if (!w) break;                    // real-only and the token pool ran dry: leave the rest blank
            c.fillStyle = rgba(t, rnd() < 0.25 ? 1 : rr(0.5, 0.8)); c.fillText(w, xx, y); xx += w.length * 2.15 + 2;
          }
          y += 4.6;
        }
      },
      kv(c, x0, x1, y0, y1, t) {
        let y = y1 - y0 > 18 ? header(c, x0, x1, y0, t) : y0 + 1;
        c.font = `500 3.6px ${FONT}`;
        if (realOn()) {
          // real metrics only; a session with no numbers yet leaves the panel blank
          const rows = realKvRows();
          for (let i = 0; i < rows.length && y < y1 - 4; i++) {
            const key = rows[i][0], v = rows[i][1];
            c.fillStyle = rgba(t, 0.5); c.fillText(key, x0, y);
            c.fillStyle = rgba(t, 0.95); c.textAlign = 'right'; c.fillText(v, x1, y); c.textAlign = 'left';
            const bx = x0 + 14, bw = Math.max(0, x1 - x0 - 14 - v.length * 2.2 - 4);
            c.fillStyle = rgba(t, 0.15); c.fillRect(bx, y + 1.2, bw, 1.2);
            c.fillStyle = rgba(t, 0.7); c.fillRect(bx, y + 1.2, bw * 0.7, 1.2);
            y += 5.2;
          }
          return;
        }
        while (y < y1 - 4) {
          c.fillStyle = rgba(t, 0.5); c.fillText(pick(KEYS), x0, y);
          const v = fmtNum(); c.fillStyle = rgba(t, 0.95); c.textAlign = 'right'; c.fillText(v, x1, y); c.textAlign = 'left';
          const bx = x0 + 14, bw = Math.max(0, x1 - x0 - 14 - v.length * 2.2 - 4);
          c.fillStyle = rgba(t, 0.15); c.fillRect(bx, y + 1.2, bw, 1.2);
          c.fillStyle = rgba(t, 0.7); c.fillRect(bx, y + 1.2, bw * rnd(), 1.2);
          y += 5.2;
        }
      },
      spark(c, x0, x1, y0, y1, t) {
        const y = header(c, x0, x1, y0, t), top = y + 1, bot = y1 - 2, n = 40;
        c.fillStyle = rgba(t, 0.18); c.fillRect(x0, bot, x1 - x0, 0.4); c.fillRect(x0, (top + bot) / 2, x1 - x0, 0.25);
        c.strokeStyle = rgba(t, 0.95); c.lineWidth = 0.55; c.beginPath();
        let v = rnd(), lx = 0, ly = 0;
        for (let i = 0; i <= n; i++) {
          v = clamp(v + gauss() * 0.22, 0, 1);
          lx = x0 + (x1 - x0) * i / n; ly = bot - v * (bot - top);
          if (i) c.lineTo(lx, ly); else c.moveTo(lx, ly);
        }
        c.stroke(); c.fillStyle = '#fff'; c.fillRect(lx - 0.9, ly - 0.9, 1.8, 1.8);
      },
      bars(c, x0, x1, y0, y1, t) {
        const y = header(c, x0, x1, y0, t), n = 6 + (rnd() * 10 | 0), bh = (y1 - y - 1) / n;
        c.font = `500 3px ${FONT}`;
        for (let i = 0; i < n; i++) {
          const v = rr(0.1, 1), yy = y + i * bh;
          c.fillStyle = rgba(t, 0.35); c.fillText(String(i).padStart(2, '0'), x0, yy);
          c.fillStyle = rgba(t, v > 0.85 ? 1 : 0.65); c.fillRect(x0 + 7, yy + 0.4, (x1 - x0 - 7) * v, Math.max(0.8, bh - 1.2));
        }
      },
      prog(c, x0, x1, y0, y1, t) {
        let y = y1 - y0 > 18 ? header(c, x0, x1, y0, t) : y0 + 1;
        c.font = `500 3.4px ${FONT}`;
        if (realOn()) {
          // real tool dispatch only (name + state); no synthetic agent names or percentages
          const tools = live && Array.isArray(live.tools) ? live.tools.slice(-6) : [];
          for (let i = 0; i < tools.length && y < y1 - 5; i++) {
            const name = String(tools[i].name || '').slice(0, 14);
            const state = String(tools[i].state || '');
            if (!name) continue;
            c.fillStyle = rgba(t, 0.55); c.fillText(name, x0, y);
            c.fillStyle = rgba(t, 0.9); c.textAlign = 'right'; c.fillText(state, x1, y); c.textAlign = 'left';
            const bx = x0 + 15, bw = x1 - x0 - 26, segs = 12;
            const p = state === 'ok' ? 1 : state === 'error' ? 0.15 : 0.6;
            for (let s = 0; s < segs; s++) { c.fillStyle = rgba(t, s / segs < p ? 0.85 : 0.14); c.fillRect(bx + s * bw / segs, y + 0.6, bw / segs - 0.6, 2); }
            y += 5.4;
          }
          return;
        }
        while (y < y1 - 5) {
          const p = rnd();
          c.fillStyle = rgba(t, 0.55); c.fillText(pick(['read', 'build', 'review', 'qa', 'sync', 'diff']), x0, y);
          c.fillStyle = rgba(t, 0.9); c.textAlign = 'right'; c.fillText((p * 100 | 0) + '%', x1, y); c.textAlign = 'left';
          const bx = x0 + 15, bw = x1 - x0 - 26, segs = 12;
          for (let i = 0; i < segs; i++) { c.fillStyle = rgba(t, i / segs < p ? 0.85 : 0.14); c.fillRect(bx + i * bw / segs, y + 0.6, bw / segs - 0.6, 2); }
          y += 5.4;
        }
      },
      grid(c, x0, x1, y0, y1, t) {
        const y = y1 - y0 > 20 ? header(c, x0, x1, y0, t) : y0 + 1, p = rr(2.4, 3.2);
        for (let yy = y; yy < y1 - p + 0.5; yy += p) for (let xx = x0; xx < x1 - p + 0.5; xx += p) {
          const v = rnd();
          c.fillStyle = v > 0.93 ? 'rgba(240,166,198,.95)' : rgba(t, 0.08 + v * v * 0.8);
          c.fillRect(xx, yy, p - 0.6, p - 0.6);
        }
      },
      gauge(c, x0, x1, y0, y1, t) {
        const r = Math.min((y1 - y0) / 2 - 1.5, 9), gx = x0 + r + 1, gy = (y0 + y1) / 2, v = rnd();
        c.lineWidth = 1.2; c.strokeStyle = rgba(t, 0.15); c.beginPath(); c.arc(gx, gy, r, 0, TAU); c.stroke();
        c.strokeStyle = rgba(t, 0.95); c.beginPath(); c.arc(gx, gy, r, -Math.PI / 2, -Math.PI / 2 + TAU * v); c.stroke();
        c.font = `700 ${Math.max(3.2, r * 0.55)}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillStyle = rgba(t, 1); c.fillText((v * 100 | 0) + '', gx, gy); c.textAlign = 'left'; c.textBaseline = 'top';
        if (x1 - (gx + r) > 20) BLOCKS.kv(c, gx + r + 4, x1, y0, y1, t);
      },
      wave(c, x0, x1, y0, y1, t) {
        const y = header(c, x0, x1, y0, t), mid = (y + y1) / 2, amp = (y1 - y) * 0.38, f1 = rr(0.15, 0.4), f2 = rr(0.5, 1.2), ph = rnd() * 6;
        [[0.95, 1], [0.4, -0.6]].forEach(([a, k]) => {
          c.strokeStyle = rgba(t, a); c.lineWidth = 0.5; c.beginPath();
          for (let xx = x0; xx <= x1; xx += 0.8) {
            const yy = mid + amp * k * (Math.sin(xx * f1 + ph) * 0.7 + Math.sin(xx * f2) * 0.3);
            if (xx === x0) c.moveTo(xx, yy); else c.lineTo(xx, yy);
          }
          c.stroke();
        });
      },
      para(c, x0, x1, y0, y1, t) { glyphStrips(x0, x1, y0, y1, rr(2.6, 3.4), { tint: t, ragged: true, th: 1.3 }, c); },
      cols(c, x0, x1, y0, y1, t) { glyphStrips(x0, x1, y0, y1, rr(3.6, 4.6), { tint: t, colGap: true, th: 1.5 }, c); },
      barcode(c, x0, x1, y0, y1, t) { glyphStrips(x0, x1, y0, y1, rr(3.2, 4.2), { tint: t, solid: true, th: 1.8 }, c); },
      matrix(c, x0, x1, y0, y1, t) {
        const p = rr(2.1, 2.6), dens = rr(0.35, 0.65);
        for (let yy = y0; yy < y1 - 1; yy += p) for (let xx = x0; xx < x1; xx += p) {
          if (rnd() < dens) { c.fillStyle = rgba(t, rr(0.5, 1)); c.fillRect(xx, yy, 1.4, 1.4); }
        }
      },
    };
    function glyphStrips(x, x1, y0, y1, pitch, opt, ctx) {
      const tint = opt.tint;
      for (let lx = x; lx < x1 - 1; lx += pitch) {
        if (opt.colGap && rnd() < 0.18) { lx += pitch * 0.8; continue; }
        const len = (y1 - y0) * (opt.ragged ? rr(0.35, 1) : rr(0.85, 1));
        const start = opt.ragged && rnd() < 0.3 ? y0 + rr(0, (y1 - y0) * 0.3) : y0;
        let y = start;
        const lb = rr(0.55, 1);
        while (y < Math.min(y1, start + len)) {
          const cl = opt.solid ? rr(2, 6) : rr(0.9, 2.2);
          if (rnd() < 0.9) { ctx.fillStyle = rgba(tint, lb * rr(0.6, 1)); ctx.fillRect(lx, y, opt.th, Math.min(cl, y1 - y)); }
          y += cl + (rnd() < 0.12 ? rr(1.5, 3) : rr(0.5, 0.9));
        }
      }
    }
    function pickBlock(h) {
      // real-only: only blocks that can render live session data (tokens / metrics / tools)
      if (realOn()) return pick(['code', 'kv', 'prog']);
      for (let tries = 0; tries < 8; tries++) {
        let r = rnd() * 100, name = 'para';
        for (const [n, w] of BLOCK_W) { r -= w; if (r <= 0) { name = n; break; } }
        if (!NEEDS_H[name] || h >= NEEDS_H[name]) return name;
      }
      return pick(['para', 'kv', 'matrix', 'barcode']);
    }
    function renderSlot(s) {
      const band = RO - R, h = s.hpx;
      const cw = Math.max(1, Math.ceil(band * RING_SC)), chh = Math.max(1, Math.ceil((h + 2) * RING_SC));
      let c = s.c;
      if (!c || c.width !== cw || c.height !== chh) {
        c = newCanvas(cw, chh);
        if (!c) return;
        c.width = cw; c.height = chh;
      }
      const x = c.getContext('2d');
      if (!x) return;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, cw, chh);
      x.scale(RING_SC, RING_SC); x.textBaseline = 'top';
      const RB = rimW(), dz0 = RB + 6, dz1 = band * 0.72, oz0 = band * 0.78, oz1 = band - RB - 5;
      const split = rnd() < 0.45 && dz1 - dz0 > 60;
      const blocks = [];
      if (split) { const m = dz0 + (dz1 - dz0) * rr(0.42, 0.6); blocks.push([dz0, m], [m + rr(4, 8), dz1]); }
      else blocks.push([dz0, dz1 - rr(0, 18)]);
      for (const [b0, b1] of blocks) {
        const tint = pick(TINTS), y0 = 1 + rr(0, 2), y1 = h + 1 - rr(0, 2);
        x.save(); x.beginPath(); x.rect(b0, y0 - 0.5, b1 - b0, y1 - y0 + 1); x.clip();
        BLOCKS[pickBlock(y1 - y0)](x, b0, b1, y0, y1, tint);
        x.restore();
      }
      // outer index column: tiny ids + tick groups
      const pitch = rr(8, 12);
      x.font = `600 3.1px ${FONT}`;
      for (let yy = rr(1, pitch); yy < h - 2; yy += pitch) {
        if (rnd() < 0.15) continue;
        let xx = oz0 + rr(0, 3);
        if (!realOn() && rnd() < 0.45) { x.fillStyle = `rgba(225,228,236,${rr(0.55, 0.95)})`; x.fillText(String((rnd() * 999) | 0).padStart(3, '0'), xx, yy - 1); xx += 9; }
        const n = 1 + (rnd() * 3 | 0);
        for (let i = 0; i < n && xx < oz1; i++) { x.fillStyle = `rgba(225,228,236,${rr(0.5, 0.95)})`; x.fillRect(xx, yy, rr(1.2, 2.4), 1.2); xx += rr(2.4, 3.6); }
      }
      if (rnd() < 0.45) {
        x.fillStyle = 'rgba(220,224,232,.7)';
        for (let xx = dz0; xx < oz1; xx += rr(2.4, 4.5)) if (rnd() < 0.8) x.fillRect(xx, h + 0.4, 1.1, 1.1);
      }
      s.c = c;
    }
    function flashSlotAt(ang) {
      const off = ringRot + spinOffset;
      let best = null, bd = 9;
      for (const s of slots) { const d = Math.abs(normA(s.a + off - ang)); if (d < bd) { bd = d; best = s; } }
      if (best && bd < 0.08) best.flash = Math.max(best.flash, 0.8);
    }
    function buildCards() {
      slots = [];
      const band = RO - R, mid = R + band * 0.42;
      let a = 0;
      while (a < TAU - 0.03) {
        const hpx = rr(16, 62), da = hpx / mid, gap = rr(3, 9) / mid;
        // rk = reveal rank along the ring: the build-up sweep shows panels in ring order
        slots.push({ a: a + da / 2, rk: (a + da / 2) / TAU, da, hpx, c: null, flash: 0 });
        a += da + gap;
      }
      Object.assign(rot, { from: 0, to: 0, t: 1, dur: 1, hold: 0 });
    }
    function drawRing(dtM, actOn, bd) {
      const band = RO - R;
      S.globalCompositeOperation = 'source-over';
      S.save(); S.translate(cx, cy);
      if (bd > 0) {                                  // the black ring band only in backdrop mode
        S.beginPath(); S.arc(0, 0, RO, 0, TAU); S.arc(0, 0, R, 0, TAU, true);
        S.fillStyle = `rgba(4,5,6,${bd})`; S.fill('evenodd');
      }
      let regen = 1;
      for (const s of slots) {
        // build-up: panels are revealed in ring order as bld climbs (not just a global alpha multiply)
        let show = bld >= 1 ? 1 : clamp((bld - s.rk) / 0.14, 0, 1);
        // switch window: rebuild the ring panel by panel as it turns, so the new
        // Session's content replaces the old one in step with the revolve
        if (switchT >= 0 && num(C.switchReveal, 1) >= 0.5) {
          show *= clamp((switchT / switchDur - s.rk * 0.55) / 0.28, 0, 1);
        }
        if (show <= 0.004) continue;
        const A = s.a + ringRot + spinOffset;      // + one-shot revolve offset
        if (s.flash > 0) s.flash = Math.max(0, s.flash - dtM * 2.2);
        const mid = R + band * 0.42;
        const sp = toScreen(cx + Math.cos(A) * mid, cy + Math.sin(A) * mid);
        if (sp.x < -140 || sp.x > W + 140 || sp.y < -140 || sp.y > H + 140) continue;
        if (!s.c) { renderSlot(s); }
        else if (regen > 0 && actOn && rnd() < 0.02) { renderSlot(s); regen--; }
        if (!s.c) continue;
        S.save(); S.rotate(A);
        const hh = s.hpx + 2;
        if (show < 1) S.globalAlpha = show;
        S.drawImage(s.c, R, -hh / 2, band, hh);
        if (s.flash > 0.02) {
          S.globalCompositeOperation = 'lighter'; S.globalAlpha = s.flash * show;
          S.drawImage(s.c, R, -hh / 2, band, hh);
          S.globalCompositeOperation = 'source-over';
        }
        S.restore();
      }
      // rulers & rim bands (all rotate with the ring; the rulers follow the revolve offset too)
      const rOff = ringRot + spinOffset;
      const tick = (step, fn) => {
        const n0 = Math.floor((-thV - 0.05 - rOff) / step), n1 = Math.ceil((thV + 0.05 - rOff) / step);
        for (let n = n0; n <= n1; n++) { const a = n * step + rOff; fn(Math.cos(a), Math.sin(a), n); }
      };
      const RB = rimW();
      S.beginPath();
      tick(0.14 / C.rimDensity * Math.PI / 180, (ca, sa, n) => {
        const m = ((n % 6) + 6) % 6;
        const li = m === 0 ? RB : RB * (0.5 + 0.35 * hash(n));
        const lo = m === 0 ? RB : RB * (0.5 + 0.35 * hash(n + 77));
        S.moveTo(ca * (R + 1.5), sa * (R + 1.5)); S.lineTo(ca * (R + 1.5 + li), sa * (R + 1.5 + li));
        S.moveTo(ca * (RO - 1.5), sa * (RO - 1.5)); S.lineTo(ca * (RO - 1.5 - lo), sa * (RO - 1.5 - lo));
      });
      S.globalCompositeOperation = 'lighter';
      S.strokeStyle = `rgba(232,235,242,${Math.min(1, 0.035 * C.rimBright * C.rimBright)})`; S.lineWidth = 1.2 + 2.4 * C.rimBright; S.stroke();
      S.strokeStyle = `rgba(232,235,242,${Math.min(1, 0.08 * C.rimBright)})`; S.lineWidth = 1.4; S.stroke();
      S.globalCompositeOperation = 'source-over';
      S.strokeStyle = `rgba(240,242,248,${Math.min(1, 0.88 * C.rimBright)})`; S.lineWidth = 0.55; S.stroke();
      const arc = (r, lw, al) => { S.strokeStyle = `rgba(232,235,242,${al})`; S.lineWidth = lw; S.beginPath(); S.arc(0, 0, r, -thV, thV); S.stroke(); };
      arc(R, 1.5, 1); arc(R + RB + 3, 0.6, 0.6); arc(RO - RB - 3, 0.6, 0.55);
      S.globalCompositeOperation = 'lighter'; arc(RO, 3.5, 0.1); S.globalCompositeOperation = 'source-over';
      arc(RO, 1.3, 0.95);
      S.beginPath();
      tick(1 * Math.PI / 180, (ca, sa) => { S.moveTo(ca * (R - 2), sa * (R - 2)); S.lineTo(ca * (R - 5), sa * (R - 5)); });
      tick(0.25 * Math.PI / 180, (ca, sa, n) => {
        const m = ((n % 20) + 20) % 20, L = m === 0 ? 9 : m % 5 === 0 ? 5 : 2.5;
        S.moveTo(ca * (RO + 2), sa * (RO + 2)); S.lineTo(ca * (RO + 2 + L), sa * (RO + 2 + L));
      });
      S.strokeStyle = 'rgba(230,233,240,.5)'; S.lineWidth = 0.6; S.stroke();
      S.restore();
    }

    /* ---------- camera ---------- */
    function buildShots() {
      const P = (a, r) => ({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      const mid = (R + RO) / 2;
      shots = [
        { x: W / 2, y: H / 2, z: 1, hold: 4.5 },
        { ...P(-thS * 0.45, mid), z: 2.3, hold: 3.4 },
        { ...P(0.04, RO + (RMAX - RO) * 0.3), z: 1.6, hold: 3.2 },
        { x: W / 2, y: H / 2, z: 1, hold: 3.0 },
        { ...P(0.22, R * 0.8), z: 1.9, hold: 3.4 },
        { ...P(thS * 0.5, mid + 10), z: 2.8, hold: 3.0 },
        { ...P(-0.12, RO + 40), z: 1.35, hold: 3.2 },
      ];
      shotI = 0; shotT = 0; camPhase = 'hold';
      Object.assign(cam, shots[0]);
    }
    function clampCam() {
      const hw = W / (2 * cam.z), hh = H / (2 * cam.z);
      cam.x = Math.max(hw, Math.min(W - hw, cam.x));
      cam.y = Math.max(hh, Math.min(H - hh, cam.y));
    }
    const zf = z => 1 + (z - 1) * C.camZoom;
    function updateCam(dtM) {
      if (!C.camera) { cam.x = W / 2; cam.y = H / 2; cam.z = 1; return; }
      if (dtM <= 0 || !shots.length) return;
      shotT += dtM;
      const cur = shots[shotI], nxt = shots[(shotI + 1) % shots.length];
      if (camPhase === 'hold') {
        const k = shotT / cur.hold;
        cam.x = cur.x; cam.y = cur.y + (cur.z > 1 ? Math.sin(k * Math.PI) * 6 : 0);
        cam.z = zf(cur.z) * (1 + 0.05 * k * C.camZoom);
        if (shotT >= cur.hold) { camPhase = 'move'; shotT = 0; camFrom = { ...cam }; }
      } else {
        const dur = 2.2, e = easeIO(Math.min(1, shotT / dur));
        const lz = Math.log(camFrom.z) + (Math.log(zf(nxt.z)) - Math.log(camFrom.z)) * e;
        let z = Math.exp(lz);
        if (camFrom.z > 1.2 && zf(nxt.z) > 1.2) z *= 1 - 0.4 * Math.sin(Math.PI * e);
        cam.z = Math.max(1, z);
        cam.x = camFrom.x + (nxt.x - camFrom.x) * e;
        cam.y = camFrom.y + (nxt.y - camFrom.y) * e;
        if (shotT >= dur) { shotI = (shotI + 1) % shots.length; camPhase = 'hold'; shotT = 0; }
      }
      clampCam();
    }
    /** switch punch: a small zoom dip on top of the camera; never written into cam itself */
    function camPunch() {
      if (switchT < 0 || num(C.switchCam, 1) < 0.5) return 1;
      return 1 - 0.028 * Math.sin(Math.PI * (switchT / switchDur));
    }
    function camT(ctx, d) {
      const z = cam.z * camPunch();
      ctx.setTransform(d * z, 0, 0, d * z, d * (W / 2 - cam.x * z), d * (H / 2 - cam.y * z));
    }
    function camTk(ctx, d, k) {
      const z = (1 + (cam.z - 1) * k) * camPunch(), x = W / 2 + (cam.x - W / 2) * k, y = H / 2 + (cam.y - H / 2) * k;
      ctx.setTransform(d * z, 0, 0, d * z, d * (W / 2 - x * z), d * (H / 2 - y * z));
    }
    const toScreen = (x, y) => ({ x: (x - cam.x) * cam.z + W / 2, y: (y - cam.y) * cam.z + H / 2 });

    /* ---------- rhythm: an uneven beat clock drives everything ---------- */
    function updateBeat(dtM, actOn) {
      if (!actOn) { beatT = 0; }
      else {
        beatT -= dtM;
        if (beatT <= 0) {
          beatT += PATTERN[beatI++ % PATTERN.length] * 0.92 / Math.max(0.05, C.tempo);
          sinceBeat = 0; beatN++;
          onBeat();
        }
        if (beatT < 0) beatT = 0;
      }
      sinceBeat += dtM;
      benv = Math.exp(-sinceBeat * 4.5);
    }
    function queueSpawn(kind, delay) {
      if (pending.length > 240) return;
      pending.push({ t: pendingT + delay, k: kind });
    }
    function flushPending(dtM, actOn) {
      pendingT += dtM;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].t > pendingT) continue;
        const k = pending[i].k;
        pending.splice(i, 1);
        if (!actOn) continue;
        if (k === 0) spawnComet(); else spawnFlyBurst();
      }
    }
    function onBeat() {
      // ring: kick every other beat → stepped, fast rotation
      if (rot.t >= rot.dur && rot.hold <= 0) ringMove();
      // comets come in bursts (frame-integrated queue, no timers)
      const n = Math.round((beatN % 4 === 0 ? C.cometBurst : C.cometPerBeat) * rr(0.6, 1.4));
      for (let i = 0; i < n; i++) queueSpawn(0, i * rr(0.03, 0.09));
      // web layers shimmer
      layerEnv[(rnd() * 3) | 0] = 1;
      if (beatN % 4 === 0) layerEnv = layerEnv.map(() => rr(0.6, 1));
      // outer: travelling wave + random wedge hits
      const dir = rnd() < 0.5 ? 1 : -1, big = beatN % 8 === 0;
      pulses.push({
        c: dir > 0 ? -thS - 0.15 : thS + 0.15, v: dir * rr(0.7, 1.6) * (big ? 0.7 : 1),
        w: big ? rr(0.25, 0.4) : rr(0.05, 0.16), amp: big ? 1 : rr(0.45, 0.9), life: rr(1.2, 2.0), L: 0,
      });
      pulses.forEach(p => p.L || (p.L = p.life));
      onBeatOuter();
      // ring cards
      for (let i = 0; i < Math.round(6 * C.dataFlicker); i++) { const s = pick(slots); if (s) s.c = null; }
      for (let i = 0; i < Math.round(2 * C.dataFlicker); i++) { const s = pick(slots); if (s) s.flash = rr(0.35, 0.7); }
    }
    function ringMove() {
      const r = rnd(); let d, dur, ease;
      if (r < 0.22) { d = rr(1.1, 2.1); dur = rr(0.7, 1.05); ease = easeIO; }
      else if (r < 0.64) { d = rr(0.14, 0.48); dur = rr(0.18, 0.38); ease = easeOX; }
      else { d = rr(0.05, 0.18); dur = rr(0.3, 0.6); ease = easeIO; }
      if (rnd() < 0.08) d = -d * 0.5;
      d *= C.ringSpeed;
      Object.assign(rot, { from: ringRot, to: ringRot + d, t: 0, dur, ease, hold: rr(0.04, 0.4) * C.ringPause });
    }
    function updateRing(dtM) {
      if (dtM <= 0) return;   // mo = 0 → the ring angle is frozen (round 1 semantics)
      if (rot.t < rot.dur) {
        rot.t += dtM;
        ringRot = rot.from + (rot.to - rot.from) * rot.ease(Math.min(1, rot.t / rot.dur));
      } else {
        rot.hold -= dtM;
        ringRot += 0.02 * dtM;
      }
    }
    function updateFlyers(dtM, actOn) {
      for (const b of flyBands) { b.life -= dtM; if (b.life <= 0) Object.assign(b, newFlyBand()); }
      const k = (0.7 + 0.9 * benv) * C.flyerSpeed;
      for (let i = flyers.length - 1; i >= 0; i--) {
        const f = flyers[i];
        f.r += f.sp * dtM * k;
        if (f.r - f.len > RMAX) {
          if (f.burst || !actOn) flyers.splice(i, 1);   // bursts die out; singles respawn only while active
          else flyers[i] = newFlyer(false);
        }
      }
    }
    function onBeatFlyers() {
      const n = Math.round((beatN % 4 === 0 ? 3 + (rnd() * 2 | 0) : 1 + (rnd() * 2 | 0)) * C.burstRate);
      for (let i = 0; i < n; i++) queueSpawn(1, i * rr(0.02, 0.12));
    }
    function updateOuter(dtM, actOn) {
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        p.c += p.v * dtM; p.life -= dtM;
        if (p.life <= 0) pulses.splice(i, 1);
      }
      for (const Lr of strandLayers) {
        const rotA = strandRot(Lr);
        for (const w of Lr.wedges) {
          const am = normA((w.i0 + w.n / 2) * Lr.step + rotA);
          w.vis = Math.abs(am) < thS + 0.2;
          w.flow += dtM * w.dsp * (0.45 + 2.2 * benv);
          if (!w.vis) { if (dtM > 0) w.len *= 0.98; continue; }
          let p = 0;
          for (const pl of pulses) {
            const f = Math.min(1, pl.life / 0.5) * Math.min(1, (pl.L - pl.life) / 0.15 + 0.3);
            p += pl.amp * f * Math.exp(-(((am - pl.c) / pl.w) ** 2));
          }
          if (Lr.dyn === 'bounce') {
            const idle = w.base * (0.36 + 0.14 * Math.sin(T * 0.9 + w.ph));
            const tgt = Math.min(1, idle + p * 0.75 + w.kick * 0.6);
            w.kick *= Math.exp(-dtM * 2.4);
            w.len += (tgt - w.len) * Math.min(1, (tgt > w.len ? 15 : 2.2) * dtM);
          } else {
            const n1 = 0.5 + 0.5 * Math.sin(T * w.f1 + w.ph), n2 = 0.5 + 0.5 * Math.sin(T * w.f2 + w.ph2);
            const idle = w.base * (0.4 + 0.34 * n1 + 0.14 * n2);
            const tgt = Math.min(1.05, (idle + p * 0.7 + w.kick * 0.55) * w.lenS);
            w.kick *= Math.exp(-dtM * 1.8);
            w.len += (tgt - w.len) * Math.min(1, (tgt > w.len ? 5 : 1.3) * dtM);
          }
        }
      }
      // haze lifecycle
      for (let i = hazes.length - 1; i >= 0; i--) {
        const h = hazes[i]; h.age += dtM;
        h.cur += (h.len - h.cur) * Math.min(1, 9 * dtM);
        if (h.age > h.life + 0.6) hazes.splice(i, 1);
      }
      if (actOn && hazes.length < C.hazeCount && rnd() < Math.min(0.9, 15 * dtM)) spawnHaze(false);
      for (let i = flares.length - 1; i >= 0; i--) { flares[i].age += dtM; if (flares[i].age > flares[i].life) flares.splice(i, 1); }
      if (actOn && rnd() < Math.min(0.9, 3.6 * dtM * C.flareRate)) spawnFlare();
      updateFlyers(dtM, actOn);
    }

    /* ---------- scanline overlay (the DOM ::after of lab.html) ----------
       backdrop mode  = the original black hairlines + elliptical shading
       overlay mode   = additive hairlines only, so nothing darkens the UI behind */
    function tilePattern(fill) {
      const tile = newCanvas(1, 3);
      if (!tile) return null;
      tile.width = 1; tile.height = 3;
      const x = tile.getContext('2d');
      if (!x) return null;
      x.clearRect(0, 0, 1, 3);
      x.fillStyle = fill; x.fillRect(0, 0, 1, 1);
      try { return S.createPattern(tile, 'repeat'); } catch (e) { return null; }
    }
    function buildScanOverlay() {
      scanPatDark = tilePattern('rgba(0,0,0,0.18)');
      scanPatLight = tilePattern('rgba(255,255,255,0.05)');
      scanGrad = null;
      try {
        scanGrad = S.createRadialGradient(W * 0.4, H * 0.5, Math.min(W, H) * 0.18, W * 0.4, H * 0.5, Math.hypot(W, H) * 0.62);
        scanGrad.addColorStop(0, 'rgba(0,0,0,0)');
        scanGrad.addColorStop(1, 'rgba(0,0,0,0.55)');
      } catch (e) { scanGrad = null; }
    }
    function drawScan(bd) {
      const k = clamp(num(C.scan, 0), 0, 1);
      if (k <= 0) return;
      S.setTransform(DPR, 0, 0, DPR, 0, 0);
      S.globalAlpha = k;
      if (bd > 0) {
        S.globalCompositeOperation = 'source-over';
        if (scanPatDark) { S.fillStyle = scanPatDark; S.fillRect(0, 0, W, H); }
        if (scanGrad) { S.fillStyle = scanGrad; S.fillRect(0, 0, W, H); }
      } else {
        S.globalCompositeOperation = 'lighter';
        if (scanPatLight) { S.fillStyle = scanPatLight; S.fillRect(0, 0, W, H); }
        S.globalCompositeOperation = 'source-over';
      }
      S.globalAlpha = 1;
    }

    /* ---------- callout box with leader line (canvas version of the DOM callout) ---------- */
    function drawCallout(dtM, bd) {
      chkT += dtM;
      if (chkT >= 3.6) { chkT = 0; chkI = (chkI + 1) % CHECKS.length; }
      const alpha = chkT > 3.2 ? Math.max(0, 1 - (chkT - 3.2) / 0.4) : 1;
      const a = -thS * 0.32;
      const anchor = toScreen(cx + Math.cos(a) * (RO + 30), cy + Math.sin(a) * (RO + 30));
      const box = toScreen(cx + Math.cos(a) * (RO + 30) + 120, cy + Math.sin(a) * (RO + 30) - 40);
      const bw = 152, bh = 34;
      const bx = Math.min(W - bw - 8, Math.max(8, box.x)), by = Math.min(H - bh - 12, Math.max(20, box.y));
      const tps = liveNumber('tps');
      let lab;
      if (realOn()) {
        if (tps <= 0.5) return;                     // level 2: no synthetic "check" cards
        lab = ['TOKEN STREAM', tps.toFixed(1) + ' tok/s'];
      } else if (pureOn()) {
        lab = CHECKS[chkI];                         // level 0: the original fabricated checks
      } else {
        lab = tps > 0.5 ? ['TOKEN STREAM', tps.toFixed(1) + ' tok/s'] : CHECKS[chkI];
      }
      S.setTransform(DPR, 0, 0, DPR, 0, 0);
      S.globalCompositeOperation = 'source-over';
      S.globalAlpha = alpha;
      S.strokeStyle = 'rgba(230,233,238,.55)'; S.lineWidth = 0.8;
      S.beginPath(); S.moveTo(anchor.x, anchor.y); S.lineTo(bx, by + bh * 0.5); S.stroke();
      S.fillStyle = '#fff'; S.fillRect(anchor.x - 1.5, anchor.y - 1.5, 3, 3);
      if (bd > 0) {
        S.fillStyle = `rgba(8,9,11,${0.85 * bd})`; S.fillRect(bx, by, bw, bh);
        S.strokeStyle = 'rgba(58,62,70,1)';
      } else {
        S.strokeStyle = 'rgba(206,212,224,.45)';   // outline only: no dark box over the UI
      }
      S.lineWidth = 1; S.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      S.textBaseline = 'top'; S.textAlign = 'left';
      S.font = `600 8px ${FONT}`; S.fillStyle = 'rgba(107,111,120,1)';
      S.fillText(lab[0], bx + 8, by + 5);
      S.font = `600 11px ${FONT}`; S.fillStyle = '#f4f5f7';
      S.fillText(lab[1], bx + 8, by + 17);
      S.textBaseline = 'alphabetic';
      S.globalAlpha = 1;
    }

    /* ---------- frame ---------- */
    function drawStage(dt) {
      const dtM = dt * mo;
      const actOn = live01 > EPS_ACT;
      const outA = clamp(out, 0, 1);
      const runLv = Math.max(0.2, clamp(num(C.runLevel, 1), 0.2, 2));
      bld = clamp(out / runLv, 0, 1);              // normalised build progress
      bldG = (0.32 + 0.68 * bld) * (1 + 0.45 * clamp(num(C.switchFlash, 0), 0, 1) * switchPulse());
      // outer beams / flyers / haze gain (switch pulse rides on top)
      coreG = 0.35 + 0.65 * bld;                   // light-field core + runner trail gain
      updateBeat(dtM, actOn);
      flushPending(dtM, actOn);
      updateCam(dtM);
      updateOuter(dtM, actOn);
      if (actOn && C.cometTrickle > 0 && rnd() < dtM * C.cometTrickle) spawnComet();
      webRot += dtM * (0.03 + benv * 0.12) * C.webSpin;
      updateRing(dtM);
      for (let k = 0; k < 3; k++) layerEnv[k] *= Math.exp(-dtM * 2.2);

      // FADE MECHANISM: the whole frame (scene + scan + callout) is composed into frameC,
      // then blitted once onto the visible canvas with globalAlpha = out. The visible canvas
      // is always cleared first, so out = 0 leaves it fully transparent ("只剩空气").
      const bd = backdrop();
      const target = (frameC && frameC.x) ? frameC.x : S_MAIN;
      S = S_MAIN;
      S_MAIN.setTransform(DPR, 0, 0, DPR, 0, 0);
      S_MAIN.globalCompositeOperation = 'source-over';
      S_MAIN.globalAlpha = 1;
      S_MAIN.clearRect(-2, -2, W + 4, H + 4);
      if (outA <= 0.0008) return;
      S = target;
      target.setTransform(DPR, 0, 0, DPR, 0, 0);
      target.globalCompositeOperation = 'source-over'; target.globalAlpha = 1;
      target.clearRect(-2, -2, W + 4, H + 4);
      if (bd > 0) { S.fillStyle = `rgba(8,9,11,${bd})`; S.fillRect(-2, -2, W + 4, H + 4); }

      // glow buffer (low-res, blurred later)
      if (glowC && glowC.x) {
        const G = glowC.x;
        G.setTransform(1, 0, 0, 1, 0, 0); G.clearRect(0, 0, glowC.width, glowC.height);
        camT(G, 1 / GS); G.globalCompositeOperation = 'lighter';
      }

      camTk(S, DPR, 1 - 0.1 * C.parallax);   // the web sits a little further back

      // inner web + pulsing layers
      S.save(); S.translate(cx, cy); S.rotate(webRot);
      const ws = 2 * R + 4;
      if (bd > 0 && webDisc) {                      // opaque web disc only in backdrop mode
        S.globalAlpha = bd; S.fillStyle = webDisc;
        S.beginPath(); S.arc(0, 0, R, 0, TAU); S.fill();
        S.globalAlpha = 1;
      }
      if (webBase) { S.globalAlpha = coreG; S.drawImage(webBase, -R - 2, -R - 2, ws, ws); S.globalAlpha = 1; }
      S.globalCompositeOperation = 'lighter';
      webLayers.forEach((c, k) => {
        S.globalAlpha = Math.min(1, (C.webPulseBase + C.webPulseAmp * layerEnv[k]) * coreG);
        S.drawImage(c, -R - 2, -R - 2, ws, ws);
      });
      S.globalAlpha = 1;

      // runners: speed surges on the beat
      const tx = trailC && trailC.x;
      const surge = 0.5 + 2.5 * benv;
      const wantRunners = Math.round(clamp(num(C.runnerCount, 0), 0, 900));
      while (actOn && runners.length < wantRunners) runners.push(newRunner(true));
      if (runners.length > wantRunners) runners.length = Math.max(0, wantRunners);
      if (tx) {
        if (dtM > 0) {
          tx.globalCompositeOperation = 'destination-out';
          tx.fillStyle = `rgba(0,0,0,${0.05 + benv * 0.05})`; tx.fillRect(0, 0, ws, ws);
          tx.globalCompositeOperation = 'source-over';
        }
        tx.save(); tx.translate(R + 2, R + 2); tx.lineCap = 'round';
        for (let i = runners.length - 1; i >= 0; i--) {
          const r = runners[i];
          r.t += dtM * C.runnerSpeed * (r.mode === 1 ? r.sp * surge : r.mode === 2 ? r.sp + 1.3 * r.t * r.t : r.sp);
          if (r.t >= 1) {
            // wind down while idle, respawn only while the session is active
            if (actOn) runners[i] = newRunner(false); else runners.splice(i, 1);
            continue;
          }
          const p = qpt(r.cv, r.t);
          tx.strokeStyle = r.b ? `rgba(240,166,198,${Math.min(1, 0.9 * C.runnerBright)})` : `rgba(250,251,255,${Math.min(1, 0.75 * C.runnerBright)})`;
          tx.lineWidth = (r.b ? 1.3 : 0.9) * C.runnerWidth;
          tx.beginPath(); tx.moveTo(r.px, r.py); tx.lineTo(p.x, p.y); tx.stroke();
          r.px = p.x; r.py = p.y;
        }
        tx.restore();
        S.globalAlpha = coreG;
        S.drawImage(trailC, -R - 2, -R - 2, ws, ws);
        S.globalAlpha = 1;
      }
      S.restore();
      camT(S, DPR);
      // ring occlusion: the web darkens toward the ring (dark fill → backdrop mode only)
      if (C.ringShadow > 0 && bd > 0) {
        const sg = S.createRadialGradient(cx, cy, R - 110, cx, cy, R);
        sg.addColorStop(0, 'rgba(4,5,6,0)'); sg.addColorStop(1, `rgba(4,5,6,${Math.min(1, 0.8 * C.ringShadow * bd)})`);
        S.globalCompositeOperation = 'source-over'; S.globalAlpha = 1; S.fillStyle = sg;
        S.beginPath(); S.arc(cx, cy, R, 0, TAU); S.arc(cx, cy, R - 110, 0, TAU, true); S.fill('evenodd');
      }

      // comets
      S.save(); S.translate(cx, cy); S.globalCompositeOperation = 'lighter'; S.lineCap = 'round';
      const G2 = glowC && glowC.x;
      if (G2) G2.save();
      if (G2) G2.translate(cx, cy);
      for (let i = comets.length - 1; i >= 0; i--) {
        const c = comets[i];
        c.life += dtM;
        const p = easeIO(Math.min(1, c.life / c.dur));
        const head = Math.min(1, p * (1 + c.win)), tail = Math.max(0, p * (1 + c.win) - c.win);
        const fade = c.life > c.dur ? Math.max(0, 1 - (c.life - c.dur) / 0.25) : 1;
        if (fade <= 0) { comets.splice(i, 1); continue; }
        const cr = C.cometFollow ? ringRot - c.rot0 + spinOffset : 0;
        if (head >= 1 && !c.hit) { c.hit = true; const pe = cpt(c.lines[c.lines.length >> 1], 1); flashSlotAt(Math.atan2(pe.y, pe.x) + cr); }
        S.save(); S.rotate(cr);
        if (G2) G2.save();
        if (G2) G2.rotate(cr);
        const col = c.tint ? '200,190,250' : '255,255,255';
        S.strokeStyle = `rgba(${col},${Math.min(1, 0.5 * fade * C.cometBright)})`; S.lineWidth = 1;
        strokeComet(S, c, tail, head, 18);
        const hs = head - (head - tail) * 0.35;
        S.strokeStyle = `rgba(${col},${Math.min(1, fade * C.cometBright)})`; S.lineWidth = 1.7;
        strokeComet(S, c, hs, head, 8);
        if (G2) {
          if (c.glow && C.cometGlow > 0) {
            G2.strokeStyle = `rgba(${col},${Math.min(1, 0.5 * fade * C.cometGlow)})`; G2.lineWidth = 2.8;
            strokeComet(G2, c, hs, head, 6);
          }
          G2.restore();
        }
        S.restore();
      }
      if (G2) G2.restore();
      S.restore();

      // outer wedges
      S.globalCompositeOperation = 'lighter';
      if (laneC) S.drawImage(laneC, 0, 0, W, H);
      // far outer layers → half-res buffer, composited blurred
      if (farC && farC.x) {
        const F = farC.x;
        F.setTransform(1, 0, 0, 1, 0, 0); F.globalAlpha = 1; F.globalCompositeOperation = 'source-over';
        F.clearRect(0, 0, farC.width, farC.height);
        camT(F, FS); F.globalCompositeOperation = 'lighter';
        const keep = S;
        S = F; drawOuterFar(); S = keep;
        S.save(); S.setTransform(DPR, 0, 0, DPR, 0, 0); S.globalCompositeOperation = 'lighter';
        if (HAS_FILTER && C.depthBlur > 0) S.filter = `blur(${C.depthBlur}px)`;
        S.globalAlpha = Math.min(1, C.depthDim); S.drawImage(farC, 0, 0, W, H);
        S.restore();
      } else {
        drawOuterFar();
      }
      // atmosphere
      if (C.atmos > 0) {
        const ag = S.createRadialGradient(cx, cy, RO, cx, cy, RO + (RMAX - RO) * 0.7);
        ag.addColorStop(0, `rgba(190,180,240,${Math.min(1, 0.07 * C.atmos)})`);
        ag.addColorStop(0.4, `rgba(150,145,210,${Math.min(1, 0.028 * C.atmos)})`);
        ag.addColorStop(1, 'rgba(0,0,0,0)');
        S.globalAlpha = 1; S.fillStyle = ag;
        S.beginPath(); S.arc(cx, cy, RMAX, 0, TAU); S.arc(cx, cy, RO, 0, TAU, true); S.fill('evenodd');
      }
      drawOuterNear();

      drawRing(dtM, actOn, bd);

      // composite soft glow
      S.setTransform(DPR, 0, 0, DPR, 0, 0);
      S.globalCompositeOperation = 'lighter';
      if (HAS_FILTER) S.filter = 'blur(6px)';
      S.globalAlpha = Math.min(1, 0.9 * C.glow) * coreG;
      if (glowC) S.drawImage(glowC, 0, 0, glowC.width * GS, glowC.height * GS);
      if (HAS_FILTER) S.filter = 'none';
      S.globalAlpha = 1; S.globalCompositeOperation = 'source-over';

      drawBokeh(dtM, actOn);
      if (C.vignette > 0 && bd > 0) {
        S.setTransform(DPR, 0, 0, DPR, 0, 0);
        const vg = S.createRadialGradient(W * 0.45, H * 0.5, Math.min(W, H) * 0.35, W * 0.45, H * 0.5, Math.hypot(W, H) * 0.62);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${Math.min(1, 0.75 * C.vignette * bd)})`);
        S.fillStyle = vg; S.fillRect(0, 0, W, H);
      }

      drawScan(bd);
      drawCallout(dtM, bd);

      // optional colour sweep over the switch window (off by default)
      const hueK = clamp(num(C.switchHue, 0), 0, 1) * switchPulse();
      if (hueK > 0.002) {
        const u = switchU();
        const hue = 200 + 60 * u;
        const a = 0.11 * hueK;
        S.setTransform(DPR, 0, 0, DPR, 0, 0);
        S.globalCompositeOperation = 'lighter';
        const hg = S.createRadialGradient(cx, cy, R * 0.15, cx, cy, RMAX);
        hg.addColorStop(0, 'hsla(' + hue + ',88%,66%,' + a + ')');
        hg.addColorStop(0.55, 'hsla(' + hue + ',88%,66%,' + (a * 0.45) + ')');
        hg.addColorStop(1, 'hsla(' + hue + ',88%,66%,0)');
        S.fillStyle = hg; S.fillRect(0, 0, W, H);
        S.globalCompositeOperation = 'source-over';
      }

      // fade the finished frame onto the visible canvas (single globalAlpha pass)
      S = S_MAIN;
      if (target !== S_MAIN) {
        // `target` is frameC's 2D context; the blit source is the frame buffer element.
        const src = frameC || null;
        S.setTransform(DPR, 0, 0, DPR, 0, 0);
        S.globalCompositeOperation = 'source-over';
        S.globalAlpha = outA;
        if (src) S.drawImage(src, 0, 0, W, H);
        S.globalAlpha = 1;
      }
    }

    /* ---------- level drive ----------
       The master motion multiplier mo comes from a level state machine:
         target = voidLevel (no session) | runLevel (running) | idleMotion (silent)
       Every state change eases from the CURRENT level to the target: rising uses attackMs,
       falling uses releaseMs, shaped by easeCurve with zero slope at both ends.
       live.activity still feeds generation rate / token pulling; it no longer sets mo.
       NOTE (spec vs acceptance): a pure exponential (tau = attack/release) never reaches the
       target (0 → runLevel would take ≈3.9·attackMs) and has its steepest slope at t = 0, so it
       cannot satisfy "rise ≈ attackMs" nor "first/last 100ms < 25% of the average rate".
       This implementation keeps the same per-direction timing knobs but eases over the nominal
       duration, which makes all three assertions hold. */
    function smootherstep(x) { const u = clamp(x, 0, 1); return u * u * u * (u * (u * 6 - 15) + 10); }
    function transitionShape(u) {
      const c = Math.round(num(C.easeCurve, 1));
      if (c <= 0) return u;                                  // 0 = linear
      if (c === 1) return smootherstep(u);                   // 1 = smooth
      return smootherstep(smootherstep(u));                  // 2 = even slower start
    }
    function computeDrive(dt) {
      /* --- generation intensity: live.activity (round-1 semantics, unchanged) --- */
      let raw = 0;
      if (live) {
        const a = Number(live.activity);
        if (isFinite(a)) raw = a;
      }
      raw = clamp(raw, 0, 1) * clamp(num(C.activityGain, 1), 0.05, 6);
      const tauA = raw > act ? 0.12 : 1.2;
      act += (raw - act) * (1 - Math.exp(-dt / tauA));
      if (act < 0.002) act = 0;
      if (act > 3) act = 3;
      live01 = Math.min(1, act);
      if (live01 <= EPS_ACT) { pending.length = 0; pendingT = 0; }
      pullLiveTokens();

      /* --- level state machine --- */
      present = (!live || live.sessionPresent === undefined) ? true : !!live.sessionPresent;
      sessRunning = !!(live && live.running === true);
      const voidLv = clamp(num(C.voidLevel, 0), 0, 1);
      const idleLv = clamp(num(C.idleMotion, 0), 0, 1);
      const runLv = clamp(num(C.runLevel, 1), 0.2, 2);
      const target = !present ? voidLv : (sessRunning ? runLv : idleLv);
      if (target !== envTarget) { envFrom = env; envTarget = target; envT = 0; }
      const rising = envTarget > envFrom;
      const dur = Math.max(0.05, (rising ? num(C.attackMs, 800) : num(C.releaseMs, 2600)) / 1000);
      envT += dt;
      const u = clamp(envT / dur, 0, 1);
      env = envFrom + (envTarget - envFrom) * transitionShape(u);
      if (u >= 1) env = envTarget;                    // settles exactly on the state level
      out = clamp(env, 0, 2);
      mo = out;
    }
    /** one-shot whole-turn rotation of the ring; wall-clock duration = revolveMs */
    function updateSpin(dt) {
      if (!spin) return;
      spin.t += dt;
      const k = Math.min(1, spin.t / spin.dur);
      spinOffset = spin.from + (spin.to - spin.from) * easeIO(k);
      if (k >= 1) {
        // whole turns are visually identical to zero for the ring; the outer field
        // keeps its own share of them, so bake that share into the layer angles first
        const removed = Math.round(spin.to / TAU) * TAU;
        spinOffset = spin.to - removed;
        bakeOuterSpin(removed);
        spin = null;
      }
    }
    /* ---------- session-switch effects (round 4) ---------- */
    /** how far the outer light field follows the ring's one-shot revolve */
    function revOut() {
      return spinOffset * clamp(num(C.revolveOuter, 1), 0, 1);
    }
    /** One layer's current base angle: slow drift + its share of the one-shot revolve.
        updateOuter (visibility) and drawStrands (drawing) MUST use the same value;
        when they drift apart a wedge is culled as "off screen" while it is visibly
        rotating through the cone, which reads as strips disappearing and reappearing. */
    function strandRot(Lr) {
      return ringRot * Lr.rotK + Lr.off + revOut() * (Lr.revK === undefined ? 0.5 : Lr.revK);
    }
    /** 0..1 progress of the switch window, -1 when idle */
    function switchU() { return switchT < 0 ? -1 : clamp(switchT / switchDur, 0, 1); }
    /** 0 -> 1 -> 0 envelope over the switch window */
    function switchPulse() {
      const u = switchU();
      return u < 0 ? 0 : Math.sin(Math.PI * u);
    }
    function updateSwitch(dt) {
      if (switchT < 0) return;
      switchT += dt;
      if (switchT >= switchDur) switchT = -1;
    }
    /** Whole turns are dropped from spinOffset at the end of a revolve; the ring is
        2π-periodic but the outer field only follows it by a fraction, so hand the
        removed amount to each element's own base angle to keep the transition seamless. */
    function bakeOuterSpin(turns) {
      const gain = clamp(num(C.revolveOuter, 1), 0, 1);
      if (gain <= 0 || !isFinite(turns) || turns === 0) return;
      const shift = (k) => turns * gain * k;
      for (const Lr of strandLayers) {
        if (!Lr) continue;
        Lr.off = normA(Lr.off + shift(Lr.revK === undefined ? 0.5 : Lr.revK));
      }
      for (const h of hazes) h.a = normA(h.a + shift(0.4));
      for (const f of flyers) f.a = normA(f.a + shift(0.85));
    }

    /** start the switch window: reveal, brightness pulse, colour sweep, camera punch */
    function switchFx(dur) {
      if (disposed) return;
      switchDur = Math.max(0.3, num(dur, num(C.revolveMs, 1500) / 1000));
      switchT = 0;
      // the visible panel text belongs to the previous Session: drop it so the
      // ring rebuilds from the new Session's tokens while it turns
      for (const s of slots) { release(s.c); s.c = null; }
      tokPool = [];
      toolNames = [];
      dirty = true;
    }
    function countParticles() {
      return runners.length + comets.length + pulses.length + hazes.length + flares.length + flyers.length + bokehs.length;
    }
    function statsTick(dt) {
      frames++; fpsT += dt; statT += dt;
      if (statT < 0.5) return;
      statT = 0;
      if (fpsT > 0) fps = frames / fpsT;
      frames = 0; fpsT = 0;
      refreshTools();
      if (onStats) {
        try { onStats({ fps: Math.round(fps * 10) / 10, particles: countParticles(), activity: Math.round(act * 1000) / 1000 }); } catch (e) { /* host callback */ }
      }
    }

    /* ---------- loop ---------- */
    function step(dt) {
      computeDrive(dt);
      updateSpin(dt);
      updateSwitch(dt);
      statsTick(dt);
      if (!ready || disposed) return;
      applyRebuilds();
      // mo = 0 (void state) → the loop parks; one final frame clears the canvas first
      if (mo === 0 && !dirty && !painted) return;
      painted = mo > 0;
      dirty = false;
      drawStage(dt);
    }
    function frame(now) {
      raf = 0;
      if (!running || disposed) return;
      raf = rafFn(frame);
      tickSize();
      const t = typeof now === 'number' ? now : nowMs();
      let dt = (t - last) / 1000;
      if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
      if (dt > 0.05) dt = 0.05;
      last = t;
      step(dt);
    }
    function start() {
      if (disposed) return;
      if (!ready) applySize(false);
      if (running) return;
      running = true;
      last = nowMs();
      if (!raf) raf = rafFn(frame);
    }
    function stop() {
      running = false;
      if (raf) { cafFn(raf); raf = 0; }
      pending.length = 0;
    }
    function setParams(next) {
      if (disposed || !next || typeof next !== 'object') return;
      for (const k in next) {
        if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
        const meta = PMAP[k];
        if (!meta) continue;
        const v0 = Number(next[k]);
        if (!isFinite(v0)) continue;
        const v = clamp(v0, meta.min, meta.max);
        if (C[k] === v) continue;
        C[k] = v;
        if (meta.rebuild) rebuildQ[meta.rebuild] = 1;
      }
      dirty = true;
    }
    function getParams() { return { ...C }; }
    /** one-shot whole-turn rotation of the ring (turns defaults to 1 = 2π) */
    function revolve(turns) {
      if (disposed) return;
      const t = Number(turns);
      const n = isFinite(t) && t !== 0 ? t : 1;
      const dur = Math.max(0.05, num(C.revolveMs, 1500) / 1000);
      // restart from the current offset so repeated calls continue smoothly
      spin = { t: 0, dur, from: spinOffset, to: spinOffset + n * TAU };
      dirty = true;
    }
    /** read-only diagnostics (bench hooks) */
    function debug() {
      return {
        ringRot, spinOffset, env, out, mo,
        present, running: sessRunning,
        params: { ...C },
        /* extras, not part of the contract */
        switchT, switchDur, outerRev: spinOffset * clamp(num(C.revolveOuter, 1), 0, 1),
        outerBase: strandLayers[0]
          ? { off: strandLayers[0].off, revK: strandLayers[0].revK, rotK: strandLayers[0].rotK }
          : null,
        visMismatch: (() => {
          let n = 0;
          for (const Lr of strandLayers) {
            for (const w of Lr.wedges) {
              const am = normA((w.i0 + w.n / 2) * Lr.step + strandRot(Lr));
              if (w.vis !== (Math.abs(am) < thS + 0.2)) n++;
            }
          }
          return n;
        })(),
        target: !present ? clamp(num(C.voidLevel, 0), 0, 1)
          : (sessRunning ? clamp(num(C.runLevel, 1), 0.2, 2) : clamp(num(C.idleMotion, 0), 0, 1)),
        build: bld, activity: act, spinning: !!spin, loopRunning: running,
        cam: { x: cam.x, y: cam.y, z: cam.z },
      };
    }
    function resize() { if (!disposed) applySize(!ready); }
    function dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      release(webBase); webBase = null;
      if (webLayers && webLayers.length) webLayers.forEach(release);
      webLayers = [];
      release(trailC); trailC = null;
      release(glowC); glowC = null;
      release(laneC); laneC = null;
      release(farC); farC = null;
      release(frameC); frameC = null;
      release(bokehSpr); bokehSpr = null;
      for (const s of slots) release(s.c);
      curves = []; runners = []; comets = []; pulses = []; hazes = []; flares = [];
      flyers = []; flyBands = []; slots = []; shots = []; bokehs = []; strandLayers = []; wedges = [];
      tokPool = []; toolNames = []; pending = [];
      GR = {}; scanPatDark = null; scanPatLight = null; scanGrad = null; webDisc = null;
      S = null; S_MAIN = null;
      ready = false;
    }
    return {
      setParams,
      getParams,
      resize,
      start,
      stop,
      dispose,
      revolve,
      switchFx,
      debug,
      /* introspection for diagnostics / tests */
      isRunning: () => running,
      activity: () => act,
    };
  }

  return { create, PARAMS, BASE, PRESETS };
})();

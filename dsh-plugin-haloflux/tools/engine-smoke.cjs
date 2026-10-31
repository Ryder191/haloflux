/* Headless engine harness for dsh-haloflux/src/engine.js
   - fake DOM: canvas elements + recording 2D contexts (no rendering)
   - the visible canvas is modelled as a coarse pixel grid, so "fully transparent"
     (void state) can be asserted without a real rasteriser
   - drives the rAF loop manually at a fixed step
   Run: node tools/engine-smoke.cjs
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'engine.js');
const src = fs.readFileSync(SRC, 'utf8');

const BASE_W = 1440, BASE_H = 900, DPR = 2;
const PIX_W = BASE_W * DPR, PIX_H = BASE_H * DPR;
const TAU_STUB = Math.PI * 2;

/* ---------------- instrumentation ---------------- */
const darkFills = [];        // source-over dark painting on a composited surface
let opCount = 0;
let clearCount = 0;
let imgCount = 0;            // drawImage calls onto composited surfaces (panel reveal proxy)
let paintedCells = 0;        // cells painted on the VISIBLE canvas since its last clearRect
const CELLS = 90 * 56;       // coarse grid (16px cells)
const texts = [];            // every fillText string (ring panels draw on offscreen canvases)

function isDarkFill(style) {
  if (typeof style === 'string') {
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(style);
    if (m) return Math.max(+m[1], +m[2], +m[3]) <= 32;
    const h = /^#([0-9a-f]{6})$/i.exec(style);
    if (h) return parseInt(h[1].slice(0, 2), 16) <= 32;
    return false;
  }
  return !!style && typeof style === 'object';   // gradient / pattern painted source-over
}

/* a context is "composited" when it is the visible canvas itself or a buffer the size of it
   (the frame fade buffer, the lane buffer): everything painted there reaches the screen */
function isComposited(el, kind) {
  if (kind === 'main') return true;
  return el.width === PIX_W && el.height === PIX_H;
}

function makeCtx(el, kind) {
  const st = {
    fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', font: '', textAlign: 'left', textBaseline: 'alphabetic',
    filter: 'none', shadowBlur: 0,
  };
  const grad = { addColorStop() {} };
  const handler = {
    get(_t, k) {
      if (k === 'canvas') return null;
      if (k in st) return st[k];
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad;
      if (k === 'createPattern') return () => ({ __pattern: true });
      if (typeof k === 'symbol') return undefined;
      return (...args) => {
        opCount++;
        if (k === 'fillText') texts.push(String(args[0]));
        const visible = kind === 'main';
        if (visible) {
          if (k === 'clearRect') { clearCount++; paintedCells = 0; return undefined; }
          if (st.globalAlpha > 0.005 && st.globalCompositeOperation !== 'destination-out') {
            if (k === 'fillRect' && args.length >= 4) {
              const w = Math.abs(args[2] || 0), h = Math.abs(args[3] || 0);
              paintedCells = Math.min(CELLS, paintedCells + Math.max(1, Math.ceil(w * h / (16 * 16))));
            } else if (k === 'drawImage' || k === 'fill' || k === 'stroke' || k === 'fillText' || k === 'strokeRect') {
              paintedCells = CELLS;
            }
          }
        }
        if (!isComposited(el, kind)) return undefined;
        if (k === 'drawImage') { imgCount++; return undefined; }
        if (k !== 'fillRect' && k !== 'fill') return undefined;
        if (st.globalCompositeOperation === 'lighter' || st.globalCompositeOperation === 'destination-out') return undefined;
        if (st.globalAlpha <= 0.01) return undefined;
        if (isDarkFill(st.fillStyle)) {
          darkFills.push({ op: k, style: String(st.fillStyle), alpha: st.globalAlpha });
        }
        return undefined;
      };
    },
    set(_t, k, v) { st[k] = v; return true; },
  };
  return new Proxy({}, handler);
}

function makeCanvasEl(kind) {
  const el = { width: 0, height: 0, clientWidth: BASE_W, clientHeight: BASE_H };
  el.getBoundingClientRect = () => ({ width: BASE_W, height: BASE_H, left: 0, top: 0 });
  let ctx = null;
  el.getContext = () => { if (!ctx) ctx = makeCtx(el, kind); return ctx; };
  return el;
}

/* ---------------- sandbox ---------------- */
let rafCb = null, rafId = 0, pulls = 0, clock = 0;
const live = {
  activity: 0, tps: 0, totalTokens: 0, contextTokens: 0, running: false,
  tools: [], feed: [], tokenQueue: [],
  pullTokens(n) { pulls++; return ['alpha', 'beta', 'gamma'].slice(0, Math.min(n, 3)); },
};

const engineCanvas = makeCanvasEl('main');
const sandbox = {
  console,
  document: { createElement: (t) => (t === 'canvas' ? makeCanvasEl('off') : {}) },
  window: { devicePixelRatio: DPR },
  performance: { now: () => clock },          // engine time = the harness clock, so dt == stepMs
  requestAnimationFrame: (cb) => { rafCb = cb; return ++rafId; },
  cancelAnimationFrame: () => { rafCb = null; },
  Path2D: function () { return { moveTo() {}, lineTo() {} }; },
  Math, Date, Number, String, Object, Array, JSON, isFinite, setTimeout, clearTimeout,
  module: { exports: {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__E = HalofluxEngine;', sandbox, { filename: 'engine.js' });
const E = sandbox.__E;

/* ---------------- test driver ---------------- */
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) failures++; };
const note = (msg) => console.log('      ' + msg);
function drive(frames, stepMs = 50) {
  for (let i = 0; i < frames; i++) {
    const cb = rafCb;
    if (!cb) return false;
    clock += stepMs;
    cb(clock);
  }
  return true;
}
/** create + start an engine and capture ONLY its own frame callback */
function boot(opts) {
  const el = opts.canvas || makeCanvasEl('main');
  const eng = E.create({ canvas: el, live: opts.live, params: opts.params, onStats: opts.onStats });
  paintedCells = 0;
  eng.start();
  const cb = rafCb;
  rafCb = null;
  return {
    eng, el,
    tick(n = 1, stepMs = 1000 / 60) {
      for (let i = 0; i < n; i++) { clock += stepMs; cb(clock); }
    },
    kill() { eng.stop(); eng.dispose(); },
  };
}

/* ================= 1. metadata ================= */
ok(!!E && typeof E.create === 'function', 'HalofluxEngine.create is a function');
ok(E.PARAMS.length === 79, 'PARAMS count = 79 (got ' + E.PARAMS.length + ')');
const keys = E.PARAMS.map(p => p[0]);
ok(new Set(keys).size === keys.length, 'PARAMS keys are unique');
const groups = [...new Set(E.PARAMS.map(p => p[5]))];
ok(groups.join(',') === '全局,圆环,圈内,环外,空间层次,插件', 'groups + order = ' + groups.join(' | '));
const plug = E.PARAMS.filter(p => p[5] === '插件').map(p => p[0]);
ok(plug.join(',') === 'opacity,blend,idleMotion,activityGain,centerX,centerY,scale,hudOn,feedOn,dataMode,backdrop,'
  + 'runLevel,voidLevel,attackMs,releaseMs,revolveOnSwitch,revolveMs,easeCurve,'
  + 'revolveOuter,switchReveal,switchFlash,switchHue,switchCam',
  'plugin group = ' + plug.join(','));
const row = k => E.PARAMS.find(p => p[0] === k) || [];
const flag = k => row(k)[6];
ok(flag('ringWidth') === 'resize' && flag('rimWidth') === 'slots' && flag('webBright') === 'web'
  && flag('webBlur') === 'web' && flag('flyerCount') === 'flyers', 'rebuild flags preserved');
ok(E.PARAMS.filter(p => p[6]).length === 5, 'exactly 5 rebuild params');
ok(Object.keys(E.BASE).length === 79 && keys.every(k => k in E.BASE), 'BASE covers all 79 keys');
ok(row('idleMotion')[1] === '静默态强度', 'idleMotion label = 静默态强度');
ok(E.BASE.idleMotion === 0.06 && E.PRESETS.MINE.idleMotion === 0.06, 'idleMotion default = 0.06');
ok(E.BASE.camera === 1, 'BASE.camera untouched (still 1; mount turns it off)');
ok(E.BASE.runLevel === 1 && E.BASE.voidLevel === 0 && E.BASE.attackMs === 800 && E.BASE.releaseMs === 2600
  && E.BASE.revolveOnSwitch === 1 && E.BASE.revolveMs === 1500 && E.BASE.easeCurve === 1,
  'round-2 defaults = run 1 / void 0 / attack 800 / release 2600 / revolveOn 1 / revolve 1500 / curve 1');
ok(row('runLevel')[2] === 0.2 && row('runLevel')[3] === 2 && row('voidLevel')[3] === 1
  && row('attackMs')[2] === 100 && row('attackMs')[3] === 3000
  && row('releaseMs')[2] === 300 && row('releaseMs')[3] === 8000
  && row('revolveMs')[2] === 300 && row('revolveMs')[3] === 4000
  && row('easeCurve')[3] === 2, 'round-2 parameter ranges match the table');
ok(E.PRESETS.MINE.tempo === 2.5 && E.PRESETS.MINE.runnerCount === 788, 'PRESETS.MINE = author default');
ok(E.PRESETS.A.runnerCount === 45 && E.PRESETS.B.tempo === 1, 'PRESETS A/B intact');
ok(E.BASE.backdrop === 0, 'backdrop default 0 (transparent overlay)');
ok(row('dataMode')[2] === 0 && row('dataMode')[3] === 2 && row('dataMode')[4] === 1 && E.BASE.dataMode === 1,
  'dataMode is a 0/1/2 level, default 1 (mixed)');

/* ================= 2. create() / debug() ================= */
const ctxOpsBeforeCreate = opCount;
let eng = null;
try { eng = E.create({ canvas: engineCanvas, live, params: { idleMotion: 0.15 } }); }
catch (e) { console.log('      create threw: ' + e.message); }
ok(!!eng, 'create({canvas, live, params}) returns an engine');
ok(opCount === ctxOpsBeforeCreate, 'create() performs no canvas work (waits for start/resize)');
ok(['setParams', 'getParams', 'resize', 'start', 'stop', 'dispose', 'revolve', 'debug']
  .every(k => typeof eng[k] === 'function'), 'api includes revolve() and debug()');
ok(Object.keys(eng.getParams()).length === 79, 'getParams() returns the 79-key copy');
const dbgKeys = ['ringRot', 'spinOffset', 'env', 'out', 'mo', 'present', 'running'];
const d0 = eng.debug();
ok(dbgKeys.every(k => k in d0), 'debug() exposes ' + dbgKeys.join('/'));
ok(typeof d0.params === 'object' && Object.keys(d0.params).length === 79, 'debug().params is the 79-key copy');
ok(d0.present === true && d0.running === false && d0.env === 0 && d0.out === 0 && d0.mo === 0,
  'debug() initial: present (field missing ⇒ true), not running, level 0');

/* ================= 3. level 0 → render loop parks ================= */
eng.setParams({ idleMotion: 0, releaseMs: 60 });
eng.start();
ok(!!rafCb, 'start() schedules a frame');
drive(6);
const afterStatic = clearCount;
drive(10);
ok(clearCount === afterStatic, 'level 0 → render loop parks (no repaint, canvas keeps last frame)');
ok(pulls === 0, 'activity 0 → live.pullTokens() is never called');
ok(darkFills.length === 0, 'overlay mode: zero dark source-over fills on composited surfaces');

/* ================= 4. silent state (idleMotion 0.15) keeps drifting ================= */
eng.setParams({ idleMotion: 0.15 });
drive(30);                                   // 1.5s: level eases up to 0.15
ok(clearCount > afterStatic, 'silent level 0.15 → scene repaints');
ok(pulls === 0, 'still no token pull while activity is 0');
const dIdle = eng.debug();
ok(Math.abs(dIdle.env - 0.15) < 1e-9 && dIdle.out === 0.15 && dIdle.mo === 0.15,
  'silent state settles exactly on idleMotion (env=out=mo=0.15), got ' + dIdle.env.toFixed(4));

/* ================= 5. transparent vs backdrop ================= */
ok(darkFills.length === 0, 'transparent frame: no opaque base fill drawn');
eng.setParams({ backdrop: 1 });
drive(4);
ok(darkFills.length > 0, 'backdrop=1 reintroduces the original dark base (' + darkFills.length + ' dark fills)');
eng.setParams({ backdrop: 0 });
const darkBefore = darkFills.length;
drive(4);
ok(darkFills.length === darkBefore, 'backdrop back to 0 → transparent again');

/* ================= 6. activity smoothing (generation intensity) ================= */
live.tps = 42;
live.tools = [{ id: '1', name: 'read_file', state: 'running', t: 0 }];
live.activity = 1;
drive(4, 50);
ok(eng.activity() > 0.5, 'activity 0→1 rises fast (0.2s → ' + eng.activity().toFixed(3) + ')');
drive(20, 50);
ok(eng.activity() > 0.95, 'activity reaches ~1 (' + eng.activity().toFixed(3) + ')');
ok(pulls > 0, 'active session → live.pullTokens() called (' + pulls + 'x)');
live.activity = 0;
drive(4, 50);
ok(eng.activity() > 0.75, 'activity 1→0 falls slowly (0.2s → ' + eng.activity().toFixed(3) + ')');
drive(120, 50);
ok(eng.activity() < 0.02, 'activity decays to ~0');

/* ================= 7. TOK fallback / no pullTokens ================= */
(function () {
  let threw = false;
  try {
    const b = boot({ live: { activity: 0.8, tools: [] }, params: {} });
    b.tick(6);
    b.kill();
  } catch (e) { threw = true; console.log('      ' + e.stack.split('\n')[0]); }
  ok(!threw, 'engine survives a live object without pullTokens (falls back to original TOK list)');
})();

/* ================= 8. stop() / dispose() ================= */
const beforeStop = clearCount;
eng.stop();
drive(5);
ok(clearCount === beforeStop, 'stop() → no further frames are drawn (canvas keeps the last frame)');
ok(rafCb === null, 'stop() cancels the pending animation frame');
let threw3 = false;
try { eng.start(); eng.stop(); eng.resize(); eng.dispose(); eng.setParams({ tempo: 2 }); eng.getParams(); } catch (e) { threw3 = true; }
ok(!threw3, 'start/stop/resize/dispose are idempotent and safe after dispose()');

/* ================= 9. clamping / junk ================= */
ok(E.create({ canvas: makeCanvasEl() }).getParams().scale === 1, 'create() with no params uses author defaults');
const e4 = E.create({ canvas: makeCanvasEl() });
e4.setParams({ scale: 99, centerX: -99, bogus: 1, tempo: NaN, activityGain: '2', idleMotion: 5 });
const p4 = e4.getParams();
ok(p4.scale === 2.5 && p4.centerX === -2 && !('bogus' in p4) && p4.tempo === 2.5 && p4.activityGain === 2 && p4.idleMotion === 1,
  'setParams clamps to min/max, ignores unknown keys, tolerates NaN');
e4.setParams(null); e4.setParams('x'); e4.dispose();
let threw4 = false;
try { E.create({}); } catch (e) { threw4 = true; }
ok(threw4, 'create() without a canvas throws a clear error');

/* ================= 10. no session (voidLevel 0) → pixel-exact transparency ================= */
(function () {
  const lv = { activity: 0, tools: [], sessionPresent: false, running: false, pullTokens: () => [] };
  const b = boot({ live: lv, params: { voidLevel: 0, idleMotion: 0.4 } });
  b.tick(30, 1000 / 60);
  const d = b.eng.debug();
  ok(d.present === false && d.out === 0 && d.mo === 0, 'no session → present false, out/mo = 0');
  ok(paintedCells === 0, 'no session + voidLevel 0 → visible canvas is pixel-transparent (' + paintedCells + ' painted cells)');
  // voidLevel > 0 must give the "empty but breathing" look
  b.eng.setParams({ voidLevel: 0.5 });
  b.tick(60, 1000 / 60);
  const d2 = b.eng.debug();
  ok(d2.out === 0.5 && paintedCells > 0, 'voidLevel 0.5 → level 0.5 and the frame is drawn (' + paintedCells + ' cells)');
  // and back to transparent when the level drops again
  b.eng.setParams({ voidLevel: 0, releaseMs: 300 });
  b.tick(40, 1000 / 60);
  const d3 = b.eng.debug();
  ok(d3.out === 0 && paintedCells === 0, 'voidLevel back to 0 → transparent again within releaseMs (' + paintedCells + ' cells)');
  b.kill();
})();

/* ================= 11. attack / release timing + curve flatness ================= */
(function () {
  const lv = { activity: 1, tools: [], sessionPresent: true, running: false, pullTokens: () => [] };
  const b = boot({ live: lv, params: { idleMotion: 0.05, runLevel: 1, attackMs: 800, releaseMs: 2600, easeCurve: 1 } });
  b.tick(80, 1000 / 60);                        // settle at the silent level
  const STEP = 1000 / 60;
  const samples = [];
  const v0 = b.eng.debug().env;                 // level at t = 0 of the rise
  lv.running = true;
  let t = 0;
  for (let i = 0; i < 400; i++) { b.tick(1, STEP); t += STEP; samples.push({ t, v: b.eng.debug().env }); }
  const runLv = 1;
  const riseFull = samples.find(s => s.v >= runLv - 1e-9);
  ok(!!riseFull && Math.abs(riseFull.t - 800) <= 0.25 * 800,
    'rise 0 → runLevel takes ≈ attackMs (' + (riseFull ? riseFull.t.toFixed(0) : 'n/a') + 'ms, attackMs=800)');
  const t98 = samples.find(s => s.v >= 0.98 * runLv);
  note('for reference: 98% of runLevel at ' + (t98 ? t98.t.toFixed(0) : 'n/a') + 'ms, 63.2% at '
    + (samples.find(s => s.v >= v0 + 0.632 * (runLv - v0)) || {}).t + 'ms');

  // flatness of easeCurve = 1: rate in the first / last 100ms vs the average over the whole rise
  const at = (tt) => { const s = samples.find(x => x.t >= tt); return s ? s.v : samples[samples.length - 1].v; };
  const avg = (riseFull.v - v0) / (riseFull.t / 1000);
  const head = (at(100) - v0) / 0.1;
  const tail = (riseFull.v - at(riseFull.t - 100)) / 0.1;
  ok(head < 0.25 * avg && tail < 0.25 * avg,
    'easeCurve 1 flat ends: head ' + (100 * head / avg).toFixed(1) + '%, tail '
    + (100 * tail / avg).toFixed(1) + '% of the average rate');
  const mono = samples.every((s, i) => i === 0 || s.v >= samples[i - 1].v - 1e-12);
  ok(mono, 'level rises monotonically (no jumps)');

  // release: runLevel → idleMotion
  lv.running = false;
  const rel = [];
  t = 0;
  for (let i = 0; i < 400; i++) { b.tick(1, STEP); t += STEP; rel.push({ t, v: b.eng.debug().env }); }
  const fallDone = rel.find(s => s.v <= 0.05 + 1e-9);
  ok(!!fallDone && Math.abs(fallDone.t - 2600) <= 0.25 * 2600,
    'fall runLevel → idleMotion takes ≈ releaseMs (' + (fallDone ? fallDone.t.toFixed(0) : 'n/a') + 'ms, releaseMs=2600)');
  const avgF = (rel[0].v - rel[rel.length - 1].v) / (rel[rel.length - 1].t / 1000);
  const headF = (rel.find(s => s.t >= 100).v - rel[0].v) / 0.1;
  ok(Math.abs(headF) < 0.25 * Math.abs(avgF),
    'easeCurve 1 flat release start: ' + (100 * Math.abs(headF) / Math.abs(avgF)).toFixed(1) + '% of the average rate');
  b.kill();
})();

/* ================= 12. state levels: running / silent / void ================= */
(function () {
  const lv = { activity: 0, tools: [], sessionPresent: true, running: false, pullTokens: () => [] };
  const b = boot({ live: lv, params: { idleMotion: 0.06, runLevel: 1.4, voidLevel: 0, attackMs: 100, releaseMs: 300 } });
  b.tick(40, 1000 / 60);
  ok(Math.abs(b.eng.debug().env - 0.06) < 1e-9, 'silent target = idleMotion');
  lv.running = true;
  b.tick(40, 1000 / 60);
  ok(Math.abs(b.eng.debug().env - 1.4) < 1e-9, 'running target = runLevel (1.4)');
  lv.running = false;
  b.tick(40, 1000 / 60);
  ok(Math.abs(b.eng.debug().env - 0.06) < 1e-9, 'back to silent target');
  lv.sessionPresent = false;
  b.tick(40, 1000 / 60);
  ok(b.eng.debug().env === 0, 'no session target = voidLevel (0)');
  lv.sessionPresent = undefined;
  b.tick(40, 1000 / 60);
  ok(b.eng.debug().present === true, 'sessionPresent undefined ⇒ present (legacy callers)');
  b.kill();
})();

/* ================= 13. camera 0 → completely still ================= */
(function () {
  const lv = { activity: 1, tools: [], sessionPresent: true, running: true, pullTokens: () => [] };
  const b = boot({ live: lv, params: { camera: 0, attackMs: 100 } });
  b.tick(20, 1000 / 60);
  const c0 = b.eng.debug().cam;
  const r0 = b.eng.debug().ringRot;
  b.tick(60, 1000 / 60);
  const c1 = b.eng.debug().cam;
  const r1 = b.eng.debug().ringRot;
  ok(c0 && c0.x === BASE_W / 2 && c0.y === BASE_H / 2 && c0.z === 1
    && c1.x === c0.x && c1.y === c0.y && c1.z === c0.z,
    'camera 0 → camera transform never moves (x/y/z pinned)');
  ok(r1 !== r0, 'camera 0 does not freeze the ring itself');
  b.kill();
})();

/* ================= 14. revolve() ================= */
(function () {
  const lv = { activity: 0, tools: [], sessionPresent: true, running: false, pullTokens: () => [] };
  const b = boot({ live: lv, params: { idleMotion: 0.2, attackMs: 100, revolveMs: 1500 } });
  b.tick(20, 1000 / 60);
  const STEP = 1000 / 60;
  const before = b.eng.debug().spinOffset;
  b.eng.revolve(1);
  ok(b.eng.debug().spinning === true, 'revolve(1) starts a one-shot spin');
  let maxSpin = 0, t = 0, done = null;
  const trace = [];
  for (let i = 0; i < 200; i++) {
    b.tick(1, STEP); t += STEP;
    const d = b.eng.debug();
    if (!d.spinning) { done = t; break; }        // final tick has already wrapped to 0
    trace.push(d.spinOffset);
    if (d.spinOffset > maxSpin) maxSpin = d.spinOffset;
  }
  ok(maxSpin > TAU_STUB * 0.97, 'spinOffset reaches a full turn (' + (maxSpin / TAU_STUB).toFixed(3) + ' × 2π)');
  ok(done !== null && Math.abs(done - 1500) <= 0.25 * 1500,
    'revolve takes ≈ revolveMs (' + (done === null ? 'n/a' : done.toFixed(0)) + 'ms, revolveMs=1500)');
  ok(Math.abs(b.eng.debug().spinOffset) < 1e-9, 'spinOffset wraps back to 0 after the full turn (no jump)');
  const mono = trace.every((v, i) => i === 0 || v >= trace[i - 1] - 1e-9);
  ok(mono, 'spin is monotonic (ease-in-out, no jumps)');
  // idempotent restart from the current offset
  b.eng.revolve(1);
  b.tick(30, STEP);
  const mid = b.eng.debug().spinOffset;
  b.eng.revolve(1);
  const afterRestart = b.eng.debug().spinOffset;
  ok(Math.abs(afterRestart - mid) < 1e-9, 'repeated revolve() continues from the current offset (no jump)');
  ok(before === 0, 'spinOffset starts at 0');
  b.kill();
})();

/* ================= 15. build-up is structural, not only a global alpha ================= */
(function () {
  const lv = { activity: 1, tools: [], sessionPresent: true, running: true, pullTokens: () => [] };
  const b = boot({ live: lv, params: { attackMs: 3000, easeCurve: 0, runLevel: 1, idleMotion: 0 } });
  b.tick(2, 1000 / 60);
  const dbgLow = b.eng.debug();
  const imgBefore = imgCount;
  b.tick(8, 1000 / 60);
  const imgLow = (imgCount - imgBefore) / 8;         // panel draws per frame at a low level
  b.tick(400, 1000 / 60);                            // reach full level
  const dbgHigh = b.eng.debug();
  const imgBefore2 = imgCount;
  b.tick(40, 1000 / 60);
  const imgHigh = (imgCount - imgBefore2) / 40;      // panel draws per frame at full level
  ok(dbgLow.build < dbgHigh.build && dbgHigh.build > 0.99,
    'build progress follows the level (' + dbgLow.build.toFixed(3) + ' → ' + dbgHigh.build.toFixed(3) + ')');
  ok(imgLow < imgHigh * 0.7,
    'low level reveals structurally fewer ring panels (' + imgLow.toFixed(1) + ' vs ' + imgHigh.toFixed(1)
    + ' panel draws per frame)');
  b.kill();
})();

/* ================= 16. particle production still gated by live.activity ================= */
(function () {
  const lv = { activity: 0, tps: 0, tools: [], sessionPresent: true, running: false, pullTokens: () => [] };
  const stats = [];
  const b = boot({ live: lv, params: { idleMotion: 0.2, attackMs: 100 }, onStats: (s) => stats.push(s) });
  b.tick(60, 50);
  const idleMin = stats[stats.length - 1].particles;
  let mono = true;
  for (let i = 1; i < stats.length; i++) if (stats[i].particles > stats[i - 1].particles) mono = false;
  ok(stats.length >= 4, 'onStats fires ~2Hz (' + stats.length + ' callbacks in 3s)');
  ok(mono, 'activity 0 → particle count never grows (' + stats.map(s => s.particles).join('→') + ')');
  lv.activity = 1;
  b.tick(60, 50);
  const last = stats[stats.length - 1];
  ok(last.particles > idleMin, 'activity 1 → particles produced again (' + idleMin + ' → ' + last.particles + ')');
  ok(typeof last.fps === 'number' && last.fps > 0 && last.activity >= 0.99,
    'onStats payload {fps, particles, activity} = {' + last.fps + ', ' + last.particles + ', ' + last.activity + '}');
  b.kill();
})();

/* ================= 17. dataMode: 0 pure animation / 1 mixed / 2 full capture ================= */
(function () {
  // strings that exist only in the original HALOFLUX sample data / this port's fallback lists
  const FAKE = ['extract_eq', 'load_collection()', 'CFL', 'CAL/02', 'CHUNK 07', 'RESIDUAL', 'GRID 64x64',
    'frac', 'read', 'build', 'review', 'qa', 'sync', 'diff'];
  const fakeHits = () => texts.filter((t) => FAKE.indexOf(t) >= 0).length;

  // A) level 2 while tokens stream: the ring shows only real session content
  let pullsA = 0;
  const lv = {
    activity: 1, tps: 42, totalTokens: 1200, contextTokens: 64000, step: 3, turn: 1,
    tools: [{ id: '1', name: 'Bash', state: 'ok', t: 0 }],
    sessionPresent: true, running: true,
    pullTokens: (n) => { pullsA++; return ['真实词元'].slice(0, Math.max(0, n)); },
  };
  const b = boot({ live: lv, params: { dataMode: 2, opacity: 1, attackMs: 100 } });
  texts.length = 0;
  b.tick(60, 1000 / 60);
  ok(texts.indexOf('真实词元') >= 0, 'level 2: ring panels draw the live token text');
  ok(fakeHits() === 0, 'level 2: no original sample vocabulary on the canvas (' + fakeHits() + ' hits)');
  ok(texts.some((t) => /^STEP 3$/.test(t)), 'level 2: panel headers use the real step number');
  ok(texts.some((t) => t === 'tok/s' || t === 'ctx' || t === 'step'), 'level 2: kv panels use real metric keys');
  b.kill();

  // B) level 2 with no live data at all: nothing synthetic may appear
  const lv2 = {
    activity: 1, tps: 0, totalTokens: 0, contextTokens: 0, step: 0, turn: 0, model: '',
    tools: [], sessionPresent: true, running: true, pullTokens: () => [],
  };
  const b2 = boot({ live: lv2, params: { dataMode: 2, attackMs: 100 } });
  texts.length = 0;
  b2.tick(60, 1000 / 60);
  ok(fakeHits() === 0, 'level 2 + empty session: still no sample vocabulary (' + fakeHits() + ' hits)');
  ok(texts.filter((t) => /^[0-9.]+%$/.test(t)).length === 0, 'level 2: no synthetic percentages');
  ok(texts.filter((t) => /^\d{2,3}$/.test(t)).length === 0, 'level 2: no synthetic id numbers');
  b2.kill();

  // C) level 1 (the shipped look): original vocabulary still fills panels with no tokens
  const lv3 = {
    activity: 0.6, tps: 0, totalTokens: 0, contextTokens: 0, step: 0, turn: 0,
    tools: [], sessionPresent: true, running: true, pullTokens: () => [],
  };
  const b3 = boot({ live: lv3, params: { dataMode: 1, idleMotion: 0.6, attackMs: 100 } });
  texts.length = 0;
  b3.tick(60, 1000 / 60);
  ok(fakeHits() > 0, 'level 1: original sample vocabulary still fills panels (' + fakeHits() + ' hits)');
  b3.kill();

  // D) level 0 (pure animation): never reads the session, draws the original data
  let pullsD = 0;
  const lv4 = {
    activity: 1, tps: 42, totalTokens: 1200, contextTokens: 64000, step: 3, turn: 1,
    tools: [{ id: '1', name: 'Bash', state: 'ok', t: 0 }],
    sessionPresent: true, running: true,
    pullTokens: (n) => { pullsD++; return ['真实词元'].slice(0, Math.max(0, n)); },
  };
  const b4 = boot({ live: lv4, params: { dataMode: 0, idleMotion: 0.6, attackMs: 100 } });
  texts.length = 0;
  b4.tick(60, 1000 / 60);
  ok(pullsD === 0, 'level 0: live.pullTokens() is never called (' + pullsD + ' calls)');
  ok(texts.indexOf('真实词元') < 0, 'level 0: no session token reaches the canvas');
  ok(fakeHits() > 0, 'level 0: original sample vocabulary fills the panels (' + fakeHits() + ' hits)');
  b4.kill();
})();

/* ================= 18. session-switch effects (all switchable) ================= */
(function () {
  const lv = {
    activity: 1, tps: 10, tools: [{ id: '1', name: 'Bash', state: 'ok', t: 0 }],
    sessionPresent: true, running: true, pullTokens: (n) => ['tok'].slice(0, Math.max(0, n)),
  };
  const b = boot({ live: lv, params: { attackMs: 100 } });
  b.tick(30, 1000 / 60);
  ok(typeof b.eng.switchFx === 'function', 'engine exposes switchFx()');

  b.eng.switchFx(1.0);
  ok(b.eng.debug().switchT === 0, 'switchFx() opens the switch window');
  b.tick(20, 1000 / 60);
  const mid = b.eng.debug();
  ok(mid.switchT > 0 && mid.switchT < 1, 'switch window advances with time (' + mid.switchT.toFixed(3) + 's)');

  // own toggle: the outer light field follows the ring spin only when enabled
  b.eng.setParams({ revolveOuter: 1 });
  b.eng.revolve(1);
  b.tick(2, 1000 / 60);
  let d = b.eng.debug();
  ok(Math.abs(d.outerRev - d.spinOffset) < 1e-9, 'revolveOuter=1: outer field equals the ring spin offset');
  b.eng.setParams({ revolveOuter: 0 });
  b.tick(2, 1000 / 60);
  d = b.eng.debug();
  ok(Math.abs(d.outerRev) < 1e-9 && Math.abs(d.spinOffset) > 0,
    'revolveOuter=0: the ring still spins, the outer field stays put');

  b.tick(90, 1000 / 60);
  ok(b.eng.debug().switchT === -1, 'switch window closes after its duration');
  b.kill();
})();

console.log('\nopCount=' + opCount + ' clearRects=' + clearCount + ' darkFills=' + darkFills.length
  + ' paintedCells=' + paintedCells);
console.log(failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);

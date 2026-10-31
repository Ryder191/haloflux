/* Headless assembly harness for dsh-haloflux/client.js
   - fakes `window.__ModuleLoader__`, React and the slot service
   - runs the bundle factory + plugin.apply(ctx)
   - asserts both registrations (shell.overlay + settings.section) and the
     shared parameter store defaults
   Run: node tools/client-smoke.cjs
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'client.js');
const src = fs.readFileSync(SRC, 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) failures++; };

/* ---------------- fake browser ---------------- */
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const loaded = [];
const window = {
  __ModuleLoader__: { load: (opts) => { loaded.push(opts); } },
  localStorage,
  matchMedia: () => ({ matches: false }),
  devicePixelRatio: 2,
  addEventListener() {}, removeEventListener() {},
};
const document = {
  addEventListener() {}, removeEventListener() {},
  documentElement: { hasAttribute: () => false },
  createElement: () => ({ getContext: () => null, style: {}, classList: { add() {}, remove() {} } }),
};

/* ---------------- minimal React ---------------- */
let hookState = [];
function createElement(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length ? { children } : null) };
}
const ReactStub = {
  createElement,
  memo: (fn) => fn,
  Fragment: 'Fragment',
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useRef(init) { return { current: init }; },
  useEffect() {},
  useLayoutEffect() {},
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useSyncExternalStore(_sub, get) { return get(); },
};

const sandbox = {
  window, document, localStorage, navigator: { language: 'zh-CN', clipboard: undefined },
  console, setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  Math, Date, Number, String, Object, Array, JSON, isFinite, isNaN, Map, Set, Promise, Error,
  Path2D: function () { return {}; },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'client.js' });

ok(loaded.length === 1, 'client.js registers exactly one module (' + loaded.length + ')');
ok(loaded[0] && loaded[0].id === 'dsh-haloflux', 'module id = dsh-haloflux');

const plugin = loaded[0].factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error('unexpected require: ' + name);
});
ok(plugin && typeof plugin.apply === 'function', 'factory returns a plugin with apply()');
ok(Array.isArray(plugin.inject) && plugin.inject.indexOf('slots') >= 0, 'plugin injects the slots service');

/* ---------------- fake slot service ---------------- */
const registered = [];
const injected = [];
const t = (key) => key;
const ctx = {
  get(name) {
    if (name === 'locale') return { register() {}, getLocale: () => ({ locale: 'zh' }) };
    return undefined;
  },
  slots: {
    inject(name, register) { injected.push(name); register(); },
    register(opts, component) { registered.push({ opts, component }); return () => {}; },
  },
};

let threw = null;
try { plugin.apply(ctx); } catch (e) { threw = e; }
ok(!threw, 'apply() runs without throwing' + (threw ? ' (' + threw.message + ')' : ''));
ok(injected.indexOf('shell.overlay') >= 0 && injected.indexOf('settings.section') >= 0,
  'waits for both slots: ' + injected.join(', '));
ok(registered.length === 2, 'registers two slot entries (' + registered.length + ')');

const overlay = registered.find((r) => r.opts.name === 'shell.overlay');
const settings = registered.find((r) => r.opts.name === 'settings.section');
ok(!!overlay && overlay.opts.id === 'haloflux' && overlay.opts.order === -10, 'overlay row: haloflux, order -10');
ok(!!settings && settings.opts.id === 'haloflux' && settings.opts.order === 50, 'settings row: haloflux, order 50');
ok(typeof settings.opts.label === 'function' && settings.opts.label() !== 'ui.sectionLabel',
  'settings nav label is localized (' + settings.opts.label() + ')');
ok(typeof overlay.component === 'function' && typeof settings.component === 'function', 'both registrations carry components');

/* ---------------- the shared store, assembled from src/ ---------------- */
// client.js keeps the fragments inside the loader factory, so the store is not a
// global there; assemble engine.js + state.js directly to exercise it.
const fragments = ['engine.js', 'state.js'].map((name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8')).join('\n;\n');
const storeSandbox = Object.assign({}, sandbox, { window: Object.assign({}, window, { localStorage }) });
storeSandbox.globalThis = storeSandbox;
vm.createContext(storeSandbox);
vm.runInContext(fragments + '\n; globalThis.__HalofluxState = HalofluxState;', storeSandbox, { filename: 'state-harness.js' });
const S = storeSandbox.__HalofluxState;
ok(!!S, 'HalofluxState assembles from src/engine.js + src/state.js');
const params = S.get();
ok(params.dataMode === 1, 'default dataMode = 1 (mixed, the shipped look)');
ok(params.opacity === 0.45 && params.scale === 0.6, 'store applies the port composition defaults');
S.set({ dataMode: 2 });
ok(S.get().dataMode === 2, 'set() updates the shared store');
const raw = JSON.parse(store.get('dsh-haloflux:params:v2'));
ok(raw && raw.dataMode === 2, 'set() persists to localStorage');
S.resetDefault();
ok(S.get().dataMode === 1, 'resetDefault() restores dataMode 1');

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);

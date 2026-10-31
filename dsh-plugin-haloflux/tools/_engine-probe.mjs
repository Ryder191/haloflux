import fs from 'node:fs';
import vm from 'node:vm';

const proxy = new Proxy(function () {}, {
  get(t, k) { if (k === 'width' || k === 'height') return 1; if (k === Symbol.toPrimitive) return () => 0; return proxy; },
  set() { return true; },
  apply() { return proxy; },
  has() { return true; },
});
const canvasEl = { width: 0, height: 0, getContext: () => proxy, style: {}, getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {} };
const sandbox = {
  document: { createElement: () => canvasEl, documentElement: { hasAttribute: () => false } },
  window: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) },
  performance: { now: () => 0 },
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  console,
  Math, JSON, Date, Number, String, Array, Object, parseInt, parseFloat, isNaN, Infinity, NaN, Set, Map, WeakMap, Symbol, Uint8ClampedArray, Float32Array,
};
const ctx = vm.createContext(sandbox);
vm.runInContext('const React={createElement(){}};' + fs.readFileSync('src/engine.js', 'utf8') + `
globalThis.OUT = {
  n: HalofluxEngine.PARAMS.length,
  keys: HalofluxEngine.PARAMS.map(p => p[0]),
  groups: [...new Set(HalofluxEngine.PARAMS.map(p => p[5]))],
  hasCreate: typeof HalofluxEngine.create === "function",
  baseKeys: Object.keys(HalofluxEngine.BASE).length,
  presets: Object.keys(HalofluxEngine.PRESETS),
};`, ctx, { timeout: 20000 });
const o = sandbox.OUT;
console.log('PARAMS count:', o.n, '| create:', o.hasCreate, '| BASE keys:', o.baseKeys, '| presets:', o.presets.join(','));
console.log('groups:', o.groups.join(' / '));
const dup = o.keys.filter((k, i) => o.keys.indexOf(k) !== i);
console.log('duplicate keys:', dup.length ? dup.join(',') : 'none');
const plugin = o.keys.slice(-10);
console.log('plugin tail:', plugin.join(','));

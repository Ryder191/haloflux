/* Regression test for session switching.
 *
 * Bug it guards: switching from one running Session to another used to clear
 * live.running inside resetSessionState(), and the mounting layer only pushes
 * the status when its value changes — running -> running is not a change, so
 * the ring stayed at the idle level and the frame collapsed.
 *
 * Run: node tools/session-switch.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'live.js');
const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  Math, Date, Number, String, Object, Array, JSON, isFinite, isNaN, Map, Set, Error,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8') + '\n;globalThis.__create = createHalofluxLive;', sandbox, { filename: 'live.js' });
const create = sandbox.__create;

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) failures++; };

/** one Session feed: starts empty, then appends transient text-delta frames */
function makeSource() {
  const listeners = new Set();
  let revision = 0;
  let attempt = 0;
  let snap = { entries: [], hasMore: false, revision: 0 };
  return {
    listeners,
    getSnapshot: () => snap,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    emit(text) {
      attempt += 1;
      const entry = {
        type: 'transient',
        event: {
          type: 'assistant/live-chunk', seq: revision + 1,
          data: { attemptId: 'a' + attempt, turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
        },
      };
      revision += 1;
      snap = { entries: snap.entries.concat([entry]), hasMore: false, revision: revision, change: { kind: 'append', entries: [entry] } };
      for (const fn of Array.from(listeners)) { try { fn(); } catch { /* isolate */ } }
    },
  };
}

const s1 = makeSource();
const s2 = makeSource();
const bindings = {
  S1: { sessionId: 'S1', session: { getSnapshot: () => ({ running: true }) }, eventSource: s1 },
  S2: { sessionId: 'S2', session: { getSnapshot: () => ({ running: true }) }, eventSource: s2 },
};
let current = 'S1';
const live = create({ getSessionId: () => current, bindingOf: (id) => bindings[id] });

live.setSession('S1');
live.setRunning(true);
s1.emit('S1TOKEN');
const first = live.pullTokens(16).join('');
ok(first.indexOf('S1TOKEN') >= 0, 'session 1 feeds its own tokens (' + JSON.stringify(first) + ')');
ok(live.running === true, 'session 1 is running');

/* the switch: the status hook pushes nothing, because running -> running */
current = 'S2';
live.setSession('S2');

ok(live.running === true, 'running survives a running -> running switch (core regression)');

s2.emit('S2TOKEN');
const second = live.pullTokens(16).join('');
ok(second.indexOf('S2TOKEN') >= 0, 'session 2 feeds its own tokens (' + JSON.stringify(second) + ')');
ok(second.indexOf('S1TOKEN') < 0, 'session 1 tokens are gone after the switch (content swaps)');
ok(live.totalTokens > 0, 'token counters restart from the new Session');

/* the old source must be released, the new one subscribed */
ok(s1.listeners.size === 0, 'old event source unsubscribed (' + s1.listeners.size + ' listeners)');
ok(s2.listeners.size === 1, 'new event source subscribed (' + s2.listeners.size + ' listeners)');

/* and an explicit idle push still works */
live.setRunning(false);
ok(live.running === false, 'the layer can still push the idle state');

live.dispose();
console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);

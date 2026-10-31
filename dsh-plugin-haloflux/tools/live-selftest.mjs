/**
 * HALOFLUX — live.js self test (not shipped; tools/ only).
 *
 * Loads src/live.js as a plain script fragment (no module syntax) and drives it
 * with a fake host: a fake SessionBinding whose eventSource can be fed append /
 * prepend / replace / settle-assistant frames by hand.
 *
 *   node tools/live-selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src', 'live.js');

/* ---------------- load the fragment ---------------- */

const source = fs.readFileSync(SRC, 'utf8');
if (/\b(import|export)\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''))) {
  console.error('FAIL: live.js contains import/export');
  process.exit(1);
}
const createHalofluxLive = new Function(source + '\nreturn createHalofluxLive;')();

/* ---------------- fake host ---------------- */

class FakeEventSource {
  constructor(label) {
    this.label = label;
    this.listeners = new Set();
    this.entries = [];
    this.revision = 0;
    this.hasMore = false;
    this.change = { kind: 'replace', entries: [] };
    this.subscribeCount = 0;
    this.unsubscribeCount = 0;
  }
  get listenerCount() { return this.listeners.size; }
  getSnapshot() {
    return {
      entries: this.entries.slice(),
      hasMore: this.hasMore,
      revision: this.revision,
      change: this.change,
    };
  }
  subscribe(fn) {
    this.listeners.add(fn);
    this.subscribeCount += 1;
    return () => { this.listeners.delete(fn); this.unsubscribeCount += 1; };
  }
  publish(change) {
    this.change = change;
    this.revision += 1;
    for (const fn of [...this.listeners]) { try { fn(); } catch (err) { console.error('listener threw', err); } }
  }
  append(entry) { this.entries.push(entry); this.publish({ kind: 'append', entries: [entry] }); }
  prepend(list) { this.entries = [...list, ...this.entries]; this.publish({ kind: 'prepend', entries: list }); }
  replace(list) { this.entries = list.slice(); this.publish({ kind: 'replace', entries: list }); }
  settleAssistant(attemptId, entry) {
    this.entries = this.entries.filter((e) => !(e.type === 'transient' && String(e.event.data.attemptId) === String(attemptId)));
    if (entry) this.entries.push(entry);
    this.publish({ kind: 'settle-assistant', attemptId, entry });
  }
  durableCursor() {
    let cursor = -1;
    for (const e of this.entries) {
      if (e.type === 'event' && typeof e.event.seq === 'number') cursor = Math.max(cursor, e.event.seq);
    }
    return cursor;
  }
}

const projections = {
  title: 'HALOFLUX selftest session',
  modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-v4-flash' }, next: null },
  contextPressure: { projectedTokens: 12345, contextWindow: 65536 },
  tokenUsage: { uncachedInputTokens: 500, outputTokens: 90, cacheReadTokens: 300, cacheWriteTokens: 0 },
};

function makeBinding(label) {
  const eventSource = new FakeEventSource(label);
  const session = {
    getSnapshot: () => ({ sessionId: label, running: false, blank: false, openState: 'open' }),
    projections: { faceOf: (key) => ({ getSnapshot: () => projections[key] }) },
  };
  return { sessionId: label, session, eventSource, ctx: null };
}

const sessions = { S1: makeBinding('S1') };
let currentId = 'S1';
let bindingVisible = false;   // binding arrives late -> polling fallback

const live = createHalofluxLive({
  getSessionId: () => currentId,
  bindingOf: (id) => (bindingVisible ? sessions[id] : undefined),
});

/* ---------------- helpers ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(label, ok, detail) {
  (ok ? console.log : (m) => { failures.push(m); console.log(m); })(
    `${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`,
  );
}

let seq = 0;
function durable(type, data) {
  seq += 1;
  return { type: 'event', event: { type, seq, time: Date.now(), data } };
}

let attemptCount = 0;
function streamText(source, attemptId, turn, step, text) {
  const pieces = [];
  for (let i = 0; i < text.length; i += 6) pieces.push(text.slice(i, i + 6));
  let n = 0;
  for (const piece of pieces) {
    n += 1;
    const cursor = source.durableCursor();
    source.append({
      type: 'transient',
      event: {
        type: 'assistant/live-chunk',
        seq: cursor + 1 - 1 / (n + 1),
        time: Date.now(),
        data: { attemptId, turn, step, chunk: { type: 'text-delta', index: 0, text: piece } },
      },
    });
  }
  return pieces.length;
}

/* ---------------- scenario ---------------- */

const RICH = 'Haloflux 实时词元流接入测试：token queue 应当收到这些可显示片段，tps 滑窗统计 2 秒。';
const t0 = Date.now();

console.log('--- phase 1: late binding (polling fallback) + history seeding ---');
await sleep(150);
check('stays unbound while the host exposes no binding', sessions.S1.eventSource.listenerCount === 0,
  `listeners=${sessions.S1.eventSource.listenerCount}`);
check('live survives an eventSource-less host', typeof live.activity === 'number', `activity=${live.activity}`);

// history that predates the mount: must arrive as readable feed, never as tokens
sessions.S1.eventSource.append(durable('user/message', { role: 'user', content: [{ type: 'text', text: 'prompt sent before the plugin mounted' }] }));
sessions.S1.eventSource.append(durable('turn/end', { turn: 1, reason: { kind: 'completed' } }));

bindingVisible = true;
const bindWaitStart = Date.now();
while (sessions.S1.eventSource.listenerCount === 0 && Date.now() - bindWaitStart < 800) await sleep(25);
const bindLatency = Date.now() - bindWaitStart;
check('late binding acquired by the 200ms poll', sessions.S1.eventSource.listenerCount === 1,
  `latency=${bindLatency}ms listeners=${sessions.S1.eventSource.listenerCount}`);
check('projections read into live', live.model === 'deepseek-v4-flash' && live.contextLimit === 65536 && live.sessionTitle === 'HALOFLUX selftest session',
  `model=${live.model} limit=${live.contextLimit} title=${JSON.stringify(live.sessionTitle)}`);
check('history seeded into feed on first bind',
  live.feed.some((f) => f.kind === 'user' && /mounted/.test(f.text)) && live.feed.some((f) => f.kind === 'turn' && /completed/.test(f.text)),
  JSON.stringify(live.feed.map((f) => f.text)));
check('history did not fabricate tokens', live.totalTokens === 0);

console.log('--- phase 2: live stream ---');
const s1 = sessions.S1.eventSource;
s1.append(durable('turn/start', { turn: 1 }));
s1.append(durable('step/start', { turn: 1, step: 1 }));
s1.append(durable('user/message', { role: 'user', content: [{ type: 'text', text: '跑一下自测' }] }));
live.setRunning(true);
await sleep(170);
check('activity ramped to 1 (rise ~120ms)', live.activity === 1, `activity=${live.activity.toFixed(3)}`);

const attemptId = `a${(attemptCount += 1)}`;
const frames = streamText(s1, attemptId, 1, 1, RICH);
check('text-deltas produced display tokens', live.totalTokens > 0, `totalTokens=${live.totalTokens}`);
const queueAfterStream = live.tokenQueue.length;
check('tokenQueue capped at 512', queueAfterStream <= 512, `len=${queueAfterStream}`);
check('tps > 0 during stream', live.tps > 0, `tps=${live.tps.toFixed(1)}`);
const tpsDuringStream = live.tps;
check('activity stays at 1 while streaming', live.activity === 1, `activity=${live.activity.toFixed(3)}`);
check('every queued token is a 1..8 char string',
  live.tokenQueue.every((s) => typeof s === 'string' && s.length >= 1 && s.length <= 8),
  `sample=${JSON.stringify(live.tokenQueue.slice(0, 6))}`);
check('recentTokens mirrors the streamed tokens',
  live.recentTokens.length === live.totalTokens && live.recentTokens.length > 0,
  `recentTokens=${live.recentTokens.length} totalTokens=${live.totalTokens}`);
check('recentText re-joins chunks into readable text',
  typeof live.recentText === 'string' && /Haloflux/.test(live.recentText) && live.recentText.length <= 160,
  JSON.stringify(live.recentText));

const seenTokens = live.totalTokens;

console.log('--- phase 3: tool call -> result ---');
s1.append(durable('tool/call', { turn: 1, step: 1, callId: 'call_1', name: 'Bash', arguments: '{"command":"ls -la"}' }));
check('tool registered running', live.tools.length === 1 && live.tools[0].state === 'running',
  JSON.stringify(live.tools.map((t) => `${t.name}:${t.state}`)));
s1.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: s1.durableCursor() + 0.5, time: Date.now(), data: { attemptId: 'a2', turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 1, id: 'call_2', name: 'Grep', argumentsDelta: '{"pattern":' } } } });
check('tool-call-delta registered running', live.tools.some((t) => t.id === 'call_2' && t.state === 'running'),
  JSON.stringify(live.tools.map((t) => `${t.name}:${t.state}`)));
s1.append(durable('tool/result', {
  turn: 1, step: 1,
  message: { role: 'tool', toolCallId: 'call_1', source: { callId: 'call_1', name: 'Bash' }, content: [{ type: 'text', text: 'ok' }] },
}));
check('tool migrated running -> ok', live.tools.some((t) => t.id === 'call_1' && t.state === 'ok'),
  JSON.stringify(live.tools.map((t) => `${t.name}:${t.state}`)));

console.log('--- phase 4: settlement + usage (double-count guard) ---');
const settlement = durable('assistant/message', {
  turn: 1, step: 1,
  message: { role: 'assistant', content: [{ type: 'text', text: RICH }] },
  stream: [],
  usage: { inputTokens: 1200, outputTokens: 40, totalTokens: 1240 },
});
s1.settleAssistant(attemptId, settlement);
check('assistant/message did not re-tokenise', live.totalTokens === seenTokens, `totalTokens=${live.totalTokens} (was ${seenTokens})`);
check('usage applied', live.inputTokens === 1200 && live.outputTokens === 40 && live.contextTokens === 1240 - 40,
  `in=${live.inputTokens} out=${live.outputTokens} ctx=${live.contextTokens}`);

console.log('--- phase 5: prepend (older history) must not re-count ---');
const beforePrepend = live.totalTokens;
const queueBeforePrepend = live.tokenQueue.length;
s1.prepend([
  durable('user/message', { role: 'user', content: [{ type: 'text', text: 'older prompt' }] }),
  { type: 'transient', event: { type: 'assistant/live-chunk', seq: -2, time: Date.now(), data: { attemptId: 'old', turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'older streamed text' } } } },
]);
check('prepend ignored for tokens', live.totalTokens === beforePrepend && live.tokenQueue.length === queueBeforePrepend,
  `totalTokens=${live.totalTokens} queue=${live.tokenQueue.length}`);

const toolsAfterStream = live.tools.map((t) => `${t.name}:${t.state}`).join(',');

console.log('--- phase 5b: same-session rebind mid-stream must not re-count ---');
s1.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: s1.durableCursor() + 0.5, time: Date.now(), data: { attemptId: 'phantom', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'phantom streamed text' } } } });
const tokensBeforeRebind = live.totalTokens;
const queueBeforeRebind = live.tokenQueue.length;
const feedBeforeRebind = live.feed.length;
bindingVisible = false;
await sleep(260);
check('binding released while the host hides it', s1.listenerCount === 0, `listeners=${s1.listenerCount}`);
bindingVisible = true;
const reWait = Date.now();
while (s1.listenerCount === 0 && Date.now() - reWait < 800) await sleep(25);
check('binding re-acquired when it reappears', s1.listenerCount === 1, `latency=${Date.now() - reWait}ms listeners=${s1.listenerCount}`);
check('rebind replayed the window without re-counting tokens',
  live.totalTokens === tokensBeforeRebind && live.tokenQueue.length === queueBeforeRebind,
  `totalTokens=${live.totalTokens} (was ${tokensBeforeRebind}) queue=${live.tokenQueue.length} (was ${queueBeforeRebind})`);
check('rebind did not duplicate the feed', live.feed.length === feedBeforeRebind,
  `feed=${live.feed.length} (was ${feedBeforeRebind})`);

console.log('--- phase 6: activity tail (1.5s) then falloff (~1.2s) ---');
// a fresh burst anchors the "tokens arrived within 1.5s" tail rule
streamText(s1, 'tail', 1, 1, '尾巴测试');
live.setRunning(false);
await sleep(1200);
check('activity stays 1 inside the 1.5s token tail', live.activity === 1, `activity=${live.activity.toFixed(3)}`);
await sleep(400);   // tail expired
const curve = [];
const fallStart = Date.now();
for (let i = 0; i <= 14; i += 1) {
  curve.push({ ms: Date.now() - fallStart, a: live.activity });
  if (i < 14) await sleep(100);
}
console.log('    activity falloff: ' + curve.map((p) => `${String(p.ms).padStart(4)}ms=${p.a.toFixed(3)}`).join('  '));
check('activity fell back to 0 within ~1.4s', live.activity === 0, `activity=${live.activity.toFixed(3)}`);
const start = curve[0].a;
const worst = curve.reduce((acc, p) => {
  const expected = Math.max(0, start - p.ms / 1200);
  return Math.max(acc, Math.abs(p.a - expected));
}, 0);
check('falloff follows the ~1.2s envelope', worst < 0.08, `max deviation=${worst.toFixed(3)} start=${start.toFixed(3)}`);
check('falloff is monotonic', curve.every((p, i) => i === 0 || p.a <= curve[i - 1].a + 1e-9));

s1.append(durable('turn/end', { turn: 1, reason: { kind: 'completed' } }));
check('turn/end in feed', live.feed.some((f) => f.kind === 'turn' && /completed/.test(f.text)),
  JSON.stringify(live.feed.slice(-3).map((f) => f.text)));

console.log('--- phase 7: tps 2s sliding window decays ---');
await sleep(2100);
check('tps decayed to 0 after the 2s window', live.tps === 0, `tps=${live.tps.toFixed(2)}`);
check('feed capped at 60 and readable',
  live.feed.length <= 60 && live.feed.every((f) => typeof f.text === 'string' && f.text.length <= 80),
  `len=${live.feed.length}`);
console.log('    feed tail: ' + JSON.stringify(live.feed.slice(-4)));

console.log('--- phase 8: session switch keeps exactly one subscription ---');
sessions.S2 = makeBinding('S2');
currentId = 'S2';
live.setSession('S2');
await sleep(60);
const subsAfterSwitch = `S1=${sessions.S1.eventSource.listenerCount} S2=${sessions.S2.eventSource.listenerCount}`;
check('S1 unsubscribed', sessions.S1.eventSource.listenerCount === 0, `listeners=${sessions.S1.eventSource.listenerCount}`);
check('S2 subscribed exactly once', sessions.S2.eventSource.listenerCount === 1, `listeners=${sessions.S2.eventSource.listenerCount}`);
check('state reset for the new session', live.totalTokens === 0 && live.feed.length === 0 && live.tools.length === 0,
  `totalTokens=${live.totalTokens} feed=${live.feed.length} tools=${live.tools.length}`);
check('HUD ring buffer reset for the new session', live.recentTokens.length === 0 && live.recentText === '',
  `recentTokens=${live.recentTokens.length}`);

const s2 = sessions.S2.eventSource;
s2.append(durable('turn/start', { turn: 1 }));
s2.append(durable('step/start', { turn: 1, step: 1 }));
const frames2 = streamText(s2, 'b1', 1, 1, 'S2 独立词元流 hello world');
await sleep(120);
check('new session streams again', live.totalTokens > 0 && live.tps > 0,
  `totalTokens=${live.totalTokens} tps=${live.tps.toFixed(1)}`);
check('exactly one source feeding live', [sessions.S1.eventSource.listenerCount, s2.listenerCount].join(',') === '0,1');

console.log('--- phase 9: tokenQueue FIFO cap + pullTokens ---');
const overflowText = 'abcdefgh'.repeat(200) + '中文词元溢出测试'.repeat(40);
streamText(s2, 'b2', 1, 1, overflowText);
await sleep(140);
check('tokenQueue capped at exactly 512 (FIFO drop)', live.tokenQueue.length === 512,
  `len=${live.tokenQueue.length}`);
check('recentTokens ring capped at 64 (newest kept)', live.recentTokens.length === 64,
  `len=${live.recentTokens.length}`);
check('recentText stays a non-empty <=160 char string',
  typeof live.recentText === 'string' && live.recentText.length > 0 && live.recentText.length <= 160,
  `len=${live.recentText.length}`);
const recentBeforePull = live.recentTokens.slice();
const recentTextBeforePull = live.recentText;
const pulled = live.pullTokens(3);
check('pullTokens takes at most max and drains FIFO', pulled.length === 3 && pulled.every((s) => typeof s === 'string' && s.length >= 1 && s.length <= 8),
  JSON.stringify(pulled));
check('queue shrank by exactly the pulled amount', live.tokenQueue.length === 509, `len=${live.tokenQueue.length}`);
const rest = live.pullTokens(10000);
check('queue drains completely', live.tokenQueue.length === 0, `drained=${rest.length}`);
check('pullTokens never drains the HUD ring buffer',
  JSON.stringify(live.recentTokens) === JSON.stringify(recentBeforePull) && live.recentText === recentTextBeforePull,
  `recentTokens=${live.recentTokens.length} recentText=${live.recentText.length}`);

console.log('--- phase 10: dispose stops everything ---');
const listenersBefore = s2.listenerCount;
const feedBeforeDispose = live.feed.length;
live.dispose();
await sleep(260);
check('dispose released the subscription', s2.listenerCount === 0, `before=${listenersBefore} after=${s2.listenerCount}`);
check('dispose cleared state', live.tokenQueue.length === 0 && live.feed.length === 0 && live.tools.length === 0 && live.running === false);
let threw = false;
try { live.setRunning(true); live.setSession('S2'); live.pullTokens(1); } catch { threw = true; }
check('post-dispose calls are safe no-ops', !threw);
await sleep(200);
check('no timer left running after dispose', live.activity === 0, `activity=${live.activity}`);

/* ---------------- summary ---------------- */

console.log('\n=== summary ===');
console.log(`tps during stream (2s window)  : ${tpsDuringStream.toFixed(1)} tok/s`);
console.log(`tokenQueue length after stream : ${queueAfterStream}`);
console.log(`tools after stream             : [${toolsAfterStream}]`);
console.log(`subscriptions after switch     : ${subsAfterSwitch}`);
console.log(`live.feed length (pre-dispose) : ${feedBeforeDispose}`);
console.log(`recentTokens (ring cap 64)     : ${recentBeforePull.length}  recentText len=${recentTextBeforePull.length}`);
console.log(`recentText sample              : ${JSON.stringify(recentTextBeforePull.slice(0, 60))}`);
console.log(`text-delta frames emitted      : ${frames} (+${frames2} in session 2)`);
console.log(`elapsed                        : ${Date.now() - t0}ms`);
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);

/**
 * HALOFLUX for DSH — live session data adapter (CONTRACT.md §3).
 *
 * Plain script fragment: no import / export / top-level require. Defines exactly
 * one symbol, `createHalofluxLive`. Read-only against host data; every host call
 * is wrapped in try/catch. No React, no DOM.
 *
 * Host facts this file relies on (verified in the decompiled host sources):
 *  - binding = ctx.get('sessions').binding(id) -> { sessionId, session, eventSource, ctx }
 *  - eventSource.getSnapshot() -> { entries, hasMore, revision, change }
 *      change: {kind:'append',entries} | {kind:'prepend',entries}
 *            | {kind:'replace',entries} | {kind:'settle-assistant',attemptId,entry?}
 *  - entries[i] = {type:'event', event} | {type:'transient', event:{type:'assistant/live-chunk', data:{chunk}}}
 *  - transient live-chunk data = { attemptId, turn, step, chunk }
 *  - chunk = block-start | text-delta{index,text} | reasoning-delta | tool-call-delta{index,id,name?,argumentsDelta}
 *          | block-end | usage{usage} | finish{reason}
 *  - TokenUsage = { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }
 *  - durable: turn/start{turn}, turn/end{turn,reason:{kind}}, step/start|end{turn,step},
 *    user/message, assistant/message{turn,step,message,stream,usage?,interrupted?},
 *    tool/call{turn,step,callId,name,arguments}, tool/result{turn,step,message,error?}
 *      ToolResultMessage = { role:'tool', content, source:{callId}, toolCallId, isError? }
 *  - projections via session.projections.faceOf(key).getSnapshot() (never throws; undefined when absent):
 *      'title' -> string|null, 'modelSelection' -> {lastUsed,next}|null of {provider,model},
 *      'contextPressure' -> {projectedTokens?,pressureTokens?,contextWindow?},
 *      'tokenUsage' -> {uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}
 *
 * Token accounting rule (anti-double-count): display tokens come ONLY from
 * transient `assistant/live-chunk` text-delta frames. Durable assistant/message
 * text is never tokenised (it is the settlement of the same attempt) and a
 * `replace` rescan replays transients in quiet mode. `prepend` (older history)
 * is ignored entirely.
 *
 * Two token views are published:
 *  - `tokenQueue`  — drained by the engine via pullTokens(max).
 *  - `recentTokens` / `recentText` — read-only HUD ring buffer (last 64 display
 *    tokens / one <=160 char line). pullTokens never touches it, so the HUD
 *    token-stream window stays populated while the engine consumes the queue.
 */
const createHalofluxLive = (opts) => {
  'use strict';

  const options = (opts && typeof opts === 'object') ? opts : {};
  const getSessionId = typeof options.getSessionId === 'function' ? options.getSessionId : function () { return undefined; };
  const bindingOf = typeof options.bindingOf === 'function' ? options.bindingOf : function () { return undefined; };

  /* ---------------- tunables ---------------- */

  const TICK_MS = 100;              // internal clock (envelope + rebind + tps)
  const BIND_EVERY = 2;             // ticks between binding polls (200ms fallback)
  const META_EVERY = 5;             // ticks between projection refreshes (500ms)
  const RISE_MS = 120;              // activity 0 -> 1
  const FALL_MS = 1200;             // activity 1 -> 0
  const ACTIVE_TAIL_MS = 1500;      // "tokens arrived recently" window
  const TPS_WINDOW_MS = 2000;       // sliding window for tps
  const QUEUE_MAX = 512;            // tokenQueue cap (FIFO drop)
  const FEED_MAX = 60;
  const TOOLS_MAX = 24;
  const SCAN_MAX = 400;             // rescan only the tail of the window
  const FEED_SEED = 8;              // feed entries seeded from history on (re)bind
  const NOTIFY_MS = 200;            // subscriber coalescing => <=5Hz
  const ATTEMPT_MEMORY = 64;
  const TOKEN_CHUNK_MAX = 8;        // display token length cap
  const RECENT_MAX = 64;            // HUD ring buffer of recent tokens
  const RECENT_TEXT_MAX = 160;      // HUD one-line rendering cap
  const FEED_TEXT_MAX = 80;
  const TOOL_TEXT_MAX = 60;
  const ATTEMPT_DONE = Infinity;

  /* ---------------- small helpers ---------------- */

  function now() { return Date.now(); }

  function num(value) {
    return (typeof value === 'number' && isFinite(value)) ? value : undefined;
  }

  function arr(value) {
    return Array.isArray(value) ? value : [];
  }

  function oneLine(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
  }

  function clip(text, max) {
    if (typeof text !== 'string') return '';
    if (text.length <= max) return text;
    return text.slice(0, Math.max(1, max - 3)) + '...';
  }

  /* Display tokenizer: CJK by single code point, everything else buffered up to
     TOKEN_CHUNK_MAX chars, whitespace separates and is not emitted itself.
     Each token carries `sep` = whitespace preceded it, so the recent-token ring
     can be re-joined into readable text later. */
  const CJK = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;

  function isSpace(ch) {
    return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\u3000';
  }

  function splitTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    const chars = Array.from(text);
    const out = [];
    let buf = '';
    let sep = false;
    function flush() {
      if (!buf) return;
      out.push({ t: buf, sep: sep });
      buf = '';
      sep = false;
    }
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      if (isSpace(ch)) {
        flush();
        sep = true;
        continue;
      }
      if (CJK.test(ch)) {
        const lead = sep;
        flush();
        out.push({ t: ch, sep: lead });
        sep = false;
        continue;
      }
      buf += ch;
      if (buf.length >= TOKEN_CHUNK_MAX) flush();
    }
    flush();
    return out;
  }

  /* Message content blocks -> readable text. */
  function messageText(message) {
    if (!message || typeof message !== 'object') return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let out = '';
    for (let i = 0; i < content.length; i += 1) {
      const block = content[i];
      if (!block || typeof block !== 'object') continue;
      if (typeof block.text === 'string' && block.text) {
        out += (out ? ' ' : '') + block.text;
      } else if (typeof block.type === 'string' && block.type !== 'text') {
        out += (out ? ' ' : '') + '[' + block.type + ']';
      }
    }
    return out;
  }

  function firstLine(text) {
    const flat = oneLine(text);
    if (!flat) return '';
    const hit = flat.match(/^(.{0,120}?[.。!！?？])(?:\s|$)/);
    return hit ? hit[1] : flat;
  }

  function reasonKind(reason) {
    if (typeof reason === 'string' && reason) return reason;
    if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
    return 'completed';
  }

  function summarizeArgs(raw) {
    let text = raw;
    if (typeof text !== 'string') {
      try { text = text === undefined || text === null ? '' : JSON.stringify(text); } catch { text = ''; }
    }
    return clip(oneLine(text), TOOL_TEXT_MAX);
  }

  /* ---------------- mutable state ---------------- */

  let desiredId;                  // session id the consumer asked for
  let stateSessionId;             // session id live.* currently describes
  let boundId;                    // session id actually bound (has eventSource)
  let binding = null;
  let eventSource = null;
  let unsubSource = null;
  let revision = -1;
  let maxDurableSeq = -Infinity;
  let attemptWatermark = new Map();

  let displayTokens = 0;
  let usageAuthoritative = false;
  let runningSet = false;
  let seeded = false;             // feed seeded for the current session window
  let recentParts = [];           // private {t, sep} mirror of live.recentTokens
  let lastTokenAt = 0;
  let tokenStamps = [];

  let activityValue = 0;
  let lastAdvanceMs = now();

  let subscribers = new Set();
  let timer = null;
  let notifyTimer = null;
  let notifyPending = false;
  let lastNotifyMs = 0;
  let tickCount = 0;
  let disposed = false;

  /* ---------------- the exported mutable singleton ---------------- */

  const live = {
    running: false,
    get activity() { return readActivity(); },
    set activity(value) {
      const v = num(value);
      if (v === undefined) return;
      activityValue = Math.max(0, Math.min(1, v));
      lastAdvanceMs = now();
    },
    tps: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    contextLimit: 0,
    turn: 0,
    step: 0,
    model: '',
    sessionTitle: '',
    tools: [],
    feed: [],
    tokenQueue: [],
    recentTokens: [],
    recentText: '',
    pullTokens: pullTokens,
    subscribe: subscribe,
    setSession: setSession,
    setRunning: setRunning,
    attach: attach,
    detach: detach,
    dispose: dispose,
  };

  /* ---------------- activity envelope ---------------- */

  function readActivity() {
    if (disposed) return 0;
    try { advanceActivity(now()); } catch { /* never surface */ }
    return activityValue;
  }

  function advanceActivity(nowMs) {
    let dt = nowMs - lastAdvanceMs;
    if (!(dt > 0)) return;
    if (dt > 1000) dt = 1000;                       // hidden tab: no teleporting
    lastAdvanceMs = nowMs;
    const active = live.running === true
      || (lastTokenAt > 0 && (nowMs - lastTokenAt) < ACTIVE_TAIL_MS);
    const before = activityValue;
    if (active) activityValue = Math.min(1, activityValue + dt / RISE_MS);
    else activityValue = Math.max(0, activityValue - dt / FALL_MS);
    if (activityValue < 0.0005) activityValue = 0;
    if (Math.abs(activityValue - before) > 0.002) notifySoon();
  }

  /* ---------------- subscription / notification ---------------- */

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () { };
    subscribers.add(fn);
    return function () { subscribers.delete(fn); };
  }

  function notifySoon() {
    if (subscribers.size === 0 || disposed) return;
    if (notifyPending) return;
    const elapsed = now() - lastNotifyMs;
    if (elapsed >= NOTIFY_MS) { flushNotify(); return; }
    notifyPending = true;
    if (notifyTimer === null) {
      notifyTimer = setTimeout(function () {
        notifyTimer = null;
        flushNotify();
      }, Math.max(0, NOTIFY_MS - elapsed));
    }
  }

  function flushNotify() {
    notifyPending = false;
    lastNotifyMs = now();
    if (notifyTimer !== null) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    if (subscribers.size === 0) return;
    const list = [];
    subscribers.forEach(function (fn) { list.push(fn); });
    for (let i = 0; i < list.length; i += 1) {
      try { list[i](live); } catch { /* a bad subscriber must not stop the feed */ }
    }
  }

  /* ---------------- token accounting ---------------- */

  function pushFeed(kind, text) {
    const body = clip(oneLine(text), FEED_TEXT_MAX);
    if (!body) return;
    live.feed.push({ kind: kind, text: body, t: now() });
    if (live.feed.length > FEED_MAX) live.feed.splice(0, live.feed.length - FEED_MAX);
  }

  function trimStamps(at) {
    const cutoff = at - TPS_WINDOW_MS;
    while (tokenStamps.length > 0 && tokenStamps[0].t < cutoff) tokenStamps.shift();
  }

  function computeTps(at) {
    trimStamps(at);
    let count = 0;
    for (let i = 0; i < tokenStamps.length; i += 1) count += tokenStamps[i].n;
    return count * (1000 / TPS_WINDOW_MS);
  }

  /* Read-only ring buffer for the HUD: the newest RECENT_MAX display tokens,
     never drained by pullTokens() (engine) so the token-stream window stays
     populated. recentText renders it as one <=160 char line. */
  function buildRecentText() {
    let out = '';
    for (let i = 0; i < recentParts.length; i += 1) {
      const part = recentParts[i];
      out += (part.sep && out ? ' ' : '') + part.t;
    }
    if (out.length > RECENT_TEXT_MAX) out = out.slice(out.length - RECENT_TEXT_MAX);
    return out;
  }

  function pushRecent(parts) {
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      live.recentTokens.push(part.t);
      recentParts.push(part);
    }
    const drop = live.recentTokens.length - RECENT_MAX;
    if (drop > 0) {
      live.recentTokens.splice(0, drop);
      recentParts.splice(0, drop);
    }
    live.recentText = buildRecentText();
  }

  function emitText(text) {
    const parts = splitTokens(text);
    if (parts.length === 0) return;
    const at = now();
    lastTokenAt = at;
    displayTokens += parts.length;
    live.totalTokens = displayTokens;
    if (!usageAuthoritative) live.outputTokens = displayTokens;
    for (let i = 0; i < parts.length; i += 1) live.tokenQueue.push(parts[i].t);
    const overflow = live.tokenQueue.length - QUEUE_MAX;
    if (overflow > 0) live.tokenQueue.splice(0, overflow);
    pushRecent(parts);
    tokenStamps.push({ t: at, n: parts.length });
    live.tps = computeTps(at);
    notifySoon();
  }

  function pullTokens(max) {
    const limit = num(max);
    const take = limit === undefined ? live.tokenQueue.length : Math.max(0, Math.floor(limit));
    if (take <= 0) return [];
    return live.tokenQueue.splice(0, take);   // recentTokens is deliberately untouched
  }

  /* ---------------- usage ---------------- */

  function applyUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    const input = num(usage.inputTokens);
    const output = num(usage.outputTokens);
    const total = num(usage.totalTokens);
    const cacheRead = num(usage.cacheReadTokens);
    const cacheWrite = num(usage.cacheWriteTokens);

    if (input !== undefined) live.inputTokens = input;
    else if (total !== undefined && output !== undefined) live.inputTokens = Math.max(0, total - output);
    else if (cacheRead !== undefined || cacheWrite !== undefined) live.inputTokens = (cacheRead || 0) + (cacheWrite || 0);

    if (output !== undefined) { live.outputTokens = output; usageAuthoritative = true; }
    else if (total !== undefined) { live.outputTokens = total; usageAuthoritative = true; }

    // prompt size of the newest request ~= context occupancy
    if (total !== undefined && output !== undefined) live.contextTokens = Math.max(0, total - output);
    else if (input !== undefined) live.contextTokens = input;

    notifySoon();
  }

  /* ---------------- tools ---------------- */

  function findTool(key) {
    for (let i = live.tools.length - 1; i >= 0; i -= 1) {
      if (live.tools[i].id === key) return live.tools[i];
    }
    return null;
  }

  function upsertTool(id, name, state) {
    const key = (id === undefined || id === null || id === '')
      ? ((typeof name === 'string' && name) ? name : '')
      : String(id);
    if (!key) return null;
    const at = now();
    const hit = findTool(key);
    if (hit) {
      if (typeof name === 'string' && name) hit.name = name;
      if (state) {
        hit.state = state;
        if (state !== 'running') hit.t = at;
      }
      return hit;
    }
    const entry = {
      id: key,
      name: (typeof name === 'string' && name) ? name : key,
      state: state || 'running',
      t: at,
    };
    live.tools.push(entry);
    if (live.tools.length > TOOLS_MAX) live.tools.splice(0, live.tools.length - TOOLS_MAX);
    return entry;
  }

  /* ---------------- durable events ---------------- */

  function applyDurable(event, quiet) {
    const type = event && event.type;
    const data = (event && event.data) || {};
    switch (type) {
      case 'turn/start': {
        const turn = num(data.turn);
        if (turn !== undefined) live.turn = turn;
        break;
      }
      case 'turn/end': {
        const turn = num(data.turn);
        if (turn !== undefined) live.turn = turn;
        if (!quiet) {
          const kind = reasonKind(data.reason);
          pushFeed(kind === 'error' ? 'error' : 'turn', 'turn ' + live.turn + ' ' + kind);
        }
        break;
      }
      case 'step/start':
      case 'step/end': {
        const turn = num(data.turn);
        const step = num(data.step);
        if (turn !== undefined) live.turn = turn;
        if (step !== undefined) live.step = step;
        break;
      }
      case 'user/message': {
        // SessionEventMap: 'user/message' IS the UserMessage (no .message wrapper),
        // while 'assistant/message' wraps it. Accept both shapes.
        const payload = (data && typeof data === 'object' && data.message && data.message.content)
          ? data.message
          : data;
        if (!quiet) pushFeed('user', messageText(payload));
        break;
      }
      case 'assistant/message': {
        const turn = num(data.turn);
        const step = num(data.step);
        if (turn !== undefined) live.turn = turn;
        if (step !== undefined) live.step = step;
        // NOTE: text here is the settlement of an attempt already streamed as
        // transient text-delta frames -> never tokenised (anti double-count).
        applyUsage(data.usage);
        if (!quiet) pushFeed('assistant', firstLine(messageText(data.message)));
        break;
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : '';
        upsertTool(data.callId, name, 'running');
        if (!quiet) pushFeed('tool', name + '(' + summarizeArgs(data.arguments) + ')');
        break;
      }
      case 'tool/result': {
        const message = (data.message && typeof data.message === 'object') ? data.message : {};
        const source = (message.source && typeof message.source === 'object') ? message.source : {};
        const callId = message.toolCallId !== undefined ? message.toolCallId
          : (source.callId !== undefined ? source.callId : data.callId);
        const failed = data.error !== undefined || message.isError === true;
        const previous = findTool(callId === undefined || callId === null ? '' : String(callId));
        const name = (typeof source.name === 'string' && source.name)
          || (previous && previous.name)
          || (callId === undefined ? 'tool' : String(callId));
        upsertTool(callId, name, failed ? 'error' : 'ok');
        if (!quiet) {
          const detail = failed
            ? ((data.error && (data.error.code || data.error.name)) || 'error')
            : 'ok';
          pushFeed(failed ? 'error' : 'tool', name + ' ' + detail);
        }
        break;
      }
      case 'session/title': {
        if (typeof data.text === 'string') live.sessionTitle = data.text;
        break;
      }
      default:
        break;
    }
  }

  /* ---------------- transient live chunks ---------------- */

  function pruneAttempts() {
    while (attemptWatermark.size > ATTEMPT_MEMORY) {
      const first = attemptWatermark.keys().next();
      if (first.done) break;
      attemptWatermark.delete(first.value);
    }
  }

  function handleChunk(chunk, data) {
    switch (chunk.type) {
      case 'text-delta':
        emitText(chunk.text);
        break;
      case 'tool-call-delta':
        upsertTool(chunk.id, typeof chunk.name === 'string' ? chunk.name : undefined, 'running');
        break;
      case 'usage':
        applyUsage(chunk.usage);
        break;
      default:
        break;   // reasoning-delta / block-start / block-end / finish: not display tokens
    }
    const turn = num(data.turn);
    const step = num(data.step);
    if (turn !== undefined) live.turn = turn;
    if (step !== undefined) live.step = step;
  }

  function applyTransient(entry, quiet) {
    const event = (entry && entry.event) || entry;
    if (!event || typeof event !== 'object') return;
    const data = (event.data && typeof event.data === 'object') ? event.data : {};
    const chunk = data.chunk;
    if (!chunk || typeof chunk !== 'object') return;

    const attemptId = (data.attemptId === undefined || data.attemptId === null) ? '' : String(data.attemptId);
    const seq = num(event.seq);
    if (attemptId) {
      const mark = attemptWatermark.get(attemptId);
      if (mark === ATTEMPT_DONE) return;
      if (mark !== undefined && seq !== undefined && seq <= mark) return;
      if (seq !== undefined) attemptWatermark.set(attemptId, seq);
      else if (mark === undefined) attemptWatermark.set(attemptId, -Infinity);
      pruneAttempts();
    }
    if (quiet) return;      // replay of an already-counted suffix: never re-count
    handleChunk(chunk, data);
  }

  /* ---------------- window ingestion ---------------- */

  function isTransientEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.type === 'transient') return true;
    return !!(entry.event && entry.event.type === 'assistant/live-chunk');
  }

  function applyEntry(entry, quiet) {
    if (!entry || typeof entry !== 'object') return;
    if (isTransientEntry(entry)) { applyTransient(entry, quiet); return; }
    const event = entry.event;
    if (!event || typeof event !== 'object') return;
    const seq = num(event.seq);
    if (seq !== undefined) {
      if (seq <= maxDurableSeq) return;      // dedupe: replace overlap / settled attempt
      maxDurableSeq = seq;
    }
    applyDurable(event, quiet);
  }

  function rescan(snapshot, seedFeed) {
    const entries = arr(snapshot && snapshot.entries);
    const from = Math.max(0, entries.length - SCAN_MAX);
    const tail = entries.slice(from);

    // Replay history quietly (state only), but present the last few durable
    // events as readable feed entries when this is a fresh session window.
    let loudFrom = tail.length;                 // default: replay quietly
    if (seedFeed) {
      loudFrom = 0;                             // short windows seed entirely
      let seen = 0;
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        if (isTransientEntry(tail[i])) continue;
        seen += 1;
        if (seen >= FEED_SEED) { loudFrom = i; break; }
      }
    }
    // A seeded window presents recent durable events as feed entries, but the
    // scan must never emit tokens: display tokens only ever come from live
    // append frames, so a rebind mid-stream cannot re-count streamed text.
    for (let i = 0; i < tail.length; i += 1) {
      const loud = i >= loudFrom && !isTransientEntry(tail[i]);
      applyEntry(tail[i], !loud);
    }
  }

  function initialScan(seedFeed) {
    const source = eventSource;
    if (!source) return;
    let snapshot;
    try { snapshot = source.getSnapshot(); } catch { snapshot = null; }
    if (!snapshot) return;
    const rev = num(snapshot.revision);
    if (rev !== undefined) revision = rev;
    rescan(snapshot, seedFeed);
    notifySoon();
  }

  function onSourceChanged() {
    try {
      const source = eventSource;
      if (!source) return;
      const snapshot = source.getSnapshot();
      if (!snapshot) return;
      const rev = num(snapshot.revision);
      if (rev !== undefined) {
        if (rev === revision) return;          // same publication, already applied
        revision = rev;
      }
      const change = snapshot.change;
      const kind = (change && typeof change.kind === 'string') ? change.kind : 'replace';

      if (kind === 'prepend') return;          // older history: never re-count
      if (kind === 'append') {
        const added = arr(change && change.entries);
        for (let i = 0; i < added.length; i += 1) applyEntry(added[i], false);
        notifySoon();
        return;
      }
      if (kind === 'settle-assistant') {
        const attemptId = (change && change.attemptId !== undefined && change.attemptId !== null)
          ? String(change.attemptId) : '';
        if (attemptId) {
          attemptWatermark.set(attemptId, ATTEMPT_DONE);
          pruneAttempts();
        }
        if (change && change.entry) applyEntry(change.entry, false);
        notifySoon();
        return;
      }
      // replace (attach / rebaseline): rebuild state without re-counting tokens
      rescan(snapshot, false);
      notifySoon();
    } catch { /* the feed must never throw into the host */ }
  }

  /* ---------------- meta (model / title / context / running) ---------------- */

  function faceValue(projections, key) {
    try {
      const face = projections.faceOf(key);
      if (!face || typeof face.getSnapshot !== 'function') return undefined;
      return face.getSnapshot();
    } catch { return undefined; }
  }

  function refreshMeta() {
    const current = binding;
    if (!current) return;
    const session = current.session;
    if (!session || typeof session !== 'object') return;

    let snapshot;
    try { snapshot = typeof session.getSnapshot === 'function' ? session.getSnapshot() : undefined; } catch { snapshot = undefined; }
    if (snapshot && typeof snapshot.running === 'boolean' && !runningSet) live.running = snapshot.running;

    const projections = session.projections;
    if (!projections || typeof projections.faceOf !== 'function') return;

    const title = faceValue(projections, 'title');
    if (typeof title === 'string') live.sessionTitle = title;

    const selection = faceValue(projections, 'modelSelection');
    if (selection && typeof selection === 'object') {
      const chosen = selection.next || selection.lastUsed;
      if (chosen && typeof chosen.model === 'string') live.model = chosen.model;
    }

    const pressure = faceValue(projections, 'contextPressure');
    if (pressure && typeof pressure === 'object') {
      const projected = num(pressure.projectedTokens);
      const used = num(pressure.pressureTokens);
      const window = num(pressure.contextWindow);
      if (projected !== undefined) live.contextTokens = projected;
      else if (used !== undefined) live.contextTokens = used;
      if (window !== undefined) live.contextLimit = window;
    }

    if (!usageAuthoritative) {
      const usage = faceValue(projections, 'tokenUsage');
      if (usage && typeof usage === 'object') {
        const uncached = num(usage.uncachedInputTokens);
        const cachedRead = num(usage.cacheReadTokens);
        const cachedWrite = num(usage.cacheWriteTokens);
        const output = num(usage.outputTokens);
        if (uncached !== undefined || cachedRead !== undefined || cachedWrite !== undefined) {
          live.inputTokens = (uncached || 0) + (cachedRead || 0) + (cachedWrite || 0);
        }
        if (output !== undefined) { live.outputTokens = output; usageAuthoritative = true; }
      }
    }
  }

  /* ---------------- binding lifecycle ---------------- */

  function resetSessionState() {
    live.totalTokens = 0;
    live.inputTokens = 0;
    live.outputTokens = 0;
    live.contextTokens = 0;
    live.contextLimit = 0;
    live.turn = 0;
    live.step = 0;
    live.model = '';
    live.sessionTitle = '';
    live.tps = 0;
    // NOTE: live.running is deliberately NOT reset here. It is owned by the
    // mounting layer, which pushes the new Session's status; clearing it on a
    // switch left a running -> running switch stuck at the idle level, because
    // the status value itself did not change and so was never re-pushed.
    live.tools.length = 0;
    live.feed.length = 0;
    live.tokenQueue.length = 0;
    live.recentTokens.length = 0;
    live.recentText = '';
    displayTokens = 0;
    usageAuthoritative = false;
    seeded = false;
    recentParts = [];
    lastTokenAt = 0;
    tokenStamps = [];
    maxDurableSeq = -Infinity;
    attemptWatermark = new Map();
  }

  function releaseBinding() {
    try { if (typeof unsubSource === 'function') unsubSource(); } catch { /* ignore */ }
    unsubSource = null;
    eventSource = null;
    binding = null;
    boundId = undefined;
  }

  function rebind(force) {
    if (!force && binding !== null && boundId === desiredId) return;

    const switching = desiredId !== stateSessionId;
    const previousSource = eventSource;
    releaseBinding();
    if (switching) {
      resetSessionState();
      stateSessionId = desiredId;
    }
    revision = -1;
    if (desiredId === undefined) return;

    let next;
    try { next = bindingOf(desiredId); } catch { next = undefined; }
    if (!next || typeof next !== 'object') return;
    const source = next.eventSource;
    if (!source || typeof source.getSnapshot !== 'function') return;

    if (source !== previousSource) {
      // A different feed object owns its own sequence space: rescan from scratch
      // rather than let the old watermark swallow the new window.
      maxDurableSeq = -Infinity;
      attemptWatermark = new Map();
    }

    const seedFeed = switching || !seeded;
    binding = next;
    eventSource = source;
    boundId = desiredId;
    try {
      if (typeof source.subscribe === 'function') unsubSource = source.subscribe(onSourceChanged);
    } catch { unsubSource = null; }
    initialScan(seedFeed);
    seeded = true;
    refreshMeta();
  }

  function ensureBinding() {
    let id;
    try { id = getSessionId(); } catch { id = undefined; }
    if (typeof id !== 'string' || id === '') id = undefined;
    if (id !== desiredId) {
      desiredId = id;
      rebind(true);
      return;
    }
    if (binding === null) {
      rebind(false);                      // binding not yet published
      return;
    }
    // Still bound: re-ask the host, so a dropped or rebuilt binding is noticed.
    let current;
    try { current = bindingOf(desiredId); } catch { current = undefined; }
    if (!current || current.eventSource !== binding.eventSource) rebind(true);
  }

  /* ---------------- public control ---------------- */

  function setSession(id) {
    try {
      const next = (typeof id === 'string' && id !== '') ? id : undefined;
      if (next === desiredId && binding !== null) return;
      desiredId = next;
      rebind(true);
      notifySoon();
    } catch { /* ignore */ }
  }

  function setRunning(value) {
    try {
      if (typeof value !== 'boolean') return;
      runningSet = true;
      if (live.running === value) return;
      live.running = value;
      notifySoon();
    } catch { /* ignore */ }
  }

  /* ---------------- clock ---------------- */

  function tick() {
    if (disposed) return;
    try {
      tickCount += 1;
      advanceActivity(now());
      if (tickCount % BIND_EVERY === 1) ensureBinding();
      if (tickCount % META_EVERY === 0) refreshMeta();
      const tps = computeTps(now());
      if (tps !== live.tps) {
        live.tps = tps;
        notifySoon();
      }
    } catch {
      try { releaseBinding(); } catch { /* ignore */ }
    }
  }

  function attach() {
    if (disposed || timer !== null) return;
    lastAdvanceMs = now();
    timer = setInterval(tick, TICK_MS);
    tick();
  }

  function detach() {
    if (timer !== null) {
      try { clearInterval(timer); } catch { /* ignore */ }
      timer = null;
    }
    releaseBinding();
    revision = -1;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    detach();
    if (notifyTimer !== null) {
      try { clearTimeout(notifyTimer); } catch { /* ignore */ }
      notifyTimer = null;
    }
    notifyPending = false;
    subscribers.clear();
    activityValue = 0;
    lastTokenAt = 0;
    lastAdvanceMs = now();
    live.running = false;
    live.tps = 0;
    live.tools.length = 0;
    live.feed.length = 0;
    live.tokenQueue.length = 0;
    live.recentTokens.length = 0;
    live.recentText = '';
    recentParts = [];
    tokenStamps = [];
  }

  // mount.js creates the live source and consumes it right away without calling
  // attach(), so the adapter starts itself; attach() stays idempotent.
  attach();

  return live;
};

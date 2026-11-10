// Pre-rendered voice clips: the command announcer and the unit radio
// acknowledgements. The clips are rendered offline by tools/voicegen (neural
// TTS + processing) into client/public/voice/, next to a manifest.json that
// lists every clip:
//
//   { v, ext, default, factions: { Egypt: 'b', ... },
//     ann: { <bank>: { <key>: [ { f, d, t }, ... ] } },      key: online | built |
//     ack: { <group>: { <event>: [ { f, d, t }, ... ] } } }   built.<Type> | unit ...
//
// f = file (relative to the manifest), d = seconds, t = the spoken text.
//
// A VoiceBox belongs to one AudioEngine and plays through engine.bus.voice, so
// the voice / master volumes, mute and the master chain all apply. Nothing is
// fetched until load() (the engine calls it in idle time after the first user
// gesture); clips are fetched and decoded on first need and kept decoded.
// Every method is guarded: without fetch, decodeAudioData or a running
// context it does nothing, and it never throws.
//
// Mixing rules:
//   * announcer lines never overlap: while one plays, the next waits in a
//     one-slot queue (the highest priority wins, stale lines are dropped);
//     an 'attack' alert cuts a lesser line off instead of waiting;
//   * at most one unit acknowledgement at a time, never over an announcer
//     line (a starting line fades a playing acknowledgement out); order
//     acknowledgements at most one per ACK_GAP, selection ones rarer, and an
//     order may cut a selection acknowledgement short;
//   * variants are picked at random (Math.random — presentation only, the sim
//     never sees it) without repeating the previous pick.
//
// When the manifest or a clip cannot be loaded, announcer lines are handed to
// `onFallback(key, text)` (speechSynthesis in ../game/audio.js) and
// acknowledgements stay silent.

export const VOICE_MANIFEST = 'voice/manifest.json';
export const ANNOUNCER_KEYS = ['online', 'built', 'unit', 'harv', 'attack', 'lost', 'structLost',
  'captured', 'peaceStart', 'peaceEnd'];
export const ACK_EVENTS = ['select', 'move', 'attack'];
export const ACK_GROUPS = ['infantry', 'vehicle', 'air', 'naval', 'support'];

// who waits for whom: 3 cuts lesser lines off, the rest queue by priority
const PRIORITY = {
  attack: 3, online: 2, peaceStart: 2, peaceEnd: 2, structLost: 2, captured: 2,
  lost: 1, built: 1, harv: 1, unit: 0,
};

const LINE_GAIN = 1;        // announcer clips (all clips share one loudness target)
const ACK_GAIN = 0.8;       // radio acknowledgements sit a little under the announcer
const DUCK_DB = 5;          // music ducking under an announcer line
const ACK_GAP = 2000;       // ms between two order acknowledgements
const SELECT_GAP = 5000;    // ms between two selection acknowledgements
const ACK_LATE = 300;       // an acknowledgement that cannot start within this is dropped
const LINE_STALE = 2500;    // an announcer line that could not start within this is dropped
const QUEUE_STALE = 3500;   // ... and so is a queued one that waited longer than this
const LOAD_RETRY = 30000;   // a failed manifest / clip is retried after this long
const FETCH_TIMEOUT = 10000;
const PREFETCH_DELAY = 1500;

const INFANTRY_CLASSES = { Infantry: 1, 'AT infantry': 1, 'AA infantry': 1, SF: 1 };
const SUPPORT_CLASSES = { Engineer: 1, Harvester: 1, MCV: 1 };

// Which radio voice answers for a unit definition (client/data/game.json, or
// the synthesized MCV / HARV defs): 'infantry' | 'vehicle' | 'air' | 'naval' |
// 'support', or null without a definition.
export function unitVoiceGroup(def) {
  if (!def || typeof def !== 'object') return null;
  const cls = String(def.cls || '');
  const domain = String(def.domain || '');
  if (def.id === 'MCV' || def.id === 'HARV' || SUPPORT_CLASSES[cls] === 1) return 'support';
  if (domain === 'Air') return 'air';
  if (domain === 'Sea' || cls === 'Naval') return 'naval';
  if (INFANTRY_CLASSES[cls] === 1 || /infantry/i.test(cls)) return 'infantry';
  return 'vehicle';
}

function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

function later(fn, ms) {
  if (typeof setTimeout === 'function') setTimeout(fn, ms);
}

function validList(list) {
  if (!Array.isArray(list) || !list.length) return false;
  for (const c of list) {
    // files are plain relative names: never a scheme, a parent step or a root
    if (!c || typeof c.f !== 'string' || !/^[\w-]+(\/[\w.-]+)+$/.test(c.f) || c.f.indexOf('..') >= 0) return false;
  }
  return true;
}

function validManifest(m) {
  if (!m || typeof m !== 'object' || !m.ann || !m.ack) return false;
  for (const bank in m.ann) for (const key in m.ann[bank]) if (!validList(m.ann[bank][key])) return false;
  for (const group in m.ack) for (const ev in m.ack[group]) if (!validList(m.ack[group][ev])) return false;
  return true;
}

export class VoiceBox {
  // o: { url, onFallback(key, text) -> seconds it will speak for (0 / falsy = silent) }
  constructor(engine, o) {
    const opt = o || {};
    this.E = engine;
    this.ctx = engine.ctx;
    this.url = opt.url || VOICE_MANIFEST;
    this.base = this.url.replace(/[^/]*$/, '');
    this.onFallback = opt.onFallback || null;
    this.state = 'idle';       // idle | loading | ready | failed
    this.failedAt = 0;
    this.loading = null;
    this.manifest = null;
    this.bytes = new Map();    // file -> ArrayBuffer (prefetched, not yet decoded)
    this.bufs = new Map();     // file -> AudioBuffer
    this.pending = new Map();  // file -> Promise<AudioBuffer | null>
    this.bad = new Map();      // file -> time it failed
    this.warm = [];            // prefetch queue
    this.warming = 0;
    this.warmed = {};
    this.last = {};            // slot -> last variant index
    this.line = null;          // playing announcer handle
    this.pendingLine = null;   // { token, at, prio } while a line is loading
    this.queued = null;        // { faction, key, detail, prio, at }
    this.lineSeq = 0;
    this.speechUntil = -Infinity;
    this.ackH = null;          // playing acknowledgement handle
    this.ackSeq = 0;
    this.ackAt = -Infinity;    // last acknowledgement of any kind
    this.orderAt = -Infinity;
    this.selectAt = -Infinity;
    this.stats = { lines: 0, acks: 0, fallbacks: 0, queued: 0, cut: 0, late: 0, failed: 0, fetched: 0, bytes: 0, last: '' };
    this.dead = false;
    // a suspended context (mute, hidden tab) freezes a clip half-way; it must
    // not finish its sentence minutes later when the context comes back
    try {
      if (this.ctx && typeof this.ctx.addEventListener === 'function') {
        this.ctx.addEventListener('statechange', () => { if (this.ctx.state !== 'running') this.stopAll(); });
      }
    } catch (e) { /* ok */ }
  }

  // ---- loading ---------------------------------------------------------------

  canLoad() {
    return !this.dead && typeof fetch === 'function' && !!this.ctx && typeof this.ctx.decodeAudioData === 'function';
  }

  // -> Promise<boolean>; safe to call any number of times
  load() {
    try {
      if (this.state === 'failed' && nowMs() - this.failedAt > LOAD_RETRY) { this.state = 'idle'; this.loading = null; }
      if (this.loading) return this.loading;
      if (!this.canLoad()) {
        this.state = 'failed'; this.failedAt = Infinity; // nothing to retry with
        this.loading = Promise.resolve(false);
        return this.loading;
      }
      this.state = 'loading';
      this.loading = this.get(this.url, true)
        .then((r) => r.json())
        .then((m) => {
          if (!validManifest(m)) throw new Error('bad voice manifest');
          this.manifest = m;
          this.state = 'ready';
          // the acknowledgements have to answer at once: fetch them ahead of need
          later(() => { for (const g in m.ack) this.prefetch(m.ack[g]); }, PREFETCH_DELAY);
          return true;
        })
        .catch(() => {
          this.state = 'failed';
          this.failedAt = nowMs();
          return false;
        });
      return this.loading;
    } catch (e) {
      this.state = 'failed'; this.failedAt = nowMs();
      return Promise.resolve(false);
    }
  }

  get(url, fresh) {
    let ctl = null;
    try { if (typeof AbortController === 'function') ctl = new AbortController(); } catch (e) { ctl = null; }
    const opt = {};
    if (fresh) opt.cache = 'no-cache';
    if (ctl) { opt.signal = ctl.signal; later(() => { try { ctl.abort(); } catch (e) { /* ok */ } }, FETCH_TIMEOUT); }
    return fetch(url, opt).then((r) => {
      if (!r || !r.ok) throw new Error('voice: HTTP ' + (r ? r.status : 0));
      return r;
    });
  }

  fetchBytes(file) {
    const have = this.bytes.get(file);
    if (have) return Promise.resolve(have);
    return this.get(this.base + file, false).then((r) => r.arrayBuffer()).then((ab) => {
      this.stats.fetched++;
      this.stats.bytes += ab.byteLength;
      return ab;
    });
  }

  decode(ab) {
    return new Promise((resolve, reject) => {
      try {
        // callback form for old WebKit; modern engines also return a promise
        const p = this.ctx.decodeAudioData(ab, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      } catch (e) { reject(e); }
    });
  }

  // decoded clip, or null when it cannot be had (never rejects)
  buffer(clip) {
    const f = clip.f;
    const have = this.bufs.get(f);
    if (have) return Promise.resolve(have);
    const failed = this.bad.get(f);
    if (failed !== undefined) {
      if (nowMs() - failed < LOAD_RETRY) return Promise.resolve(null);
      this.bad.delete(f);
    }
    let p = this.pending.get(f);
    if (!p) {
      p = this.fetchBytes(f)
        .then((ab) => { this.bytes.delete(f); return this.decode(ab); })
        .then((buf) => {
          this.pending.delete(f);
          if (!buf || !(buf.duration > 0)) throw new Error('voice: empty clip');
          this.bufs.set(f, buf);
          return buf;
        })
        .catch(() => {
          this.pending.delete(f);
          this.bytes.delete(f);
          this.bad.set(f, nowMs());
          this.stats.failed++;
          return null;
        });
      this.pending.set(f, p);
    }
    return p;
  }

  // fetch (not decode) a set of clips in the background, two at a time
  prefetch(slots) {
    try {
      for (const k in slots) for (const c of slots[k]) this.warm.push(c.f);
      this.pump();
    } catch (e) { /* best-effort */ }
  }

  pump() {
    while (this.warming < 2 && this.warm.length) {
      const f = this.warm.shift();
      if (this.bytes.has(f) || this.bufs.has(f) || this.pending.has(f) || this.bad.has(f)) continue;
      this.warming++;
      const done = () => { this.warming--; this.pump(); };
      this.fetchBytes(f).then((ab) => {
        if (!this.bufs.has(f) && !this.pending.has(f)) this.bytes.set(f, ab);
        done();
      }, done);
    }
  }

  // ---- playback ----------------------------------------------------------------

  running() {
    return !this.dead && !this.E.muted && !!this.ctx && this.ctx.state === 'running' && !!this.E.bus.voice;
  }

  start(buf, gain, delay) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.E.bus.voice);
    const t = ctx.currentTime + 0.012 + (delay || 0);
    const h = { src, g, t, end: t + buf.duration, done: false, onDone: null };
    src.onended = () => {
      h.done = true;
      try { src.disconnect(); g.disconnect(); } catch (e) { /* ok */ }
      if (h.onDone) { try { h.onDone(); } catch (e) { /* ok */ } }
    };
    src.start(t);
    return h;
  }

  playing(h) {
    return !!h && !h.done && this.ctx.currentTime < h.end + 0.05;
  }

  cut(h, fade) {
    if (!h || h.done) return;
    try {
      const t = this.ctx.currentTime;
      h.g.gain.cancelScheduledValues(t);
      h.g.gain.setTargetAtTime(0, t, fade / 3);
      h.src.stop(t + fade + 0.01);
      h.end = t + fade;
      this.stats.cut++;
    } catch (e) { /* ok */ }
  }

  pick(slot, list) {
    const n = list.length;
    let i = 0;
    if (n > 1) {
      i = Math.floor(Math.random() * n) % n;
      if (i === this.last[slot]) i = (i + 1 + Math.floor(Math.random() * (n - 1))) % n;
    }
    this.last[slot] = i;
    return list[i];
  }

  // ---- announcer ---------------------------------------------------------------

  bankFor(faction) {
    const m = this.manifest;
    if (!m) return null;
    const id = (m.factions && Object.prototype.hasOwnProperty.call(m.factions, faction)) ? m.factions[faction] : m.default;
    return m.ann[id] ? id : (m.ann[m.default] ? m.default : Object.keys(m.ann)[0] || null);
  }

  lineFor(req) {
    const id = this.bankFor(req.faction);
    if (!id) return null;
    const bank = this.manifest.ann[id];
    if (!this.warmed[id]) { this.warmed[id] = 1; later(() => this.prefetch(bank), PREFETCH_DELAY); }
    let key = req.key;
    const type = req.detail && req.detail.type;
    if (key === 'built' && type && bank['built.' + type]) key = 'built.' + type;
    const list = bank[key];
    return list ? this.pick('ann/' + id + '/' + key, list) : null;
  }

  // a clip line is playing or loading
  clipActive() {
    if (this.line && this.playing(this.line)) return true;
    return !!this.pendingLine && nowMs() - this.pendingLine.at < LINE_STALE + 500;
  }

  // ... or the speech fallback is talking
  lineActive() {
    return this.clipActive() || nowMs() < this.speechUntil;
  }

  // an announcer line is playing, loading or waiting its turn
  lineBusy() {
    return this.lineActive() || (!!this.queued && nowMs() - this.queued.at < QUEUE_STALE);
  }

  // Speak an announcer line. -> true when it was taken (it may still be
  // dropped later if it goes stale waiting its turn).
  announce(faction, key, detail) {
    try {
      const prio = PRIORITY[key];
      if (prio === undefined || this.dead || this.E.muted) return false;
      if (!this.ctx || this.ctx.state !== 'running') return false;
      const req = { faction, key, detail: detail || null, prio, at: nowMs() };
      if (this.clipActive()) {
        const cur = this.line && this.playing(this.line) ? this.line.prio
          : (this.pendingLine ? this.pendingLine.prio : 3);
        if (prio >= 3 && cur < 3) {
          this.stopLine(0.08);
        } else {
          if (!this.queued || prio >= this.queued.prio || req.at - this.queued.at >= QUEUE_STALE) {
            this.queued = req;
            this.stats.queued++;
          }
          return true;
        }
      }
      this.begin(req, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  begin(req, delay) {
    const token = ++this.lineSeq;
    this.pendingLine = { token, at: nowMs(), prio: req.prio };
    const go = () => {
      try {
        if (token !== this.lineSeq) return;
        const clip = this.state === 'ready' ? this.lineFor(req) : null;
        if (!clip) { this.pendingLine = null; this.fallback(req, null); return; }
        this.buffer(clip).then((buf) => {
          try {
            if (token !== this.lineSeq) return;
            this.pendingLine = null;
            if (!buf) { this.fallback(req, clip.t || null); return; }
            if (nowMs() - req.at > LINE_STALE + QUEUE_STALE || !this.running()) { this.advance(); return; }
            this.playLine(req, clip, buf, delay);
          } catch (e) { this.pendingLine = null; }
        });
      } catch (e) { this.pendingLine = null; }
    };
    if (this.state === 'ready') go(); else this.load().then(go, go);
  }

  playLine(req, clip, buf, delay) {
    if (this.ackH && this.playing(this.ackH)) this.cut(this.ackH, 0.05);
    this.ackSeq++; // an acknowledgement still loading must not land on the line
    // the speech fallback may still be talking (one clip failed, this one did not)
    delay = Math.max(delay || 0, Math.min(3, (this.speechUntil - nowMs()) / 1000));
    const h = this.start(buf, LINE_GAIN, delay);
    h.prio = req.prio;
    h.key = req.key;
    h.onDone = () => { if (this.line === h) { this.line = null; this.advance(); } };
    this.line = h;
    this.stats.lines++;
    this.stats.last = clip.f;
    try { this.E.duck(DUCK_DB, (delay || 0) + buf.duration + 0.1, 0.9); } catch (e) { /* ok */ }
  }

  stopLine(fade) {
    const h = this.line;
    this.line = null;
    this.lineSeq++;
    this.pendingLine = null;
    if (h) this.cut(h, fade);
  }

  advance() {
    const q = this.queued;
    this.queued = null;
    if (q && nowMs() - q.at < QUEUE_STALE && !this.clipActive()) this.begin(q, 0.16);
  }

  // clip unavailable: hand the line to the speech fallback
  fallback(req, text) {
    let secs = 0;
    try {
      if (this.onFallback && nowMs() - req.at <= LINE_STALE) secs = Number(this.onFallback(req.key, text)) || 0;
    } catch (e) { secs = 0; }
    if (secs > 0) {
      this.stats.fallbacks++;
      // the speech engine queues utterances itself: lines add up, nothing waits here
      this.speechUntil = Math.max(this.speechUntil, nowMs()) + secs * 1000;
    }
    this.advance();
  }

  // ---- unit acknowledgements -----------------------------------------------------

  // event: 'select' | 'move' | 'attack'; group: see unitVoiceGroup.
  // -> true when an acknowledgement was started (or is about to be).
  ack(event, group) {
    try {
      if (ACK_EVENTS.indexOf(event) < 0 || this.dead || this.E.muted) return false;
      if (!this.ctx || this.ctx.state !== 'running') return false;
      if (this.state !== 'ready') { if (this.state === 'idle' || this.state === 'failed') this.load(); return false; }
      const slots = this.manifest.ack[group];
      const list = slots ? slots[event] : null;
      if (!list) return false;
      if (this.lineBusy()) return false;
      const now = nowMs();
      const select = event === 'select';
      const cur = this.ackH && this.playing(this.ackH) ? this.ackH : null;
      if (select) {
        if (cur || now - this.selectAt < SELECT_GAP || now - this.ackAt < ACK_GAP) return false;
        this.selectAt = now;
      } else {
        if ((cur && !cur.select) || now - this.orderAt < ACK_GAP) return false;
        this.orderAt = now;
      }
      this.ackAt = now;
      const clip = this.pick('ack/' + group + '/' + event, list);
      const token = ++this.ackSeq;
      this.buffer(clip).then((buf) => {
        try {
          if (!buf || token !== this.ackSeq) return;
          if (nowMs() - now > ACK_LATE) { this.stats.late++; return; }
          if (!this.running() || this.lineBusy()) return;
          if (this.ackH && this.playing(this.ackH)) this.cut(this.ackH, 0.03);
          const h = this.start(buf, ACK_GAIN, 0);
          h.select = select;
          h.onDone = () => { if (this.ackH === h) this.ackH = null; };
          this.ackH = h;
          this.stats.acks++;
          this.stats.last = clip.f;
        } catch (e) { /* ok */ }
      });
      // the rest of this group's replies are likely next: decode them now
      if (!this.warmed['ack/' + group]) {
        this.warmed['ack/' + group] = 1;
        later(() => { try { for (const ev in slots) for (const c of slots[ev]) this.buffer(c); } catch (e) { /* ok */ } }, 400);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- housekeeping ----------------------------------------------------------------

  // new match: forget the queue and the rate limits (decoded clips are kept)
  reset() {
    this.queued = null;
    this.ackAt = this.orderAt = this.selectAt = -Infinity;
  }

  stopAll() {
    try {
      this.queued = null;
      this.stopLine(0.05);
      this.ackSeq++;
      if (this.ackH) this.cut(this.ackH, 0.05);
      this.ackH = null;
    } catch (e) { /* ok */ }
  }

  status() {
    return Object.assign({
      state: this.state, decoded: this.bufs.size, prefetched: this.bytes.size,
      speaking: !!(this.line && this.playing(this.line)), acking: !!(this.ackH && this.playing(this.ackH)),
    }, this.stats);
  }

  dispose() {
    this.stopAll();
    this.dead = true;
    this.bytes.clear(); this.bufs.clear(); this.pending.clear(); this.warm.length = 0;
  }
}

// Net (v0.10.0): WebSocket client for the dumb relay (tools/mca_relay.py).
// Lobby is host-authoritative: peers send their slot state to the host, the
// host rebroadcasts the merged lobby; the host's cfg + start messages define
// the match identically on every peer. In-match the lockstep scheduler
// (net/lockstep.js) consumes cmd/stall/csum/drop/log via the onGameMsg hook.
//
// Everything is dormant unless MULTIPLAYER is used: no sockets are opened in
// offline play and a missing/unreachable relay surfaces a friendly error via
// the onError hook -- the game itself never breaks.
//
// Protocol (JSON envelope {t, from?, to?, ...}):
//   relay:  create/join -> room{code,slot,host} + lobby{slots:[{slot,name}]};
//           membership changes broadcast bye{slot} + lobby; ping/pong
//   lobby:  slot{...}->host, lobby2{slots:[...]} host->all (host-forwarded;
//           the relay stamps `from` on every relayed message), cfg{...} +
//           start{epoch} (host), pause{on} (host-authoritative), chat{msg},
//           nping/npong (per-peer RTT probes)
//   game:   cmd{tick,slot,seq,cmd}, stall{tick}, csum{tick,sum}, drop{slot}
//           (host declares AI takeover), needlog/log (catch-up stream)

export const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8790';
const PEER_PING_EVERY_MS = 2000;  // per-peer RTT probe cadence

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

export const Net = {
  active: false,
  ws: null,
  slot: -1,
  isHost: false,
  code: '',
  url: DEFAULT_RELAY_URL,
  name: '',
  my: { faction: 'Egypt', team: 0, color: 0, ready: false },
  peers: {},        // slot -> {name, faction, team, color, ready, rtt}
  cfg: null,        // host's match cfg {map, seed, delay, players:[...]}
  epoch: 0,
  hooks: {},        // installed by main.js via Net.init
  _peerPingTimer: 0,
  _pingTimes: {},

  init(game, hooks) {
    this.hooks = hooks || {};
    game.net = this;
    return this;
  },

  status() {
    if (!this.active) return 'off';
    if (!this.ws || this.ws.readyState !== 1) return 'down';
    let worst = 0;
    for (const s in this.peers) {
      const r = this.peers[s].rtt;
      if (r !== undefined && r > worst) worst = r;
    }
    return worst > 400 ? 'poor' : worst > 150 ? 'fair' : 'good';
  },

  // ---- connection ---------------------------------------------------------

  _connect(url, onOpen, onFail) {
    if (typeof WebSocket === 'undefined') {
      onFail('WebSocket is not available in this browser/context.');
      return;
    }
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      onFail('Could not open ' + url + ' -- ' + (e && e.message || e));
      return;
    }
    this.ws = ws;
    ws.onopen = () => { onOpen(); };
    ws.onerror = () => {
      if (!this.active) onFail('Could not reach relay at ' + url + ' -- is tools/mca_relay.py running?');
    };
    ws.onclose = () => {
      const wasActive = this.active;
      this.active = false;
      if (wasActive) this._hook('onClose');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      this._handle(msg);
    };
  },

  host(cfg) {
    const url = (cfg && cfg.url) || DEFAULT_RELAY_URL;
    const name = (cfg && cfg.name) || 'Host';
    return new Promise((resolve) => {
      this._connect(url, () => {
        this._pendingResolve = resolve;
        this._send({ t: 'create', name });
      }, (err) => { this._reset(); resolve({ ok: false, error: err }); });
    });
  },

  join(url, code, name) {
    return new Promise((resolve) => {
      this._connect(url || DEFAULT_RELAY_URL, () => {
        this._pendingResolve = resolve;
        this._send({ t: 'join', code: String(code || '').toUpperCase(), name: name || 'Player' });
      }, (err) => { this._reset(); resolve({ ok: false, error: err }); });
    });
  },

  leave() {
    try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'leave' })); } catch (e) { /* no-op */ }
    try { if (this.ws) this.ws.close(); } catch (e) { /* no-op */ }
    this._reset();
  },

  _reset() {
    this.active = false;
    this.ws = null;
    this.slot = -1;
    this.isHost = false;
    this.code = '';
    this.peers = {};
    this.cfg = null;
    this.epoch = 0;
    this._pingTimes = {};
  },

  _hook(name, a, b) {
    const h = this.hooks[name];
    if (typeof h === 'function') { try { h(a, b); } catch (e) { /* hooks must not break the net */ } }
  },

  _send(msg) {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    } catch (e) { /* socket trouble surfaces via onclose */ }
  },

  // ---- inbound --------------------------------------------------------------

  _handle(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'room': {
        this.active = true;
        this.slot = msg.slot;
        this.isHost = !!msg.host;
        this.code = msg.code;
        if (this._pendingResolve) {
          const r = this._pendingResolve;
          this._pendingResolve = null;
          r({ ok: true, slot: msg.slot, host: !!msg.host, code: msg.code });
        }
        this._hook('onRoom', msg);
        break;
      }
      case 'lobby': // relay membership (slot+name only)
        for (const s of msg.slots || []) {
          if (s.slot === this.slot) continue;
          if (!this.peers[s.slot]) this.peers[s.slot] = {};
          this.peers[s.slot].name = s.name;
        }
        this._hook('onMembers', msg.slots);
        break;
      case 'error':
        if (this._pendingResolve) {
          const r = this._pendingResolve;
          this._pendingResolve = null;
          r({ ok: false, error: msg.reason === 'no-such-room'
            ? 'No room with code ' + (msg.code || '?') + '.'
            : msg.reason === 'room-full' ? 'That room is full.'
            : 'Relay error: ' + msg.reason });
        }
        this._hook('onError', msg.reason);
        break;
      case 'bye': // relay-level leave/drop
        if (msg.slot === 0 && !this.isHost) this._hook('onHostLeft', msg);
        else {
          delete this.peers[msg.slot];
          this._hook('onBye', msg.slot, msg.reason);
        }
        break;
      case 'pong':
        break;
      case 'slot': { // a peer's lobby state, routed to the host
        if (!this.isHost) break;
        const slot = msg.from;
        if (!this.peers[slot]) this.peers[slot] = {};
        const p = this.peers[slot];
        for (const k of ['name', 'faction', 'team', 'color', 'ready']) {
          if (msg[k] !== undefined) p[k] = msg[k];
        }
        this.broadcastLobby();
        break;
      }
      case 'lobby2': { // host-forwarded full lobby state
        if (msg.from !== 0) break;
        const keep = this.peers;
        this.peers = {};
        for (const s of msg.slots || []) {
          if (s.slot === this.slot) continue;
          this.peers[s.slot] = {
            name: s.name, faction: s.faction, team: s.team,
            color: s.color, ready: !!s.ready,
            rtt: keep[s.slot] && keep[s.slot].rtt,
          };
        }
        this._hook('onLobby', msg.slots);
        break;
      }
      case 'cfg':
        if (msg.from === 0) { this.cfg = msg.cfg; this._hook('onCfg', msg.cfg); }
        break;
      case 'start':
        if (msg.from === 0) { this.epoch = msg.epoch || 0; this._hook('onStart', msg); }
        break;
      case 'pause':
        this._hook('onPause', !!msg.on, msg.from);
        break;
      case 'chat':
        this._hook('onChat', msg.from, String(msg.msg || '').slice(0, 140));
        break;
      case 'nping':
        if (msg.from !== this.slot) this._send({ t: 'npong', ts: msg.ts, to: msg.from });
        break;
      case 'npong': {
        const p = this.peers[msg.from];
        const t0 = this._pingTimes['n' + msg.from + '_' + msg.ts];
        if (p && t0 !== undefined) {
          const rtt = nowMs() - t0;
          p.rtt = Math.round(p.rtt === undefined ? rtt : p.rtt * 0.5 + rtt * 0.5);
          delete this._pingTimes['n' + msg.from + '_' + msg.ts];
        }
        break;
      }
      default: // cmd/stall/csum/drop/log/needlog -> lockstep scheduler / host
        this._hook('onGameMsg', msg);
        break;
    }
  },

  // ---- lobby channel ----------------------------------------------------------

  sendSlot() {
    this._send(Object.assign({ t: 'slot', to: 0 }, this.my, { name: this.name }));
  },

  lobbySlots() {
    const slots = [{ slot: this.slot, name: this.name, faction: this.my.faction,
      team: this.my.team, color: this.my.color, ready: this.my.ready }];
    for (const s of Object.keys(this.peers).map(Number).sort((a, b) => a - b)) {
      const p = this.peers[s];
      slots.push({ slot: s, name: p.name || ('P' + (s + 1)), faction: p.faction || 'Egypt',
        team: p.team || 0, color: p.color || 0, ready: !!p.ready });
    }
    return slots;
  },

  broadcastLobby() {
    const slots = this.lobbySlots();
    this._send({ t: 'lobby2', slots });
    this._hook('onLobby', slots);
  },

  sendCfg(cfg) {
    this.cfg = cfg;
    this._send({ t: 'cfg', cfg });
  },

  sendStart() {
    this._send({ t: 'start', epoch: nowMs() + 1200 });
  },

  sendPause(on) {
    this._send({ t: 'pause', on: !!on });
  },

  sendChat(text) {
    this._send({ t: 'chat', msg: String(text).slice(0, 140) });
  },

  // ---- game channel -----------------------------------------------------------

  sendGame(msg) {
    this._send(msg);
  },

  sendDrop(slot, at) { // host declares an AI takeover for a dropped slot;
    // `at` is the absolute sim tick the takeover brain activates on (every
    // peer schedules the same tick, so command emission stays aligned)
    this._send({ t: 'drop', slot, at });
    this._hook('onGameMsg', { t: 'drop', slot, at, from: this.slot });
  },

  sendLog(to, entries) { // host streams the command log to a catching-up peer
    this._send({ t: 'log', to, cmds: entries });
  },

  requestLog(fromTick) {
    this._send({ t: 'needlog', fromTick, to: 0 });
  },

  // periodic per-peer RTT probes; call from the frame loop
  netTick() {
    if (!this.active || !this.ws || this.ws.readyState !== 1) return;
    const t = nowMs();
    if (t - this._peerPingTimer < PEER_PING_EVERY_MS) return;
    this._peerPingTimer = t;
    for (const s of Object.keys(this.peers).map(Number)) {
      const ts = Math.round(t) % 100000;
      this._pingTimes['n' + s + '_' + ts] = t;
      this._send({ t: 'nping', ts, to: s });
    }
  },
};

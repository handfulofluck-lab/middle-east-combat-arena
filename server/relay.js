// MCA multiplayer relay: a dumb WebSocket relay with room membership,
// wire-compatible with tools/mca_relay.py (v0.10.0). No game logic lives here:
// clients exchange JSON envelopes ({t:'...', from?, to?, ...}); the relay
// stamps `from` with the sender's room slot and delivers to the other room
// members (or to `to` only, when set).
//
// Relay-level messages (consumed here, never relayed):
//   {t:'create', name}            -> {t:'room', code, slot:0, host:true}
//   {t:'join',   code, name}      -> {t:'room', code, slot, host:false}
//                                    (room members get {t:'lobby', slots:[...]})
//   {t:'leave'}                   -> graceful exit (peers get {t:'bye', slot})
//   {t:'ping', ts}                -> {t:'pong', ts}            (relay RTT)
//   errors                        -> {t:'error', reason, code?, message?}
// Everything else is relayed to the sender's room (minus the sender).
//
// The first joiner is the HOST (slot 0). The host leaving closes the room:
// peers get {t:'bye', slot:0, reason:'host-left'}.
//
// Additive, optional extensions (old clients never send or need them):
//   create {public:true, title, map}  -> the room is listed by GET /api/rooms
//   create/join {license}             -> checked when MCA_PAYWALL != off
//
// Hardening on top of the Python relay: message size cap, per-connection
// message + byte token buckets, global / per-IP connection caps, room cap,
// join-guess throttling, slow-consumer protection, heartbeats, reaping of
// idle rooms and of sockets that never join, graceful shutdown.
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { TokenBucket, KeyedLimiter } from './ratelimit.js';
import { ipKey } from './http-util.js';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const ROOM_CODE_LEN = 4;
export const MAX_SLOTS = 6; // matches the 6-spawn maps

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const MESSAGES = {
  'license-required': (name) => 'Online play on this server requires the ' + name + '.',
  'license-invalid': () => 'That license key is not valid on this server.',
  'license-revoked': () => 'That license key has been revoked.',
  'license-in-use': () => 'That license key is already in use in too many sessions.',
  'server-full': () => 'The server is full. Please try again in a moment.',
  'too-many-connections': () => 'Too many connections from your network.',
  'too-many-attempts': () => 'Too many failed join attempts. Please wait a minute.',
  'rate-limited': () => 'You were disconnected for sending too much data.',
  'already-in-room': () => 'This connection is already in a room.',
  'idle-timeout': () => 'Disconnected: no room was joined.',
  'room-idle': () => 'The room was closed after a long period of inactivity.',
  'server-shutdown': () => 'The server is restarting. Please reconnect in a moment.',
};

// Strip control characters, cap by code points (Python slices by code point).
function cleanLabel(raw, max) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return s.length <= max ? s : Array.from(s).slice(0, max).join('');
}

export class Relay {
  constructor({ config, log, licenses = null, now = Date.now }) {
    this.config = config;
    this.limits = config.limits;
    this.log = log;
    this.licenses = licenses;
    this.now = now;
    this.rooms = new Map();        // code -> room
    this.conns = new Set();        // every accepted connection
    this.ipConns = new Map();      // ip key -> open connections
    this.licenseConns = new Map(); // license id -> connections currently in a room
    this.joinFails = new KeyedLimiter({
      ratePerSec: this.limits.joinFailsPerMin / 60,
      burst: this.limits.joinFailsPerMin,
    });
    this.seq = 0;
    this.closing = false;
    this.timer = null;
    this.counters = { accepted: 0, rejected: 0, messagesIn: 0, messagesOut: 0, roomsCreated: 0, kicked: 0 };
  }

  // ---- lifecycle -------------------------------------------------------------

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.sweep(); } catch (e) { this.log.error('relay.sweep', { err: e }); }
    }, this.limits.heartbeatMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Liveness pings, reaping of never-joined sockets and of idle rooms.
  sweep() {
    const t = this.now();
    for (const conn of this.conns) {
      if (conn.closing) continue;
      if (!conn.alive) {
        this.log.info('conn.dead', { id: conn.id });
        conn.closing = true;
        try { conn.ws.terminate(); } catch (e) { /* no-op */ }
        continue;
      }
      conn.alive = false;
      try { conn.ws.ping(); } catch (e) { /* closing socket */ }
      if (!conn.room && t - conn.unjoinedSince > this.limits.unjoinedTimeoutMs) {
        this.kick(conn, 'idle-timeout', 1000);
      }
    }
    for (const room of [...this.rooms.values()]) {
      if (t - room.lastActivity > this.limits.roomIdleMs) this.closeRoom(room, 'room-idle', 1000);
    }
    this.joinFails.sweep(t);
  }

  // Tell every room, close every socket. Resolves once all sockets are gone
  // (or were force-terminated after graceMs).
  shutdown(reason = 'server-shutdown', graceMs = 3000) {
    this.closing = true;
    this.stop();
    for (const room of [...this.rooms.values()]) this.closeRoom(room, reason, 1001);
    for (const conn of this.conns) {
      if (conn.closing) continue;
      conn.closing = true;
      this.sendError(conn, reason);
      try { conn.ws.close(1001, reason); } catch (e) { /* no-op */ }
    }
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (this.conns.size === 0) return resolve();
        if (Date.now() - started >= graceMs) {
          for (const conn of this.conns) { try { conn.ws.terminate(); } catch (e) { /* no-op */ } }
          return resolve();
        }
        setTimeout(check, 25);
      };
      check();
    });
  }

  // ---- introspection ---------------------------------------------------------

  stats() {
    let peers = 0;
    let publicRooms = 0;
    let inMatch = 0;
    for (const room of this.rooms.values()) {
      peers += room.peers.size;
      if (room.public) publicRooms++;
      if (room.started) inMatch++;
    }
    return { rooms: this.rooms.size, peers, connections: this.conns.size, publicRooms, inMatch };
  }

  // Joinable public rooms for the lobby browser.
  publicRooms(limit = 100) {
    const out = [];
    for (const room of this.rooms.values()) {
      if (!room.public || room.started || room.peers.size >= MAX_SLOTS) continue;
      out.push({ code: room.code, title: room.title, map: room.map, players: room.peers.size, max: MAX_SLOTS, created: room.created });
    }
    out.sort((a, b) => b.created - a.created);
    return out.slice(0, limit).map(({ created, ...rest }) => rest);
  }

  // ---- connections -----------------------------------------------------------

  handleConnection(ws, ip) {
    const t = this.now();
    const key = ipKey(ip);
    const conn = {
      ws, ip, key,
      id: ++this.seq,
      room: null,
      slot: -1,
      name: '',
      lid: null,
      alive: true,
      closing: false,
      registered: false,
      unjoinedSince: t,
      msgs: new TokenBucket(this.limits.rateMsgsPerSec, this.limits.rateBurst, t),
      bytes: new TokenBucket(this.limits.rateBytesPerSec, this.limits.rateBytesBurst, t),
    };
    // 'error' fires for protocol violations (oversize frame, bad UTF-8, ...);
    // ws then closes the socket itself. Never let it become an unhandled event.
    ws.on('error', (err) => {
      this.log.info('conn.error', { id: conn.id, code: err && err.code ? err.code : 'error' });
    });

    let refuse = '';
    if (this.closing) refuse = 'server-shutdown';
    else if (this.conns.size >= this.limits.maxConnections) refuse = 'server-full';
    else if ((this.ipConns.get(key) || 0) >= this.limits.maxConnsPerIp) refuse = 'too-many-connections';
    if (refuse) {
      this.counters.rejected++;
      this.log.warn('conn.refused', { ip, reason: refuse });
      conn.closing = true;
      this.sendError(conn, refuse);
      try { ws.close(1013, refuse); } catch (e) { /* no-op */ }
      const hard = setTimeout(() => { try { ws.terminate(); } catch (e) { /* no-op */ } }, 2000);
      hard.unref();
      ws.on('close', () => clearTimeout(hard));
      return;
    }

    conn.registered = true;
    this.conns.add(conn);
    this.ipConns.set(key, (this.ipConns.get(key) || 0) + 1);
    this.counters.accepted++;
    this.log.info('conn.open', { id: conn.id, ip });

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data, isBinary) => {
      try {
        this.onMessage(conn, data, isBinary);
      } catch (e) {
        // a bug must cost one message, never the process or the room
        this.log.error('relay.message', { id: conn.id, err: e });
      }
    });
    ws.on('close', (code) => {
      try { this.onClose(conn, code); } catch (e) { this.log.error('relay.close', { id: conn.id, err: e }); }
    });
  }

  onClose(conn, code) {
    if (!conn.registered) return;
    conn.registered = false;
    conn.closing = true;
    this.conns.delete(conn);
    const n = (this.ipConns.get(conn.key) || 1) - 1;
    if (n <= 0) this.ipConns.delete(conn.key); else this.ipConns.set(conn.key, n);
    this.detach(conn, 'disconnected');
    this.log.info('conn.close', { id: conn.id, code });
  }

  // ---- protocol --------------------------------------------------------------

  onMessage(conn, data, isBinary) {
    if (conn.closing) return;
    conn.alive = true;
    const t = this.now();
    const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.length;
    if (!conn.msgs.take(1, t) || !conn.bytes.take(size, t)) {
      this.kick(conn, 'rate-limited', 1008);
      return;
    }
    this.counters.messagesIn++;

    let msg;
    try {
      const buf = Array.isArray(data) ? Buffer.concat(data) : data;
      msg = JSON.parse(isBinary ? utf8Strict.decode(buf) : buf.toString('utf8'));
    } catch (e) {
      return; // dumb pipe: ignore non-JSON, never crash
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    const type = msg.t;

    if (!conn.room) {
      this.onUnjoined(conn, msg, type, t);
      return;
    }
    const room = conn.room;
    if (type === 'leave') {
      conn.closing = true;
      this.detach(conn, 'disconnected');
      try { conn.ws.close(1000, 'leave'); } catch (e) { /* no-op */ }
      return;
    }
    if (type === 'ping') {
      this.send(conn, { t: 'pong', ts: hasOwn(msg, 'ts') ? msg.ts : 0 });
      return;
    }
    if (type === 'create' || type === 'join') {
      // never relayed: these envelopes may carry a license token
      this.sendError(conn, 'already-in-room');
      return;
    }

    // Everything else: relay to the room (minus the sender). `from` is
    // stamped by the relay; a client-supplied `from` is overwritten
    // (anti-spoof). `to` must name a current member or the message is dropped.
    let only;
    if (hasOwn(msg, 'to')) {
      only = msg.to;
      if (!Number.isInteger(only) || !room.peers.has(only)) return;
    }
    msg.from = conn.slot;
    room.lastActivity = t;
    if (conn.slot === room.hostSlot) this.observeHost(room, msg);
    // `echo: true` on a room broadcast also returns it to the sender, in
    // room order. It is the only way a peer can learn where its own message
    // landed relative to everyone else's; the lockstep drop declaration
    // depends on that (every peer, the host included, must cut a dropped
    // player's input at the same point of the stream).
    const echo = msg.echo === true && only === undefined;
    let out;
    try { out = JSON.stringify(msg); } catch (e) { return; }
    for (const [slot, peer] of room.peers) {
      if (slot === conn.slot && !echo) continue;
      if (only !== undefined && slot !== only) continue;
      this.sendRaw(peer, out);
    }
  }

  onUnjoined(conn, msg, type, t) {
    if (type === 'ping') {
      // hello/ping before joining: answer liveness, stay unjoined
      this.send(conn, { t: 'pong', ts: hasOwn(msg, 'ts') ? msg.ts : 0 });
      return;
    }
    if (type !== 'create' && type !== 'join') return;

    // One budget per address for wrong room codes and forged license keys:
    // neither can be brute-forced or used to burn CPU on signature checks.
    const gated = this.config.paywall !== 'off';
    if ((type === 'join' || gated) && !this.joinFails.peek(conn.key, 1, t)) {
      this.kick(conn, 'too-many-attempts', 1008);
      return;
    }
    const lic = this.checkLicense(msg);
    if (lic.error) {
      if (lic.error === 'license-invalid') this.joinFails.take(conn.key, 1, t);
      this.sendError(conn, lic.error);
      return;
    }

    let room;
    let slot;
    if (type === 'create') {
      if (this.rooms.size >= this.limits.maxRooms) {
        this.sendError(conn, 'server-full');
        return;
      }
      const code = this.makeCode();
      if (!code) {
        this.sendError(conn, 'server-full');
        return;
      }
      slot = 0;
      room = {
        code,
        peers: new Map(), // slot -> conn
        hostSlot: 0,
        created: t,
        lastActivity: t,
        public: msg.public === true,
        title: '',
        map: cleanLabel(msg.map, 40),
        started: false,
      };
      this.rooms.set(code, room);
      this.counters.roomsCreated++;
    } else {
      const rawCode = msg.code;
      const code = (typeof rawCode === 'string' ? rawCode
        : typeof rawCode === 'number' ? String(rawCode) : '').toUpperCase().slice(0, 32);
      room = this.rooms.get(code);
      if (!room) {
        this.joinFails.take(conn.key, 1, t);
        this.send(conn, { t: 'error', reason: 'no-such-room', code });
        return;
      }
      slot = -1;
      for (let s = 0; s < MAX_SLOTS; s++) {
        if (!room.peers.has(s)) { slot = s; break; }
      }
      if (slot < 0) {
        this.send(conn, { t: 'error', reason: 'room-full', code });
        return;
      }
    }

    conn.name = cleanLabel(msg.name, 24) || ('P' + (slot + 1));
    conn.room = room;
    conn.slot = slot;
    room.peers.set(slot, conn);
    room.lastActivity = t;
    if (lic.lid) {
      conn.lid = lic.lid;
      this.licenseConns.set(lic.lid, (this.licenseConns.get(lic.lid) || 0) + 1);
    }
    if (type === 'create') {
      room.title = cleanLabel(msg.title, 48) || (conn.name + "'s room");
      this.log.info('room.create', { room: room.code, id: conn.id, public: room.public });
    } else {
      this.log.info('room.join', { room: room.code, id: conn.id, slot });
    }
    this.send(conn, { t: 'room', code: room.code, slot, host: slot === room.hostSlot });
    this.broadcast(room, { t: 'lobby', slots: this.slotsPayload(room) });
  }

  // Paywall: when MCA_PAYWALL is 'multiplayer' or 'full', hosting and joining
  // need a valid, unrevoked license token.
  checkLicense(msg) {
    if (this.config.paywall === 'off') return {};
    if (!this.licenses) return { error: 'license-required' };
    const token = msg.license;
    if (typeof token !== 'string' || !token) return { error: 'license-required' };
    const v = this.licenses.verify(token);
    if (!v.ok) return { error: v.reason === 'revoked' ? 'license-revoked' : 'license-invalid' };
    const max = this.limits.maxConnsPerLicense;
    if (max > 0 && (this.licenseConns.get(v.payload.lid) || 0) >= max) return { error: 'license-in-use' };
    return { lid: v.payload.lid };
  }

  // Passive, read-only peeks at host traffic to keep the public listing
  // honest (current map; hide rooms whose match has started). The messages
  // themselves are relayed untouched.
  observeHost(room, msg) {
    if (msg.t === 'cfg') {
      const cfg = msg.cfg;
      if (cfg && typeof cfg === 'object' && typeof cfg.map === 'string') room.map = cleanLabel(cfg.map, 40);
    } else if (msg.t === 'start') {
      room.started = true;
    }
  }

  slotsPayload(room) {
    return [...room.peers.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({ slot: p.slot, name: p.name }));
  }

  makeCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return '';
  }

  releaseLicense(conn) {
    if (!conn.lid) return;
    const n = (this.licenseConns.get(conn.lid) || 1) - 1;
    if (n <= 0) this.licenseConns.delete(conn.lid); else this.licenseConns.set(conn.lid, n);
    conn.lid = null;
  }

  // Take a connection out of its room and tell the others.
  detach(conn, reason) {
    const room = conn.room;
    if (!room) return;
    const slot = conn.slot;
    const t = this.now();
    conn.room = null;
    conn.slot = -1;
    conn.unjoinedSince = t;
    this.releaseLicense(conn);
    room.peers.delete(slot);
    if (this.rooms.get(room.code) !== room) return;
    this.log.info('room.leave', { room: room.code, id: conn.id, slot, reason });

    if (slot === room.hostSlot) {
      // host gone: close the room, tell everyone. The others go back to the
      // unjoined state (their sockets stay open, as with the Python relay).
      const others = [...room.peers.values()].sort((a, b) => a.slot - b.slot);
      room.peers.clear();
      this.rooms.delete(room.code);
      for (const other of others) {
        other.room = null;
        other.slot = -1;
        other.unjoinedSince = t;
        this.releaseLicense(other);
        this.send(other, { t: 'bye', slot, reason: 'host-left' });
      }
      this.log.info('room.close', { room: room.code, reason: 'host-left' });
      return;
    }
    if (room.peers.size === 0) {
      this.rooms.delete(room.code);
      this.log.info('room.close', { room: room.code, reason: 'empty' });
      return;
    }
    this.broadcast(room, { t: 'bye', slot, reason });
    this.broadcast(room, { t: 'lobby', slots: this.slotsPayload(room) });
  }

  // Server-initiated room close (idle reaping, shutdown). Old clients
  // understand both envelopes: `error` surfaces the reason, and
  // `bye{slot:<host>}` makes non-hosts leave the dead lobby/match.
  closeRoom(room, reason, closeCode) {
    if (this.rooms.get(room.code) !== room) return;
    const peers = [...room.peers.values()];
    room.peers.clear();
    this.rooms.delete(room.code);
    this.log.info('room.close', { room: room.code, reason });
    for (const peer of peers) {
      const wasHost = peer.slot === room.hostSlot;
      peer.room = null;
      peer.slot = -1;
      this.releaseLicense(peer);
      this.sendError(peer, reason);
      if (!wasHost) this.send(peer, { t: 'bye', slot: room.hostSlot, reason });
      peer.closing = true;
      try { peer.ws.close(closeCode, reason); } catch (e) { /* no-op */ }
    }
  }

  // Protocol violation / abuse: tell the client why, leave its room now,
  // close; force the socket shut if the close handshake is not completed.
  kick(conn, reason, closeCode) {
    if (conn.closing) return;
    this.counters.kicked++;
    this.log.warn('conn.kick', { id: conn.id, ip: conn.ip, reason });
    this.sendError(conn, reason);
    conn.closing = true;
    this.detach(conn, 'disconnected');
    try { conn.ws.close(closeCode, reason); } catch (e) { /* no-op */ }
    const hard = setTimeout(() => { try { conn.ws.terminate(); } catch (e) { /* no-op */ } }, 2000);
    hard.unref();
    conn.ws.once('close', () => clearTimeout(hard));
  }

  // ---- sending ---------------------------------------------------------------

  sendError(conn, reason, extra) {
    const make = MESSAGES[reason];
    const msg = { t: 'error', reason };
    if (make) msg.message = make(this.config.product.name);
    this.send(conn, extra ? Object.assign(msg, extra) : msg);
  }

  send(conn, obj) {
    return this.sendRaw(conn, JSON.stringify(obj));
  }

  sendRaw(conn, text) {
    const ws = conn.ws;
    if (ws.readyState !== WebSocket.OPEN) return false;
    // A peer that stops reading must not make this process buffer without
    // bound: past the cap it is treated as dead.
    if (ws.bufferedAmount > this.limits.maxBufferedBytes) {
      if (!conn.closing) {
        this.log.warn('conn.slow', { id: conn.id, buffered: ws.bufferedAmount });
        conn.closing = true;
        try { ws.terminate(); } catch (e) { /* no-op */ }
      }
      return false;
    }
    this.counters.messagesOut++;
    ws.send(text, (err) => {
      if (err) { try { ws.terminate(); } catch (e) { /* no-op */ } }
    });
    return true;
  }

  broadcast(room, obj) {
    const text = JSON.stringify(obj);
    for (const peer of room.peers.values()) this.sendRaw(peer, text);
  }
}

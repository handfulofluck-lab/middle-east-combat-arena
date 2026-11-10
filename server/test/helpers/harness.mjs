// Shared test harness: boots the real server in-process on a free port in the
// 8800-8899 range (dev servers own 5173-5190), with a throwaway web root and
// data directory, and offers a small promise-based WebSocket client.
import crypto from 'node:crypto';
import fs from 'node:fs';
import httpMod from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../log.js';

const PORT_MIN = 8800;
const PORT_SPAN = 100;
let cursor = (process.pid * 7 + crypto.randomInt(PORT_SPAN)) % PORT_SPAN;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Listen on the first free port of the range. `tryListen(port)` must reject
// with code EADDRINUSE when the port is taken.
export async function listenInRange(tryListen) {
  let lastErr = null;
  for (let i = 0; i < PORT_SPAN; i++) {
    const port = PORT_MIN + (cursor++ % PORT_SPAN);
    try {
      await tryListen(port);
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('no free port in 8800-8899');
}

export function makeTempDir(prefix = 'mca-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A stand-in for dist/web with one file of every kind the tests care about.
export function makeWebRoot(dir) {
  const root = path.join(dir, 'web');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'maps'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'),
    '<!doctype html>\n<html><head><meta charset="utf-8"><title>MCA test shell</title>\n'
    + '<script src="config.js"></script>\n'
    + '<script>window.__boot = "inline";</script>\n'
    + '<script type="module" src="./assets/index-BxK3a9Zq.js"></script>\n'
    + '</head><body><div id="app">MCA test shell</div></body></html>\n');
  fs.writeFileSync(path.join(root, 'assets', 'index-BxK3a9Zq.js'), 'export const answer = 42; // filler\n'.repeat(600));
  fs.writeFileSync(path.join(root, 'assets', 'style-Dq7hXk2P.css'), 'body { margin: 0; }\n'.repeat(200));
  fs.writeFileSync(path.join(root, 'assets', 'art.json'), JSON.stringify({ filler: 'x'.repeat(4000) }));
  fs.writeFileSync(path.join(root, 'assets', 'tiny.json'), '{"a":1}');
  fs.writeFileSync(path.join(root, 'assets', 'music.mp3'), crypto.randomBytes(5000));
  fs.writeFileSync(path.join(root, 'maps', 'manifest.json'), JSON.stringify({ maps: ['sinai'], pad: 'm'.repeat(3000) }));
  fs.writeFileSync(path.join(root, '.env'), 'LICENSE_SECRET=must-never-be-served\n');
  fs.writeFileSync(path.join(dir, 'outside-secret.txt'), 'TOP-SECRET-OUTSIDE-WEB-ROOT\n');
  try { fs.symlinkSync(path.join(dir, 'outside-secret.txt'), path.join(root, 'assets', 'link.txt')); } catch (e) { /* no symlinks here */ }
  return root;
}

// Boot the real app. Returns handles plus `close()` (graceful, removes temp files).
export async function startServer(env = {}, options = {}) {
  const dir = options.dir || makeTempDir();
  const webRoot = options.webRoot || makeWebRoot(dir);
  const dataDir = path.join(dir, 'data');
  const logs = [];
  const log = createLogger({ level: 'debug', write: (line) => { logs.push(JSON.parse(line)); } });
  const config = loadConfig({ HOST: '127.0.0.1', WEB_ROOT: webRoot, DATA_DIR: dataDir, ...env });
  const app = createApp(config, { log });
  const port = await listenInRange((p) => app.listen(p, '127.0.0.1'));
  const origin = 'http://127.0.0.1:' + port;
  return {
    app,
    config,
    port,
    dir,
    webRoot,
    dataDir,
    logs,
    origin,
    wsUrl: 'ws://127.0.0.1:' + port + '/ws',
    bareWsUrl: 'ws://127.0.0.1:' + port,
    async close() {
      await app.close('server-shutdown', 300);
      if (!options.dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Promise-based WebSocket test client.
export class Client {
  constructor(ws) {
    this.ws = ws;
    this.inbox = [];
    this.waiters = [];
    this.closeInfo = null;
    this.closeWaiters = [];
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (e) { msg = { __raw: data.toString('utf8') }; }
      this.inbox.push(msg);
      this._pump();
    });
    ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString('utf8') };
      for (const w of this.closeWaiters) w(this.closeInfo);
      this.closeWaiters = [];
    });
    ws.on('error', () => { /* surfaced through close */ });
  }

  static open(url, wsOptions) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, wsOptions);
      const client = new Client(ws);
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (req, res) => {
        const err = new Error('unexpected response ' + res.statusCode);
        err.statusCode = res.statusCode;
        res.resume();
        reject(err);
      });
      ws.once('error', (err) => reject(err));
    });
  }

  _pump() {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      const idx = this.inbox.findIndex(w.pred);
      if (idx >= 0) {
        const [msg] = this.inbox.splice(idx, 1);
        clearTimeout(w.timer);
        this.waiters.splice(i--, 1);
        w.resolve(msg);
      }
    }
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  sendRaw(data, opts) { this.ws.send(data, opts); }

  // Resolve with (and consume) the first message matching `match`
  // (a type string or a predicate).
  next(match, timeoutMs = 3000) {
    const pred = typeof match === 'string' ? (m) => m.t === match : match;
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('timed out waiting for ' + (typeof match === 'string' ? match : 'message')
          + '; inbox=' + JSON.stringify(this.inbox).slice(0, 400)));
      }, timeoutMs);
      this.waiters.push(waiter);
      this._pump();
    });
  }

  // Assert-helper: true when nothing matching arrives within `ms`.
  async quiet(match, ms = 150) {
    const pred = typeof match === 'string' ? (m) => m.t === match : match;
    await sleep(ms);
    return !this.inbox.some(pred);
  }

  drain() {
    const out = this.inbox;
    this.inbox = [];
    return out;
  }

  // Barrier: a socket is ordered, so once the pong for this ping is in,
  // everything the relay sent us earlier has been received too.
  async sync() {
    const ts = 'sync-' + (++Client.seq);
    this.send({ t: 'ping', ts });
    await this.next((m) => m.t === 'pong' && m.ts === ts);
  }

  // sync, then forget everything received so far
  async flush() {
    await this.sync();
    return this.drain();
  }

  waitClose(timeoutMs = 3000) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
      this.closeWaiters.push((info) => { clearTimeout(timer); resolve(info); });
    });
  }

  get open() { return this.ws.readyState === WebSocket.OPEN; }

  close() { try { this.ws.close(); } catch (e) { /* no-op */ } }

  terminate() { try { this.ws.terminate(); } catch (e) { /* no-op */ } }
}

Client.seq = 0;

export async function flush(...clients) {
  for (const c of clients) await c.flush();
}

// create a room, returning { host, code }
export async function hostRoom(url, extra = {}) {
  const host = await Client.open(url);
  host.send({ t: 'create', name: 'host', ...extra });
  const room = await host.next('room');
  await host.next('lobby');
  return { host, code: room.code, room };
}

export async function joinRoom(url, code, name = 'joiner', extra = {}) {
  const peer = await Client.open(url);
  peer.send({ t: 'join', code, name, ...extra });
  const room = await peer.next('room');
  await peer.next('lobby');
  return { peer, room };
}

// fetch that returns { status, headers, text, json }
export async function http(url, init) {
  const res = await fetch(url, init);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, headers: res.headers, text, json, buf };
}

export const TEST_SECRETS = Object.freeze({
  LICENSE_SECRET: 'kT9$wq2Lm#8zXv4Rp!7Jc6Nh3Fd5Gb1Ys0Ae-Uo',
  ADMIN_TOKEN: 'adm-7Qx2Lw9Zr4Tn6Vb8Mc1Kd3Hf5Jg0P',
  STRIPE_SECRET_KEY: 'sk_test_51MockKeyForLocalTestsOnly0000',
  STRIPE_PRICE_ID: 'price_1MockFoundersPass',
  STRIPE_WEBHOOK_SECRET: 'whsec_MockSigningSecretForTests0001',
});

// ---- raw clients (no library conveniences) ----------------------------------

// Raw HTTP request: no automatic decompression, exact status + headers + bytes.
export function rawRequest(url, { method = 'GET', headers = {}, body = null, path: rawPath = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpMod.request({
      host: u.hostname,
      port: u.port,
      method,
      path: rawPath !== null ? rawPath : u.pathname + u.search, // rawPath is sent verbatim (traversal tests)
      headers,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

// A hand-rolled WebSocket client over a TCP socket. Unlike a real client it
// never answers pings and can stop reading -- exactly what the heartbeat and
// slow-consumer protections must cope with.
export function rawWebSocket(port, wsPath = '/ws') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const api = {
      socket,
      closed: false,
      bytesIn: 0,
      sendText(text) {
        const payload = Buffer.from(text, 'utf8');
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
        else if (payload.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
        socket.write(Buffer.concat([header, mask, masked]));
      },
      waitClosed(timeoutMs = 3000) {
        if (api.closed) return Promise.resolve(true);
        return new Promise((res2, rej2) => {
          const timer = setTimeout(() => rej2(new Error('raw socket still open')), timeoutMs);
          socket.once('close', () => { clearTimeout(timer); res2(true); });
        });
      },
    };
    socket.on('connect', () => {
      socket.write('GET ' + wsPath + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\n'
        + 'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    socket.on('data', (chunk) => {
      api.bytesIn += chunk.length;
      if (upgraded) return;
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.1 101 /.test(head)) {
        reject(new Error('handshake refused: ' + head.split('\r\n')[0]));
        socket.destroy();
        return;
      }
      upgraded = true;
      resolve(api);
    });
    socket.on('close', () => { api.closed = true; });
    socket.on('error', (err) => { if (!upgraded) reject(err); });
  });
}

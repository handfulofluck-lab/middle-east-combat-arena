// Small HTTP helpers shared by the static handler, the API and the relay.
import crypto from 'node:crypto';
import net from 'node:net';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let ip = raw.trim();
  if (ip.startsWith('[')) {                 // "[::1]:1234" / "[::1]"
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));  // "1.2.3.4:5678"
  }
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip.toLowerCase() : '';
}

// The address a request really came from. Forwarding headers are read ONLY
// when TRUST_PROXY says a proxy we control sits in front of us; otherwise any
// client could pick its own address and walk around the per-IP limits.
//   trustProxy = n  ->  the n-th entry from the right of X-Forwarded-For
//                       (each trusted proxy appends the peer it saw)
//   clientIpHeader  ->  a single-value header set by the platform
//                       (fly-client-ip, cf-connecting-ip, ...), if present
export function clientIp(req, config) {
  const socketIp = normalizeIp(req.socket && req.socket.remoteAddress) || 'unknown';
  if (!config.trustProxy) return socketIp;
  if (config.clientIpHeader) {
    const v = req.headers[config.clientIpHeader];
    const ip = normalizeIp(Array.isArray(v) ? v[0] : v);
    if (ip) return ip;
  }
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const idx = parts.length - config.trustProxy;
    const ip = normalizeIp(parts[Math.max(0, idx)]);
    if (ip) return ip;
  }
  return socketIp;
}

// Rate-limit key for an address: IPv4 as-is, IPv6 collapsed to its /64 (one
// subscriber usually owns the whole /64 and could otherwise rotate freely).
export function ipKey(ip) {
  if (!net.isIPv6(ip)) return ip;
  let head = ip;
  let tail = '';
  const dbl = ip.indexOf('::');
  if (dbl >= 0) {
    head = ip.slice(0, dbl);
    tail = ip.slice(dbl + 2);
  }
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = dbl >= 0 ? h.concat(new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), t) : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// The public host a request was addressed to (for same-origin checks).
export function requestHost(req, config) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-host'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim().toLowerCase();
  }
  return String(req.headers.host || '').toLowerCase();
}

// Is this Origin header one we serve? '' (no Origin header at all) is decided
// by the caller. Same-origin = the Origin's host equals the Host the request
// was sent to (a browser cannot forge either), or PUBLIC_URL's origin.
export function originIsOurs(origin, req, config) {
  let u;
  try { u = new URL(origin); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const o = u.origin.toLowerCase();
  if (config.publicOrigin && o === config.publicOrigin) return true;
  const host = requestHost(req, config);
  if (host && u.host.toLowerCase() === host) return true;
  if (config.trustProxy && String(req.headers.host || '').toLowerCase() === u.host.toLowerCase()) return true;
  return false;
}

export function originIsAllowed(origin, config) {
  let u;
  try { u = new URL(origin); } catch (e) { return false; }
  return config.allowedOrigins.has(u.origin.toLowerCase());
}

// Read a request body with a hard size limit. Rejects with HttpError(413)
// as soon as the limit is crossed (the rest of the upload is discarded).
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'payload-too-large', 'Request body is too large.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (err) reject(err); else resolve(value);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        finish(new HttpError(413, 'payload-too-large', 'Request body is too large.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('aborted', () => finish(new HttpError(400, 'aborted', 'Request aborted.')));
    req.on('close', () => finish(new HttpError(400, 'aborted', 'Request aborted.'))); // no-op after 'end'
    req.on('error', () => finish(new HttpError(400, 'bad-request', 'Request failed.')));
  });
}

export async function readJson(req, limit) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    req.resume();
    throw new HttpError(415, 'unsupported-media-type', 'Send JSON with Content-Type: application/json.');
  }
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  let value;
  try { value = JSON.parse(buf.toString('utf8')); } catch (e) {
    throw new HttpError(400, 'invalid-json', 'Request body is not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid-json', 'Request body must be a JSON object.');
  }
  return value;
}

export function sendJson(res, status, body, extraHeaders) {
  if (res.headersSent) { try { res.end(); } catch (e) { /* no-op */ } return; }
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : payload);
}

// Constant-time string equality. Both sides are hashed first so neither the
// content nor the LENGTH of the expected value leaks through timing.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Which content-coding may we use? Honors q=0 ("not acceptable").
export function pickEncoding(header) {
  if (typeof header !== 'string' || !header) return '';
  const accepted = new Map();
  for (const part of header.split(',')) {
    const [nameRaw, ...params] = part.trim().split(';');
    const name = nameRaw.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    accepted.set(name, Number.isFinite(q) ? q : 0);
  }
  const ok = (name) => (accepted.has(name) ? accepted.get(name) > 0 : (accepted.get('*') || 0) > 0);
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return '';
}

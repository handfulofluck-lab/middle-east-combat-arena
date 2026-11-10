// One process, one port: static client + /config.js + /healthz + /api/* +
// the WebSocket relay (on /ws and on /, for the Python relay's bare URL).
// Meant to sit behind a TLS-terminating proxy (Render, Fly, Railway, nginx...).
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createApi } from './api.js';
import { describeConfig } from './config.js';
import {
  HttpError, clientIp, originIsAllowed, originIsOurs, requestHost, sendJson,
} from './http-util.js';
import { createLicenseService } from './license.js';
import { createLogger } from './log.js';
import { Relay } from './relay.js';
import { createStaticHandler } from './static.js';
import { createStripeClient } from './stripe.js';

const MAX_URL_LENGTH = 2048;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/i;

export class ConfigError extends Error {
  constructor(errors) {
    super('Invalid configuration:\n  - ' + errors.join('\n  - '));
    this.errors = errors;
  }
}

// JSON that is also safe to embed in a <script> / JS file.
function jsLiteral(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

export function createApp(config, options = {}) {
  if (config.errors.length) throw new ConfigError(config.errors);
  const log = options.log || createLogger({ level: config.logLevel });
  const startedAt = Date.now();

  // ---- licensing / payments (dormant until configured) ---------------------
  let licenses = null;
  if (config.features.licensing.enabled) {
    try {
      licenses = createLicenseService({
        secret: config.secrets.license,
        productId: config.product.id,
        dataDir: config.dataDir,
        log,
      });
    } catch (e) {
      // Without a durable ledger we cannot issue or revoke: stay disabled.
      if (config.paywall !== 'off') {
        throw new ConfigError(['MCA_PAYWALL=' + config.paywall + ' needs a writable DATA_DIR (' + config.dataDir + '): ' + (e.code || e.message)]);
      }
      log.error('license.disabled', { reason: 'DATA_DIR is not usable', dir: config.dataDir, err: e.code || e.message });
    }
  }
  const features = {
    licensing: !!licenses,
    store: !!licenses && config.features.store.enabled,
    admin: !!licenses && config.features.admin.enabled,
  };
  const stripe = features.store
    ? createStripeClient({ secretKey: config.secrets.stripeKey, apiBase: config.stripe.apiBase, fetchImpl: options.fetchImpl })
    : null;

  // ---- relay ---------------------------------------------------------------
  const relay = new Relay({ config, log, licenses });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.limits.maxMsgBytes,
    perMessageDeflate: false, // tiny JSON frames; avoids zlib memory per socket
    clientTracking: false,
  });
  let pendingUpgrades = 0;

  const api = createApi({ config, log, relay, licenses, stripe, features });

  // ---- response headers ----------------------------------------------------
  function contentSecurityPolicy(req, scriptHashes) {
    if (config.cspOverride) return config.cspOverride;
    const connect = ["'self'"];
    const host = requestHost(req, config);
    if (HOST_RE.test(host)) connect.push('ws://' + host, 'wss://' + host);
    if (config.relayUrl) {
      const u = new URL(config.relayUrl);
      connect.push(u.protocol + '//' + u.host);
    }
    if (config.apiBase) connect.push(new URL(config.apiBase).origin);
    connect.push('data:', 'blob:');
    const policy = new Map([
      ['default-src', ["'self'"]],
      ['script-src', ["'self'", "'wasm-unsafe-eval'", ...scriptHashes]],
      ['style-src', ["'self'", "'unsafe-inline'"]],
      ['img-src', ["'self'", 'data:', 'blob:']],
      ['media-src', ["'self'", 'data:', 'blob:']],
      ['font-src', ["'self'", 'data:']],
      ['connect-src', connect],
      ['worker-src', ["'self'", 'blob:']],
      ['object-src', ["'none'"]],
      ['base-uri', ["'self'"]],
      ['form-action', ["'self'"]],
      ['frame-ancestors', config.frameAncestors ? config.frameAncestors.split(/\s+/) : ["'self'"]],
    ]);
    for (const extra of config.cspExtra) {
      const current = policy.get(extra.directive) || [];
      policy.set(extra.directive, current.filter((src) => src !== "'none'").concat(extra.sources));
    }
    return [...policy].map(([name, sources]) => name + ' ' + [...new Set(sources)].join(' ')).join('; ');
  }

  function securityHeaders(req, { isHtml, scriptHashes }) {
    const h = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (config.hsts) h['Strict-Transport-Security'] = 'max-age=31536000';
    if (isHtml) {
      h[config.cspReportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'] = contentSecurityPolicy(req, scriptHashes);
      h['Cross-Origin-Opener-Policy'] = 'same-origin';
      h['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';
      if (!config.frameAncestors) h['X-Frame-Options'] = 'SAMEORIGIN';
    }
    return h;
  }

  const staticHandler = createStaticHandler({ root: config.webRoot, log, headersFor: securityHeaders });

  // ---- built-in routes -----------------------------------------------------
  function clientConfig() {
    return {
      relayUrl: config.relayUrl,        // '' = same origin (/ws), resolved client-side
      apiBase: config.apiBase,          // '' = same origin
      paywall: config.paywall,
      storeEnabled: features.store,     // true only when Stripe is fully configured
      redeemEnabled: features.licensing, // license keys can be verified here
      product: { name: config.product.name, priceLabel: config.product.priceLabel },
      version: config.version,
    };
  }

  function serveConfigJs(req, res) {
    const body = Buffer.from(
      '// Generated by server/index.js from the environment. A static host ships\n'
      + '// client/public/config.js instead.\n'
      + 'window.MCA_CONFIG = Object.assign(' + jsLiteral(clientConfig()) + ', window.MCA_CONFIG || {});\n',
      'utf8',
    );
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function serveHealth(req, res) {
    const s = relay.stats();
    sendJson(res, 200, {
      status: relay.closing ? 'draining' : 'ok',
      uptime: Math.round((Date.now() - startedAt) / 1000),
      rooms: s.rooms,
      peers: s.peers,
      connections: s.connections,
      version: config.version,
      paywall: config.paywall,
      storeEnabled: features.store,
    });
  }

  let warnedForwarded = false;

  async function onRequest(req, res) {
    const raw = req.url || '/';
    const q = raw.indexOf('?');
    const pathname = q < 0 ? raw : raw.slice(0, q);
    const query = q < 0 ? '' : raw.slice(q + 1);
    try {
      if (!warnedForwarded && !config.trustProxy && req.headers['x-forwarded-for']) {
        warnedForwarded = true;
        log.warn('proxy.untrusted', {
          note: 'X-Forwarded-For is present but TRUST_PROXY is not set: per-IP limits see the proxy address, not the player. Set TRUST_PROXY=1 behind a reverse proxy.',
        });
      }
      if (raw.length > MAX_URL_LENGTH) {
        res.writeHead(414, { 'Content-Length': 0, Connection: 'close' });
        res.end();
        return;
      }
      if (!pathname.startsWith('/')) {
        res.writeHead(400, { 'Content-Length': 0, Connection: 'close' });
        res.end();
        return;
      }
      if (pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET, HEAD' });
          return;
        }
        serveHealth(req, res);
        return;
      }
      if (pathname === '/config.js' && (req.method === 'GET' || req.method === 'HEAD')) {
        serveConfigJs(req, res);
        return;
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        await api.handle(req, res, pathname, query);
        log.debug('http.api', { method: req.method, path: pathname, status: res.statusCode });
        return;
      }
      await staticHandler.handle(req, res, pathname);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 413) {
          // stop reading a body we refused; drop the connection afterwards
          res.setHeader('Connection', 'close');
          res.once('finish', () => { try { req.destroy(); } catch (err) { /* no-op */ } });
        }
        sendJson(res, e.status, { error: e.code, message: e.message });
        return;
      }
      log.error('http.error', { method: req.method, path: pathname, err: e });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Internal server error.' });
      else { try { res.destroy(); } catch (err) { /* no-op */ } }
    }
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((e) => {
      log.error('http.fatal', { err: e });
      try { res.destroy(); } catch (err) { /* no-op */ }
    });
  });
  // Behind a load balancer the keep-alive timeout must outlive the proxy's
  // idle timeout (commonly 60 s), or the proxy reuses sockets we just closed.
  server.keepAliveTimeout = 75000;
  server.headersTimeout = 80000;
  server.requestTimeout = 30000;
  server.maxRequestsPerSocket = 1000;

  server.on('clientError', (err, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  function refuseUpgrade(socket, status, text) {
    try {
      socket.end('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } catch (e) { /* no-op */ }
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* a reset during the handshake is not our problem */ });
    try {
      const raw = req.url || '/';
      const q = raw.indexOf('?');
      const pathname = q < 0 ? raw : raw.slice(0, q);
      if (raw.length > MAX_URL_LENGTH || (pathname !== '/ws' && pathname !== '/ws/' && pathname !== '/')) {
        refuseUpgrade(socket, 404, 'Not Found');
        return;
      }
      if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        refuseUpgrade(socket, 400, 'Bad Request');
        return;
      }
      // Optional origin allowlist. Browsers always send Origin on WebSocket
      // handshakes, so with ALLOWED_ORIGINS set only our own pages (and the
      // listed ones) can use this relay from a browser.
      if (config.allowedOrigins.size > 0) {
        const origin = req.headers.origin;
        if (!origin || !(originIsAllowed(origin, config) || originIsOurs(origin, req, config))) {
          log.warn('ws.origin.refused', { origin: typeof origin === 'string' ? origin.slice(0, 120) : '(none)' });
          refuseUpgrade(socket, 403, 'Forbidden');
          return;
        }
      }
      // Hard ceiling (cheap refusal before any WebSocket state exists). The
      // friendlier in-band 'server-full' envelope is sent by the relay below.
      if (relay.conns.size + pendingUpgrades >= config.limits.maxConnections + 64) {
        refuseUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      const ip = clientIp(req, config);
      pendingUpgrades++;
      let settled = false;
      const settle = () => { if (!settled) { settled = true; pendingUpgrades--; } };
      socket.once('close', settle);
      wss.handleUpgrade(req, socket, head, (ws) => {
        settle();
        relay.handleConnection(ws, ip);
      });
    } catch (e) {
      log.error('ws.upgrade', { err: e });
      socket.destroy();
    }
  });

  let closed = false;

  return {
    config,
    features,
    server,
    relay,
    licenses,
    log,

    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          relay.start();
          resolve(server.address());
        });
      });
    },

    describe() {
      return { ...describeConfig(config), features };
    },

    // Graceful stop: refuse new work, tell every room, close sockets, release
    // the ledger. Safe to call more than once.
    async close(reason = 'server-shutdown', graceMs = 3000) {
      if (closed) return;
      closed = true;
      api.close();
      const httpClosed = new Promise((resolve) => server.close(() => resolve()));
      await relay.shutdown(reason, graceMs);
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      const forced = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }, Math.max(100, graceMs));
      forced.unref();
      await httpClosed;
      clearTimeout(forced);
      if (licenses) licenses.close();
    },
  };
}

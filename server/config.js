// Environment -> validated, frozen configuration. Pure (no side effects beyond
// reading package.json for the version) so tests can build configs from plain
// objects. Secrets live under a NON-ENUMERABLE `secrets` property so that an
// accidental JSON.stringify(config) or log line can never contain them.
//
// Policy for money-adjacent features:
//   * a feature with missing or weak key material is DISABLED and says why
//     (`config.features.*.reasons`); it never runs in a degraded mode;
//   * a paywall that could not possibly be satisfied (MCA_PAYWALL != off with
//     no working license signing) is a FATAL configuration error: the server
//     refuses to start rather than silently giving the game away or locking
//     every player out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PAYWALL_MODES = ['off', 'multiplayer', 'full'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

function str(env, name) {
  const v = env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function flag(env, name) {
  return /^(1|true|yes|on)$/i.test(str(env, name));
}

// Why a secret is not acceptable, or 'ok'. Deliberately conservative: a short
// or obviously-placeholder secret must never sign licenses or guard admin.
export function secretStrength(value, minLength) {
  if (typeof value !== 'string' || value.length === 0) return 'missing';
  if (value.length < minLength) return 'shorter than ' + minLength + ' characters';
  if (new Set(value).size < 10) return 'too little variety (looks like a placeholder)';
  if (/(change.?me|placeholder|example|your.?secret|your.?token|password|xxxxxx|123456)/i.test(value)) {
    return 'looks like a placeholder';
  }
  return 'ok';
}

function parseOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin.toLowerCase();
  } catch (e) {
    return null;
  }
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname).toLowerCase());
}

export function loadConfig(env = process.env) {
  const errors = [];   // fatal: the server must not start
  const warnings = []; // logged once at boot

  function int(name, def, min, max) {
    const raw = str(env, name);
    if (raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
      errors.push(name + ' must be an integer between ' + min + ' and ' + max + ' (got "' + raw.slice(0, 40) + '")');
      return def;
    }
    return n;
  }

  // ---- core ---------------------------------------------------------------
  const port = int('PORT', 8790, 0, 65535);
  const host = str(env, 'HOST') || '0.0.0.0';
  const webRoot = path.resolve(REPO_ROOT, str(env, 'WEB_ROOT') || 'dist/web');
  const dataDir = path.resolve(REPO_ROOT, str(env, 'DATA_DIR') || 'data');
  const logLevel = (str(env, 'LOG_LEVEL') || 'info').toLowerCase();

  // PUBLIC_URL: where players load the game (used for Checkout return URLs).
  let publicUrl = '';
  let publicOrigin = '';
  let publicUrlSecure = false;
  const rawPublic = str(env, 'PUBLIC_URL');
  if (rawPublic) {
    try {
      const u = new URL(rawPublic);
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) {
        throw new Error('bad url');
      }
      u.hash = '';
      u.search = '';
      publicUrl = u.href.replace(/\/+$/, '');
      publicOrigin = u.origin.toLowerCase();
      publicUrlSecure = u.protocol === 'https:' || isLoopbackHost(u.hostname);
    } catch (e) {
      errors.push('PUBLIC_URL must be an absolute http(s) URL without credentials');
    }
  }

  // Optional explicit relay / API locations advertised to the client through
  // /config.js ('' = same origin, resolved client-side).
  let relayUrl = str(env, 'RELAY_URL');
  if (relayUrl) {
    try {
      const u = new URL(relayUrl);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('bad scheme');
    } catch (e) {
      errors.push('RELAY_URL must be an absolute ws:// or wss:// URL');
      relayUrl = '';
    }
  }
  let apiBase = str(env, 'API_BASE').replace(/\/+$/, '');
  if (apiBase && !parseOrigin(apiBase)) {
    errors.push('API_BASE must be an absolute http(s) URL');
    apiBase = '';
  }

  // TRUST_PROXY: number of trusted reverse-proxy hops in front of this
  // process (1 on Render/Fly/Railway). 0 = never read forwarding headers.
  let trustProxy = 0;
  const rawTrust = str(env, 'TRUST_PROXY');
  if (rawTrust) {
    if (/^(true|yes|on)$/i.test(rawTrust)) trustProxy = 1;
    else if (/^(false|no|off)$/i.test(rawTrust)) trustProxy = 0;
    else trustProxy = int('TRUST_PROXY', 0, 0, 10);
  }
  const clientIpHeader = str(env, 'CLIENT_IP_HEADER').toLowerCase();
  if (clientIpHeader && !/^[a-z0-9-]{1,64}$/.test(clientIpHeader)) {
    errors.push('CLIENT_IP_HEADER must be a plain header name');
  }
  if (clientIpHeader && !trustProxy) {
    warnings.push('CLIENT_IP_HEADER is ignored unless TRUST_PROXY is set');
  }

  const allowedOrigins = new Set();
  for (const part of str(env, 'ALLOWED_ORIGINS').split(',')) {
    const raw = part.trim();
    if (!raw) continue;
    const origin = parseOrigin(raw);
    if (!origin) {
      errors.push('ALLOWED_ORIGINS entries must be origins like https://example.com (got "' + raw.slice(0, 60) + '")');
      continue;
    }
    allowedOrigins.add(origin);
  }

  const frameAncestors = str(env, 'FRAME_ANCESTORS');
  if (frameAncestors && /[;,\r\n]/.test(frameAncestors)) {
    errors.push('FRAME_ANCESTORS must be a space-separated CSP source list');
  }
  const cspOverride = str(env, 'CSP');
  if (/[\r\n]/.test(cspOverride)) errors.push('CSP must be a single line');
  // CSP_EXTRA: extra sources merged into the generated policy, in CSP syntax:
  //   "connect-src wss://eu.example.com; script-src https://plausible.io"
  const cspExtra = [];
  for (const part of str(env, 'CSP_EXTRA').split(';')) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (!/^[a-z][a-z-]*$/.test(words[0]) || words.length < 2 || words.some((w) => /[,"\\]/.test(w))) {
      errors.push('CSP_EXTRA must look like "directive source [source...]; directive source..." (got "' + part.trim().slice(0, 60) + '")');
      continue;
    }
    cspExtra.push(Object.freeze({ directive: words[0], sources: Object.freeze(words.slice(1)) }));
  }

  // ---- relay limits -------------------------------------------------------
  const limits = {
    maxRooms: int('MAX_ROOMS', 500, 1, 100000),
    maxConnections: int('MAX_CONNECTIONS', 2000, 1, 1000000),
    maxConnsPerIp: int('MAX_CONNS_PER_IP', 16, 1, 100000),
    maxMsgBytes: int('MAX_MSG_BYTES', 64 * 1024, 256, 16 * 1024 * 1024),
    rateMsgsPerSec: int('RATE_MSGS_PER_SEC', 100, 1, 100000),
    rateBurst: int('RATE_BURST', 400, 1, 1000000),
    rateBytesPerSec: int('RATE_BYTES_PER_SEC', 128 * 1024, 1024, 1024 * 1024 * 1024),
    rateBytesBurst: int('RATE_BYTES_BURST', 512 * 1024, 1024, 1024 * 1024 * 1024),
    maxBufferedBytes: int('MAX_BUFFERED_BYTES', 1024 * 1024, 16 * 1024, 1024 * 1024 * 1024),
    heartbeatMs: int('HEARTBEAT_MS', 20000, 50, 3600000),
    roomIdleMs: int('ROOM_IDLE_MS', 30 * 60 * 1000, 100, 7 * 24 * 3600 * 1000),
    unjoinedTimeoutMs: int('UNJOINED_TIMEOUT_MS', 30000, 50, 3600000),
    joinFailsPerMin: int('JOIN_FAILS_PER_MIN', 20, 1, 100000),
    maxConnsPerLicense: int('MAX_CONNS_PER_LICENSE', 3, 0, 100000),
  };
  if (limits.rateBytesBurst < limits.maxMsgBytes) {
    errors.push('RATE_BYTES_BURST must be at least MAX_MSG_BYTES, or a single full-size message could never be sent');
  }

  // ---- product + paywall --------------------------------------------------
  const productName = (str(env, 'PRODUCT_NAME') || "Founder's Pass").slice(0, 80);
  const priceLabel = str(env, 'PRICE_LABEL').slice(0, 40);
  const productId = str(env, 'PRODUCT_ID') || 'founders-pass';
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(productId)) {
    errors.push('PRODUCT_ID must be lowercase letters, digits and dashes (max 40 chars)');
  }

  const rawPaywall = (str(env, 'MCA_PAYWALL') || 'off').toLowerCase();
  let paywall = 'off';
  if (PAYWALL_MODES.includes(rawPaywall)) paywall = rawPaywall;
  else errors.push('MCA_PAYWALL must be one of: ' + PAYWALL_MODES.join(', ') + ' (got "' + rawPaywall.slice(0, 40) + '")');

  // ---- licensing ----------------------------------------------------------
  const licenseSecret = typeof env.LICENSE_SECRET === 'string' ? env.LICENSE_SECRET : '';
  const licensing = { enabled: false, reasons: [] };
  const licenseStrength = secretStrength(licenseSecret, 32);
  if (licenseStrength === 'ok') licensing.enabled = true;
  else if (licenseStrength === 'missing') licensing.reasons.push('LICENSE_SECRET is not set');
  else licensing.reasons.push('LICENSE_SECRET rejected: ' + licenseStrength);

  // ---- admin --------------------------------------------------------------
  const adminToken = typeof env.ADMIN_TOKEN === 'string' ? env.ADMIN_TOKEN : '';
  const admin = { enabled: false, reasons: [] };
  const adminStrength = secretStrength(adminToken, 24);
  if (adminStrength === 'missing') admin.reasons.push('ADMIN_TOKEN is not set');
  else if (adminStrength !== 'ok') admin.reasons.push('ADMIN_TOKEN rejected: ' + adminStrength);
  if (!licensing.enabled) admin.reasons.push('license signing is disabled');
  admin.enabled = admin.reasons.length === 0;
  if (adminToken && adminStrength !== 'ok') {
    warnings.push('ADMIN_TOKEN is set but was rejected (' + adminStrength + '); the admin endpoint stays disabled');
  }
  if (licenseSecret && licenseStrength !== 'ok') {
    warnings.push('LICENSE_SECRET is set but was rejected (' + licenseStrength + '); licensing stays disabled');
  }

  // ---- Stripe store -------------------------------------------------------
  const stripeKey = typeof env.STRIPE_SECRET_KEY === 'string' ? env.STRIPE_SECRET_KEY.trim() : '';
  const stripePrice = str(env, 'STRIPE_PRICE_ID');
  const stripeWebhookSecret = typeof env.STRIPE_WEBHOOK_SECRET === 'string' ? env.STRIPE_WEBHOOK_SECRET.trim() : '';
  let stripeApiBase = str(env, 'STRIPE_API_BASE').replace(/\/+$/, '') || 'https://api.stripe.com';
  const store = { enabled: false, reasons: [], livemode: false };

  if (!stripeKey) store.reasons.push('STRIPE_SECRET_KEY is not set');
  else if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(stripeKey)) {
    store.reasons.push('STRIPE_SECRET_KEY does not look like a Stripe secret key (sk_test_… / sk_live_…)');
  }
  if (!stripePrice) store.reasons.push('STRIPE_PRICE_ID is not set');
  else if (!/^price_[A-Za-z0-9]{4,}$/.test(stripePrice)) {
    store.reasons.push('STRIPE_PRICE_ID does not look like a Stripe price id (price_…)');
  }
  if (!stripeWebhookSecret) store.reasons.push('STRIPE_WEBHOOK_SECRET is not set');
  else if (!/^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(stripeWebhookSecret)) {
    store.reasons.push('STRIPE_WEBHOOK_SECRET does not look like a Stripe signing secret (whsec_…)');
  }
  if (!publicUrl) store.reasons.push('PUBLIC_URL is not set (needed for the Checkout return URLs)');
  if (!licensing.enabled) store.reasons.push('license signing is disabled');
  store.livemode = /^(sk|rk)_live_/.test(stripeKey);
  if (store.livemode && publicUrl && !publicUrlSecure) {
    store.reasons.push('PUBLIC_URL must be https:// when a live Stripe key is used');
  }
  try {
    const u = new URL(stripeApiBase);
    const okScheme = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
    if (!okScheme || u.username || u.password) throw new Error('insecure');
  } catch (e) {
    store.reasons.push('STRIPE_API_BASE must be https:// (plain http is accepted for loopback test servers only)');
    stripeApiBase = 'https://api.stripe.com';
  }
  store.enabled = store.reasons.length === 0;
  const anyStripe = !!(stripeKey || stripePrice || stripeWebhookSecret);
  if (anyStripe && !store.enabled) {
    warnings.push('Stripe is partially configured; the store stays disabled: ' + store.reasons.join('; '));
  }

  // ---- paywall sanity (fatal) ----------------------------------------------
  if (paywall !== 'off' && !licensing.enabled) {
    errors.push('MCA_PAYWALL=' + paywall + ' requires working license signing, but '
      + licensing.reasons.join('; ') + '. Set a strong LICENSE_SECRET (32+ random characters) or set MCA_PAYWALL=off.');
  }
  if (paywall !== 'off' && licensing.enabled && !store.enabled && !admin.enabled) {
    warnings.push('MCA_PAYWALL=' + paywall + ' is active but neither the Stripe store nor the admin endpoint is enabled: '
      + 'nobody can obtain a license from this server');
  }
  if (paywall === 'full') {
    warnings.push('MCA_PAYWALL=full gates the client UI only; the static client files are still downloadable. '
      + 'See docs/MONETIZATION.md.');
  }

  const config = {
    version: readVersion(),
    port,
    host,
    webRoot,
    dataDir,
    logLevel,
    publicUrl,
    publicOrigin,
    relayUrl,
    apiBase,
    trustProxy,
    clientIpHeader,
    allowedOrigins,
    frameAncestors,
    cspOverride,
    cspExtra: Object.freeze(cspExtra),
    cspReportOnly: flag(env, 'CSP_REPORT_ONLY'),
    hsts: publicUrl.startsWith('https://') && str(env, 'HSTS') !== '0',
    limits: Object.freeze(limits),
    product: Object.freeze({ id: productId, name: productName, priceLabel }),
    paywall,
    features: Object.freeze({
      licensing: Object.freeze({ enabled: licensing.enabled, reasons: Object.freeze(licensing.reasons) }),
      store: Object.freeze({ enabled: store.enabled, reasons: Object.freeze(store.reasons), livemode: store.livemode }),
      admin: Object.freeze({ enabled: admin.enabled, reasons: Object.freeze(admin.reasons) }),
    }),
    stripe: Object.freeze({
      apiBase: stripeApiBase,
      priceId: stripePrice,
      automaticTax: flag(env, 'STRIPE_AUTOMATIC_TAX'),
      webhookToleranceSec: 300,
    }),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  };
  // secrets: reachable in code, invisible to JSON.stringify / Object.keys / logs
  Object.defineProperty(config, 'secrets', {
    enumerable: false,
    value: Object.freeze({
      license: licensing.enabled ? licenseSecret : '',
      admin: admin.enabled ? adminToken : '',
      stripeKey: store.enabled ? stripeKey : '',
      stripeWebhook: store.enabled ? stripeWebhookSecret : '',
    }),
  });
  return Object.freeze(config);
}

// A boot-log-safe summary (no secrets, by construction).
export function describeConfig(config) {
  return {
    version: config.version,
    port: config.port,
    host: config.host,
    webRoot: config.webRoot,
    dataDir: config.dataDir,
    publicUrl: config.publicUrl || '(unset)',
    trustProxy: config.trustProxy,
    allowedOrigins: [...config.allowedOrigins],
    paywall: config.paywall,
    licensing: config.features.licensing.enabled,
    store: config.features.store.enabled,
    storeMode: config.features.store.enabled ? (config.features.store.livemode ? 'live' : 'test') : 'disabled',
    admin: config.features.admin.enabled,
    limits: config.limits,
  };
}

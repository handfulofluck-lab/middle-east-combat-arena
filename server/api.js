// HTTP API: lobby browser, stats, Stripe Checkout, license claim/verify, admin.
//
// Every payment/licensing route answers 503 with a plain JSON explanation
// while its feature is not configured -- nothing here ever pretends to sell.
// Responses are never cacheable (Cache-Control: no-store).
import {
  clientIp, ipKey, originIsAllowed, originIsOurs, readBody, readJson, safeEqual, sendJson,
} from './http-util.js';
import { KeyedLimiter } from './ratelimit.js';
import { SESSION_ID_RE, StripeError, verifyStripeSignature } from './stripe.js';

const DISABLED = {
  store: { error: 'store-disabled', message: 'Purchases are not available on this server.' },
  licensing: { error: 'licensing-disabled', message: 'License keys are not enabled on this server.' },
  admin: { error: 'admin-disabled', message: 'The admin endpoint is not enabled on this server.' },
};

// routes a separately hosted (ALLOWED_ORIGINS) client may call from a browser
const CORS_PATHS = new Set([
  '/api/rooms', '/api/stats', '/api/checkout', '/api/license/claim', '/api/license/verify', '/api/license/pubkey',
]);

export function createApi({ config, log, relay, licenses, stripe, features }) {
  const limiters = {
    general: new KeyedLimiter({ ratePerSec: 2, burst: 60 }),
    checkout: new KeyedLimiter({ ratePerSec: 0.1, burst: 6 }),
    claim: new KeyedLimiter({ ratePerSec: 0.5, burst: 20 }),
    verify: new KeyedLimiter({ ratePerSec: 0.5, burst: 20 }),
    webhook: new KeyedLimiter({ ratePerSec: 20, burst: 200 }),
    adminFail: new KeyedLimiter({ ratePerSec: 1 / 60, burst: 5 }),
  };
  const sweeper = setInterval(() => {
    const t = Date.now();
    for (const l of Object.values(limiters)) l.sweep(t);
  }, 60000);
  sweeper.unref();

  function limit(res, limiter, key) {
    if (limiter.take(key)) return true;
    sendJson(res, 429, { error: 'rate-limited', message: 'Too many requests. Please slow down.' },
      { 'Retry-After': String(Math.max(1, limiter.retryAfter(key))) });
    return false;
  }

  function allow(req, res, methods) {
    if (methods.includes(req.method) || (req.method === 'HEAD' && methods.includes('GET'))) return true;
    sendJson(res, 405, { error: 'method-not-allowed' }, { Allow: methods.join(', ') });
    return false;
  }

  function licenseView(rec) {
    return { id: rec.lid, product: rec.prd, issuedAt: rec.iat };
  }

  // ---- Stripe fulfilment ---------------------------------------------------

  function paymentIntentId(session) {
    const pi = session.payment_intent;
    if (typeof pi === 'string') return pi;
    if (pi && typeof pi === 'object' && typeof pi.id === 'string') return pi.id;
    return '';
  }

  // Is this Checkout Session a completed purchase of OUR product?
  // -> 'foreign' | 'unpaid' | 'ok'
  function sessionState(session) {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !SESSION_ID_RE.test(session.id)) return 'foreign';
    if (session.mode !== 'payment') return 'foreign';
    if (!session.metadata || session.metadata.mca_product !== config.product.id) return 'foreign';
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return 'unpaid';
    return 'ok';
  }

  function fulfil(session) {
    const email = (session.customer_details && session.customer_details.email) || session.customer_email || '';
    return licenses.issue({
      source: 'stripe',
      sessionId: session.id,
      paymentIntentId: paymentIntentId(session),
      email,
    });
  }

  function handleStripeEvent(event) {
    const obj = event && event.data && event.data.object;
    if (!obj || typeof obj !== 'object') return 'ignored';
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const state = sessionState(obj);
        if (state !== 'ok') return state;
        const r = fulfil(obj);
        return r.created ? 'issued' : (r.blocked ? 'blocked' : 'already-issued');
      }
      case 'charge.refunded': {
        // full refunds only; a partial refund keeps the license
        if (obj.refunded !== true || typeof obj.payment_intent !== 'string' || !obj.payment_intent) return 'ignored';
        const ours = !!(obj.metadata && obj.metadata.mca_product === config.product.id);
        const r = licenses.revokePayment(obj.payment_intent, 'refunded', { tombstone: ours });
        return r.lid ? 'revoked' : (ours ? 'blocked' : 'ignored');
      }
      case 'charge.dispute.created': {
        if (typeof obj.payment_intent !== 'string' || !obj.payment_intent) return 'ignored';
        const r = licenses.revokePayment(obj.payment_intent, 'disputed', { tombstone: false });
        return r.lid ? 'revoked' : 'ignored';
      }
      case 'charge.dispute.closed': {
        if (obj.status !== 'won' || typeof obj.payment_intent !== 'string' || !obj.payment_intent) return 'ignored';
        const r = licenses.reinstatePayment(obj.payment_intent, 'disputed');
        return r.changed ? 'reinstated' : 'ignored';
      }
      default:
        return 'ignored';
    }
  }

  // ---- routes --------------------------------------------------------------

  async function checkout(req, res, key) {
    if (!allow(req, res, ['POST'])) return;
    if (!features.store) return sendJson(res, 503, DISABLED.store);
    if (!limit(res, limiters.checkout, key)) return;
    await readJson(req, 4096); // body is ignored on purpose: nothing client-supplied reaches Stripe
    let session;
    try {
      session = await stripe.createCheckoutSession({
        priceId: config.stripe.priceId,
        successUrl: config.publicUrl + '/?session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: config.publicUrl + '/?checkout=cancelled',
        productId: config.product.id,
        automaticTax: config.stripe.automaticTax,
      });
    } catch (e) {
      log.error('stripe.checkout.failed', { kind: e.kind || 'error', status: e.status || 0, detail: e.message });
      return sendJson(res, 502, { error: 'payment-provider-error', message: 'Checkout could not be started. Please try again in a moment.' });
    }
    let ok = false;
    try { ok = typeof session.url === 'string' && new URL(session.url).protocol === 'https:'; } catch (e) { ok = false; }
    if (!ok) {
      log.error('stripe.checkout.failed', { kind: 'no-url' });
      return sendJson(res, 502, { error: 'payment-provider-error', message: 'Checkout could not be started. Please try again in a moment.' });
    }
    log.info('stripe.checkout.created', { livemode: config.features.store.livemode });
    return sendJson(res, 200, { url: session.url });
  }

  async function webhook(req, res, key) {
    if (!allow(req, res, ['POST'])) return;
    if (!features.store) return sendJson(res, 503, DISABLED.store);
    if (!limit(res, limiters.webhook, key)) return;
    const raw = await readBody(req, 1024 * 1024);
    const sig = verifyStripeSignature({
      payload: raw,
      header: req.headers['stripe-signature'],
      secret: config.secrets.stripeWebhook,
      toleranceSec: config.stripe.webhookToleranceSec,
    });
    if (!sig.ok) {
      log.warn('stripe.webhook.rejected', { reason: sig.reason });
      return sendJson(res, 400, { error: 'invalid-signature' });
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch (e) {
      return sendJson(res, 400, { error: 'invalid-json' });
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      return sendJson(res, 400, { error: 'invalid-event' });
    }
    if (typeof event.livemode === 'boolean' && event.livemode !== config.features.store.livemode) {
      log.warn('stripe.webhook.ignored', { type: event.type, reason: 'livemode-mismatch' });
      return sendJson(res, 200, { received: true, ignored: 'livemode-mismatch' });
    }
    let outcome;
    try {
      outcome = handleStripeEvent(event);
    } catch (e) {
      // e.g. the ledger could not be written: answer 500 so Stripe retries
      log.error('stripe.webhook.failed', { type: event.type, err: e });
      return sendJson(res, 500, { error: 'internal', message: 'Event could not be processed; please retry.' });
    }
    log.info('stripe.webhook', { type: event.type, id: typeof event.id === 'string' ? event.id : '', outcome });
    return sendJson(res, 200, { received: true });
  }

  async function claim(req, res, key, query) {
    if (!allow(req, res, ['GET', 'POST'])) return;
    if (!features.store) return sendJson(res, 503, DISABLED.store);
    if (!limit(res, limiters.claim, key)) return;
    let sessionId = new URLSearchParams(query).get('session_id') || '';
    if (req.method === 'POST') {
      const body = await readJson(req, 4096);
      if (typeof body.session_id === 'string') sessionId = body.session_id;
    }
    if (!SESSION_ID_RE.test(sessionId)) {
      return sendJson(res, 400, { error: 'invalid-session-id', message: 'That is not a valid Checkout session id.' });
    }
    const gone = () => sendJson(res, 410, {
      error: 'license-revoked',
      message: 'This purchase was refunded or disputed, so its license is no longer valid.',
    });

    let rec = licenses.findBySession(sessionId);
    if (!rec) {
      let session;
      try {
        session = await stripe.retrieveCheckoutSession(sessionId);
      } catch (e) {
        if (e instanceof StripeError && e.kind === 'not-found') {
          return sendJson(res, 404, { error: 'unknown-session', message: 'No such purchase was found.' });
        }
        log.error('stripe.claim.failed', { kind: e.kind || 'error', status: e.status || 0, detail: e.message });
        return sendJson(res, 502, { error: 'payment-provider-error', message: 'The purchase could not be verified right now. Please try again in a moment.' });
      }
      if (session && session.id !== sessionId) session = null;
      const state = sessionState(session);
      if (state === 'foreign') return sendJson(res, 404, { error: 'unknown-session', message: 'No such purchase was found.' });
      if (state === 'unpaid') {
        return sendJson(res, 402, { error: 'payment-not-completed', message: 'This payment has not completed yet.' });
      }
      const pi = session.payment_intent;
      const charge = pi && typeof pi === 'object' ? pi.latest_charge : null;
      if (charge && typeof charge === 'object' && (charge.refunded === true || charge.disputed === true)) return gone();
      const r = fulfil(session);
      if (!r.record) return gone();
      rec = r.record;
    }
    if (licenses.isRevoked(rec.lid)) return gone();
    return sendJson(res, 200, { ok: true, token: licenses.tokenFor(rec), license: licenseView(rec) });
  }

  async function verify(req, res, key) {
    if (!allow(req, res, ['POST'])) return;
    if (!features.licensing) return sendJson(res, 503, DISABLED.licensing);
    if (!limit(res, limiters.verify, key)) return;
    const body = await readJson(req, 8192);
    const v = licenses.verify(body.token);
    if (!v.ok) return sendJson(res, 200, { valid: false, reason: v.reason });
    return sendJson(res, 200, {
      valid: true,
      license: { id: v.payload.lid, product: v.payload.prd, issuedAt: v.payload.iat },
    });
  }

  function pubkey(req, res) {
    if (!allow(req, res, ['GET'])) return;
    if (!features.licensing) return sendJson(res, 503, DISABLED.licensing);
    return sendJson(res, 200, {
      algorithm: 'Ed25519',
      tokenFormat: 'MCA1.<base64url payload>.<base64url signature over "MCA1.<payload>">',
      publicKey: licenses.publicKeyRaw,
      publicKeyPem: licenses.publicKeyPem,
      product: config.product.id,
    });
  }

  async function admin(req, res, key, ip) {
    if (!allow(req, res, ['POST'])) return;
    if (!features.admin) return sendJson(res, 503, DISABLED.admin);
    // a browser on another site has no business here
    const origin = req.headers.origin;
    if (origin && !originIsOurs(origin, req, config)) return sendJson(res, 403, { error: 'forbidden' });
    if (!limiters.adminFail.peek(key)) {
      return sendJson(res, 429, { error: 'rate-limited', message: 'Too many failed attempts.' },
        { 'Retry-After': String(Math.max(1, limiters.adminFail.retryAfter(key))) });
    }
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    if (!m || !safeEqual(m[1], config.secrets.admin)) {
      limiters.adminFail.take(key);
      log.warn('admin.denied', { ip });
      req.resume();
      return sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    const body = await readJson(req, 16 * 1024);
    const action = body.action;
    const lidOf = () => {
      if (typeof body.id === 'string' && /^lic_[0-9a-f]{24}$/.test(body.id)) return body.id;
      if (typeof body.token === 'string') {
        const v = licenses.verify(body.token);
        if (v.payload && (v.ok || v.reason === 'revoked')) return v.payload.lid;
      }
      return '';
    };
    switch (action) {
      case 'mint': {
        const count = body.count === undefined ? 1 : body.count;
        if (!Number.isInteger(count) || count < 1 || count > 100) {
          return sendJson(res, 400, { error: 'invalid-count', message: 'count must be an integer from 1 to 100.' });
        }
        const out = [];
        for (let i = 0; i < count; i++) {
          const r = licenses.issue({ source: 'admin', email: body.email, note: body.note });
          out.push({ id: r.record.lid, token: licenses.tokenFor(r.record) });
        }
        log.info('admin.mint', { ip, count });
        return sendJson(res, 200, { ok: true, licenses: out });
      }
      case 'revoke': {
        const lid = lidOf();
        if (!lid) return sendJson(res, 400, { error: 'invalid-license', message: 'Pass a license id or a valid token.' });
        const r = licenses.revoke(lid, typeof body.reason === 'string' ? body.reason : 'admin');
        log.info('admin.revoke', { ip, lid });
        return sendJson(res, 200, { ok: true, id: lid, changed: !!r.changed });
      }
      case 'reinstate': {
        const lid = lidOf();
        if (!lid) return sendJson(res, 400, { error: 'invalid-license', message: 'Pass a license id or a valid token.' });
        const r = licenses.reinstate(lid);
        log.info('admin.reinstate', { ip, lid });
        return sendJson(res, 200, { ok: true, id: lid, changed: !!r.changed });
      }
      case 'lookup': {
        let recs = [];
        if (typeof body.email === 'string') recs = licenses.findByEmail(body.email);
        else {
          const lid = lidOf();
          const rec = lid ? licenses.get(lid) : null;
          if (rec) recs = [rec];
        }
        log.info('admin.lookup', { ip, found: recs.length });
        return sendJson(res, 200, {
          ok: true,
          licenses: recs.map((rec) => ({ ...licenses.describe(rec), token: licenses.tokenFor(rec) })),
        });
      }
      case 'list': {
        const offset = Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
        const max = Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 500 ? body.limit : 100;
        return sendJson(res, 200, { ok: true, ...licenses.stats(), licenses: licenses.list(offset, max) });
      }
      default:
        return sendJson(res, 400, { error: 'unknown-action', message: 'action must be one of: mint, revoke, reinstate, lookup, list.' });
    }
  }

  // Resolves once the request has been answered. HttpError (bad body, too
  // large, ...) propagates to the caller, which renders it.
  async function handle(req, res, pathname, query) {
    const ip = clientIp(req, config);
    const key = ipKey(ip);

    // CORS: same-origin needs nothing; a separately hosted client must be
    // listed in ALLOWED_ORIGINS. No credentials are ever involved.
    const origin = req.headers.origin;
    const corsOk = !!origin && CORS_PATHS.has(pathname) && originIsAllowed(origin, config);
    if (corsOk) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (corsOk) {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
          'Content-Length': 0,
        });
        res.end();
        return;
      }
      return sendJson(res, 403, { error: 'origin-not-allowed' });
    }

    switch (pathname) {
      case '/api/stripe/webhook':
        return webhook(req, res, key);
      case '/api/admin/license':
        return admin(req, res, key, ip);
      default:
    }
    if (!limit(res, limiters.general, key)) return undefined;
    switch (pathname) {
      case '/api/rooms':
        if (!allow(req, res, ['GET'])) return undefined;
        return sendJson(res, 200, { rooms: relay.publicRooms() });
      case '/api/stats': {
        if (!allow(req, res, ['GET'])) return undefined;
        const s = relay.stats();
        return sendJson(res, 200, { online: s.peers, rooms: s.rooms, publicRooms: s.publicRooms, inMatch: s.inMatch, connections: s.connections });
      }
      case '/api/checkout':
        return checkout(req, res, key);
      case '/api/license/claim':
        return claim(req, res, key, query);
      case '/api/license/verify':
        return verify(req, res, key);
      case '/api/license/pubkey':
        return pubkey(req, res);
      default:
        return sendJson(res, 404, { error: 'not-found' });
    }
  }

  return { handle, close: () => clearInterval(sweeper), limiters };
}

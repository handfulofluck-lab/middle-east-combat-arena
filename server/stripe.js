// Minimal Stripe client (REST over fetch, no SDK) + webhook signature check.
//
// Card data never reaches this server: buyers pay on Stripe's hosted Checkout
// page. We only create Checkout Sessions, read them back, and receive signed
// webhook events.
import crypto from 'node:crypto';

export class StripeError extends Error {
  constructor(kind, status, message) {
    super(message);
    this.kind = kind;     // 'not-found' | 'auth' | 'rate-limited' | 'invalid' | 'unreachable' | 'stripe'
    this.status = status; // HTTP status from Stripe (0 when unreachable)
  }
}

export const SESSION_ID_RE = /^cs_[A-Za-z0-9_]{8,250}$/;

export function createStripeClient({ secretKey, apiBase, timeoutMs = 10000, fetchImpl = globalThis.fetch }) {
  async function request(method, pathAndQuery, form) {
    const headers = {
      Authorization: 'Bearer ' + secretKey,
      Accept: 'application/json',
      'User-Agent': 'mca-server',
    };
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Idempotency-Key'] = crypto.randomUUID();
      body = new URLSearchParams(form).toString();
    }
    let res;
    try {
      res = await fetchImpl(apiBase + pathAndQuery, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new StripeError('unreachable', 0, 'Stripe could not be reached');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON body */ }
    if (res.ok && json && typeof json === 'object') return json;
    // Stripe's error text describes the request, never the key; keep it short.
    const detail = json && json.error && typeof json.error.message === 'string'
      ? json.error.message.slice(0, 200) : 'HTTP ' + res.status;
    const kind = res.status === 404 ? 'not-found'
      : res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? 'rate-limited'
          : res.status >= 400 && res.status < 500 ? 'invalid' : 'stripe';
    throw new StripeError(kind, res.status, detail);
  }

  return {
    // One-time payment for one unit of the configured price. The return URLs
    // are fixed by the server (never taken from the client): no open redirect.
    createCheckoutSession({ priceId, successUrl, cancelUrl, productId, automaticTax }) {
      const form = [
        ['mode', 'payment'],
        ['line_items[0][price]', priceId],
        ['line_items[0][quantity]', '1'],
        ['success_url', successUrl],
        ['cancel_url', cancelUrl],
        ['metadata[mca_product]', productId],
        ['payment_intent_data[metadata][mca_product]', productId],
      ];
      if (automaticTax) form.push(['automatic_tax[enabled]', 'true']);
      return request('POST', '/v1/checkout/sessions', form);
    },

    // Expanded so refund / dispute state of the payment is visible at claim time.
    retrieveCheckoutSession(id) {
      if (!SESSION_ID_RE.test(String(id))) return Promise.reject(new StripeError('invalid', 400, 'bad session id'));
      return request('GET', '/v1/checkout/sessions/' + encodeURIComponent(id)
        + '?expand%5B%5D=payment_intent.latest_charge');
    },
  };
}

// Stripe-Signature verification, exactly per
// https://docs.stripe.com/webhooks#verify-manually :
//   header:  t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...][,v0=...]
//   signed payload = "<t>.<raw request body>"   (the RAW bytes, never re-serialized JSON)
//   expected = HMAC-SHA256(key = the whsec_... secret string, signed payload), hex
//   accept when ANY v1 matches (constant-time) and |now - t| <= tolerance
// -> { ok:true, timestamp } | { ok:false, reason }
export function verifyStripeSignature({ payload, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) }) {
  if (typeof secret !== 'string' || !secret) return { ok: false, reason: 'no-secret' };
  if (typeof header !== 'string' || !header || header.length > 2048) return { ok: false, reason: 'no-signature-header' };
  if (!Buffer.isBuffer(payload)) return { ok: false, reason: 'payload-not-raw' };

  let timestamp = null;
  const candidates = [];
  for (const item of header.split(',')) {
    const eq = item.indexOf('=');
    if (eq < 0) continue;
    const k = item.slice(0, eq).trim();
    const v = item.slice(eq + 1).trim();
    if (k === 't' && timestamp === null) timestamp = v;
    else if (k === 'v1') candidates.push(v);
  }
  if (timestamp === null || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  if (candidates.length === 0) return { ok: false, reason: 'no-v1-signature' };

  const expected = crypto.createHmac('sha256', secret)
    .update(timestamp + '.', 'utf8')
    .update(payload)
    .digest();

  let match = false;
  for (const candidate of candidates.slice(0, 8)) {
    if (!/^[0-9a-fA-F]{64}$/.test(candidate)) continue;
    // no early exit: every candidate is compared in constant time
    if (crypto.timingSafeEqual(expected, Buffer.from(candidate, 'hex'))) match = true;
  }
  if (!match) return { ok: false, reason: 'signature-mismatch' };

  const t = Number(timestamp);
  if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: 'timestamp-outside-tolerance' };
  return { ok: true, timestamp: t };
}

// Produce a Stripe-Signature header (used by the tests and handy for local
// webhook replay). Not used on any request path.
export function signStripePayload(payload, secret, timestampSec = Math.floor(Date.now() / 1000)) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const sig = crypto.createHmac('sha256', secret).update(timestampSec + '.', 'utf8').update(buf).digest('hex');
  return 't=' + timestampSec + ',v1=' + sig;
}

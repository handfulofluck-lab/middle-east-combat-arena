// A local stand-in for api.stripe.com, just big enough for the calls the
// server makes (create + retrieve Checkout Session). The server is pointed at
// it with STRIPE_API_BASE. It checks what a real Stripe would check about OUR
// requests (auth header, form encoding, required params) and lets a test move
// a session through pay / refund / dispute, handing back the webhook event
// objects Stripe would send.
import crypto from 'node:crypto';
import http from 'node:http';
import { listenInRange } from './harness.mjs';

function stripeError(res, status, type, message, code) {
  const body = JSON.stringify({ error: { type, message, code } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export async function startStripeMock({ secretKey, priceId, livemode = false }) {
  const sessions = new Map();
  const requests = []; // { method, path, auth, form, headers }
  let failNext = null; // { status } -> next API call fails that way
  let seq = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://stripe.mock');
      const form = Object.fromEntries(new URLSearchParams(bodyText));
      requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, form, headers: req.headers });

      if (failNext) {
        const f = failNext;
        failNext = null;
        if (f.hang) return; // never answer (timeout path)
        return stripeError(res, f.status, 'api_error', 'mock failure');
      }
      if (req.headers.authorization !== 'Bearer ' + secretKey) {
        return stripeError(res, 401, 'invalid_request_error', 'Invalid API Key provided: sk_test_****');
      }

      if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
          return stripeError(res, 400, 'invalid_request_error', 'expected form encoding');
        }
        if (form.mode !== 'payment') return stripeError(res, 400, 'invalid_request_error', 'mode must be payment');
        if (form['line_items[0][price]'] !== priceId) return stripeError(res, 400, 'invalid_request_error', 'No such price', 'resource_missing');
        if (form['line_items[0][quantity]'] !== '1') return stripeError(res, 400, 'invalid_request_error', 'bad quantity');
        if (!/^https?:\/\//.test(form.success_url || '') || !/^https?:\/\//.test(form.cancel_url || '')) {
          return stripeError(res, 400, 'invalid_request_error', 'Not a valid URL');
        }
        const id = 'cs_' + (livemode ? 'live' : 'test') + '_' + crypto.randomBytes(24).toString('hex');
        const metadata = {};
        for (const [k, v] of Object.entries(form)) {
          const m = /^metadata\[(.+)\]$/.exec(k);
          if (m) metadata[m[1]] = v;
        }
        const session = {
          id,
          object: 'checkout.session',
          livemode,
          mode: 'payment',
          status: 'open',
          payment_status: 'unpaid',
          payment_intent: null,
          customer_details: null,
          metadata,
          success_url: form.success_url,
          cancel_url: form.cancel_url,
          url: 'https://checkout.stripe.com/c/pay/' + id,
        };
        sessions.set(id, session);
        const body = JSON.stringify(session);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        return res.end(body);
      }

      const m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const session = sessions.get(decodeURIComponent(m[1]));
        if (!session) return stripeError(res, 404, 'invalid_request_error', 'No such checkout.session', 'resource_missing');
        const out = { ...session };
        const expand = url.searchParams.getAll('expand[]');
        if (session._pi) {
          out.payment_intent = expand.includes('payment_intent.latest_charge')
            ? { id: session._pi.id, object: 'payment_intent', latest_charge: { ...session._pi.charge } }
            : session._pi.id;
        }
        delete out._pi;
        const body = JSON.stringify(out);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        return res.end(body);
      }
      return stripeError(res, 404, 'invalid_request_error', 'Unrecognized request URL');
    });
  });

  const port = await listenInRange((p) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  }));

  const event = (type, object) => ({
    id: 'evt_' + (++seq) + crypto.randomBytes(8).toString('hex'),
    object: 'event',
    type,
    livemode,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });

  function publicSession(session) {
    const out = { ...session };
    if (session._pi) out.payment_intent = session._pi.id;
    delete out._pi;
    return out;
  }

  return {
    port,
    base: 'http://127.0.0.1:' + port,
    requests,
    sessions,
    lastSessionId: () => [...sessions.keys()].pop(),
    failNext: (f) => { failNext = f; },

    // the buyer pays on the hosted page -> checkout.session.completed
    pay(sessionId, { email = 'buyer@example.com', paymentStatus = 'paid' } = {}) {
      const session = sessions.get(sessionId);
      session.status = 'complete';
      session.payment_status = paymentStatus;
      session.customer_details = { email };
      session._pi = {
        id: 'pi_' + crypto.randomBytes(12).toString('hex'),
        charge: { id: 'ch_' + crypto.randomBytes(12).toString('hex'), object: 'charge', refunded: false, disputed: false },
      };
      return event('checkout.session.completed', publicSession(session));
    },

    // delayed payment methods settle later -> checkout.session.async_payment_succeeded
    settle(sessionId) {
      const session = sessions.get(sessionId);
      session.payment_status = 'paid';
      return event('checkout.session.async_payment_succeeded', publicSession(session));
    },

    refund(sessionId, { full = true } = {}) {
      const session = sessions.get(sessionId);
      session._pi.charge.refunded = full;
      return event('charge.refunded', {
        ...session._pi.charge,
        payment_intent: session._pi.id,
        amount: 999,
        amount_refunded: full ? 999 : 300,
        metadata: { ...session.metadata },
      });
    },

    dispute(sessionId) {
      const session = sessions.get(sessionId);
      session._pi.charge.disputed = true;
      return event('charge.dispute.created', {
        id: 'dp_' + crypto.randomBytes(8).toString('hex'), object: 'dispute', status: 'needs_response',
        charge: session._pi.charge.id, payment_intent: session._pi.id, metadata: {},
      });
    },

    disputeClosed(sessionId, status) {
      const session = sessions.get(sessionId);
      if (status === 'won') session._pi.charge.disputed = false;
      return event('charge.dispute.closed', {
        id: 'dp_' + crypto.randomBytes(8).toString('hex'), object: 'dispute', status,
        charge: session._pi.charge.id, payment_intent: session._pi.id, metadata: {},
      });
    },

    event,
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

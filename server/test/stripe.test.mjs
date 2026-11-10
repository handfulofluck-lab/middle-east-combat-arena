// Stripe webhook signature verification (self-generated signatures plus a
// vector computed with an independent HMAC implementation) and the REST
// client against the local Stripe mock.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { describe, test } from 'node:test';
import { createStripeClient, signStripePayload, StripeError, verifyStripeSignature } from '../stripe.js';
import { listenInRange, TEST_SECRETS } from './helpers/harness.mjs';
import { startStripeMock } from './helpers/stripe-mock.mjs';

const SECRET = TEST_SECRETS.STRIPE_WEBHOOK_SECRET;
const NOW = 1_800_000_000;
const BODY = Buffer.from('{"id":"evt_1","type":"checkout.session.completed","data":{"object":{"id":"cs_test_1"}}}');

const hmacHex = (secret, t, body) => crypto.createHmac('sha256', secret).update(t + '.' + body.toString('utf8')).digest('hex');
const check = (header, extra = {}) => verifyStripeSignature({ payload: BODY, header, secret: SECRET, nowSec: NOW, ...extra });

describe('Stripe-Signature verification', () => {
  test('known-answer vector (HMAC computed independently with Python hmac/hashlib)', () => {
    const secret = 'whsec_kat_0123456789abcdefABCDEF';
    const payload = Buffer.from('{\n  "id": "evt_kat_1",\n  "object": "event",\n  "type": "checkout.session.completed"\n}');
    const header = 't=1700000000,v1=f9f4c97bc33a6b3711de96e6666616f1aee00185323fc2a2776c2b57c907e2f0';
    assert.deepEqual(verifyStripeSignature({ payload, header, secret, nowSec: 1700000100 }), { ok: true, timestamp: 1700000000 });
    assert.equal(signStripePayload(payload, secret, 1700000000), header);
  });

  test('accepts a correct signature over "<t>.<raw body>"', () => {
    assert.deepEqual(check(`t=${NOW},v1=${hmacHex(SECRET, NOW, BODY)}`), { ok: true, timestamp: NOW });
    assert.equal(check(signStripePayload(BODY, SECRET, NOW)).ok, true);
    // header order and extra schemes do not matter; any matching v1 is enough (secret rolling)
    const good = hmacHex(SECRET, NOW, BODY);
    assert.equal(check(`v0=deadbeef,v1=${'0'.repeat(64)},v1=${good},t=${NOW}`).ok, true);
    assert.equal(check(` t = ${NOW} , v1 = ${good} `).ok, true);
    assert.equal(check(`t=${NOW},v1=${good.toUpperCase()}`).ok, true);
  });

  test('rejects a wrong secret, a changed body, a changed timestamp', () => {
    assert.deepEqual(check(`t=${NOW},v1=${hmacHex('whsec_some_other_secret_value', NOW, BODY)}`), { ok: false, reason: 'signature-mismatch' });
    const sig = hmacHex(SECRET, NOW, BODY);
    const tampered = Buffer.from(BODY);
    tampered[20] ^= 1;
    assert.equal(verifyStripeSignature({ payload: tampered, header: `t=${NOW},v1=${sig}`, secret: SECRET, nowSec: NOW }).reason, 'signature-mismatch');
    // replaying an old signature under a fresh timestamp does not work: t is signed
    assert.equal(check(`t=${NOW + 1},v1=${sig}`).reason, 'signature-mismatch');
    // the scheme is exactly t + "." + body -- near misses fail
    const noDot = crypto.createHmac('sha256', SECRET).update(String(NOW) + BODY.toString()).digest('hex');
    const bodyOnly = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    assert.equal(check(`t=${NOW},v1=${noDot}`).ok, false);
    assert.equal(check(`t=${NOW},v1=${bodyOnly}`).ok, false);
    // only v1 counts
    assert.equal(check(`t=${NOW},v0=${sig}`).reason, 'no-v1-signature');
  });

  test('the RAW bytes are what is signed: re-serialized JSON does not verify', () => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 2));
    assert.notDeepEqual(pretty, BODY);
    const header = signStripePayload(BODY, SECRET, NOW);
    assert.equal(verifyStripeSignature({ payload: pretty, header, secret: SECRET, nowSec: NOW }).reason, 'signature-mismatch');
    // and a parsed/string body is refused outright rather than silently coerced
    assert.equal(verifyStripeSignature({ payload: BODY.toString(), header, secret: SECRET, nowSec: NOW }).reason, 'payload-not-raw');
    assert.equal(verifyStripeSignature({ payload: JSON.parse(BODY.toString()), header, secret: SECRET, nowSec: NOW }).reason, 'payload-not-raw');
  });

  test('timestamp tolerance: stale and far-future events are rejected even with a valid signature', () => {
    const at = (t) => check(signStripePayload(BODY, SECRET, t));
    assert.equal(at(NOW - 300).ok, true);
    assert.equal(at(NOW - 301).reason, 'timestamp-outside-tolerance');
    assert.equal(at(NOW - 86400).reason, 'timestamp-outside-tolerance');
    assert.equal(at(NOW + 300).ok, true);
    assert.equal(at(NOW + 301).reason, 'timestamp-outside-tolerance');
    assert.equal(check(signStripePayload(BODY, SECRET, NOW - 500), { toleranceSec: 600 }).ok, true);
    assert.equal(at(0).reason, 'timestamp-outside-tolerance');
  });

  test('malformed headers never verify and never throw', () => {
    const good = hmacHex(SECRET, NOW, BODY);
    const bad = [
      undefined, null, '', 42, {}, 'garbage', 't=', 'v1=' + good, `t=${NOW}`, `t=abc,v1=${good}`, `t=-5,v1=${good}`,
      `t=${NOW},v1=`, `t=${NOW},v1=xyz`, `t=${NOW},v1=${good.slice(0, 63)}`, `t=${NOW},v1=${good}00`,
      `t=${NOW}.5,v1=${good}`, `t=${NOW}${'9'.repeat(20)},v1=${good}`, `t=${NOW},v1=${'g'.repeat(64)}`,
      'x'.repeat(5000), ['t=' + NOW, 'v1=' + good],
    ];
    for (const header of bad) {
      const r = check(header);
      assert.equal(r.ok, false, String(header).slice(0, 40));
      assert.equal(typeof r.reason, 'string');
    }
    assert.equal(verifyStripeSignature({ payload: BODY, header: `t=${NOW},v1=${good}`, secret: '', nowSec: NOW }).reason, 'no-secret');
    assert.equal(verifyStripeSignature({ payload: BODY, header: `t=${NOW},v1=${good}`, secret: undefined, nowSec: NOW }).reason, 'no-secret');
  });

  test('comparison is constant-time (crypto.timingSafeEqual on the digest)', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../stripe.js', import.meta.url), 'utf8'));
    assert.match(src, /timingSafeEqual\(expected, Buffer\.from\(candidate, 'hex'\)\)/);
    assert.ok(!/===\s*candidate|candidate\s*===/.test(src), 'no plain string comparison of signatures');
  });
});

describe('Stripe REST client (against the mock)', () => {
  const KEY = TEST_SECRETS.STRIPE_SECRET_KEY;
  const PRICE = TEST_SECRETS.STRIPE_PRICE_ID;

  test('create + retrieve a Checkout Session with the documented wire format', async (t) => {
    const mock = await startStripeMock({ secretKey: KEY, priceId: PRICE });
    t.after(() => mock.close());
    const stripe = createStripeClient({ secretKey: KEY, apiBase: mock.base });
    const session = await stripe.createCheckoutSession({
      priceId: PRICE,
      successUrl: 'https://play.example.com/?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://play.example.com/?checkout=cancelled',
      productId: 'founders-pass',
      automaticTax: true,
    });
    assert.match(session.id, /^cs_test_/);
    assert.match(session.url, /^https:\/\/checkout\.stripe\.com\//);

    const req = mock.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/checkout/sessions');
    assert.equal(req.auth, 'Bearer ' + KEY);
    assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.match(req.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
    assert.deepEqual(req.form, {
      mode: 'payment',
      'line_items[0][price]': PRICE,
      'line_items[0][quantity]': '1',
      success_url: 'https://play.example.com/?session_id={CHECKOUT_SESSION_ID}', // literal template, Stripe fills it in
      cancel_url: 'https://play.example.com/?checkout=cancelled',
      'metadata[mca_product]': 'founders-pass',
      'payment_intent_data[metadata][mca_product]': 'founders-pass',
      'automatic_tax[enabled]': 'true',
    });

    mock.pay(session.id);
    const back = await stripe.retrieveCheckoutSession(session.id);
    assert.equal(back.payment_status, 'paid');
    assert.equal(typeof back.payment_intent, 'object', 'payment_intent.latest_charge is expanded');
    assert.equal(back.payment_intent.latest_charge.refunded, false);
    assert.equal(mock.requests[1].query, '?expand%5B%5D=payment_intent.latest_charge');
  });

  test('errors are classified; nothing about the key leaks into them', async (t) => {
    const mock = await startStripeMock({ secretKey: KEY, priceId: PRICE });
    t.after(() => mock.close());
    const stripe = createStripeClient({ secretKey: KEY, apiBase: mock.base, timeoutMs: 200 });
    const kindOf = (p) => p.then(() => 'resolved', (e) => { assert.ok(e instanceof StripeError); assert.ok(!e.message.includes(KEY)); return e.kind; });

    assert.equal(await kindOf(stripe.retrieveCheckoutSession('cs_test_doesnotexist0000')), 'not-found');
    mock.failNext({ status: 500 });
    assert.equal(await kindOf(stripe.retrieveCheckoutSession('cs_test_doesnotexist0000')), 'stripe');
    mock.failNext({ status: 429 });
    assert.equal(await kindOf(stripe.retrieveCheckoutSession('cs_test_doesnotexist0000')), 'rate-limited');
    mock.failNext({ hang: true });
    assert.equal(await kindOf(stripe.retrieveCheckoutSession('cs_test_doesnotexist0000')), 'unreachable', 'a hung request times out');

    const wrongKey = createStripeClient({ secretKey: 'sk_test_wrongwrongwrong', apiBase: mock.base });
    assert.equal(await kindOf(wrongKey.retrieveCheckoutSession('cs_test_doesnotexist0000')), 'auth');
    assert.equal(await kindOf(stripe.createCheckoutSession({ priceId: 'price_nope', successUrl: 'https://a/', cancelUrl: 'https://a/', productId: 'p' })), 'invalid');

    // malformed ids never reach the network
    const before = mock.requests.length;
    for (const id of ['', 'cs_', '../v1/charges', 'cs_test_ab/../../x', 'cs_test_abc?expand=x', 'pi_12345678', 'cs_test_' + 'a'.repeat(300)]) {
      assert.equal(await kindOf(stripe.retrieveCheckoutSession(id)), 'invalid', id);
    }
    assert.equal(mock.requests.length, before);

    const dead = createStripeClient({ secretKey: KEY, apiBase: 'http://127.0.0.1:9', timeoutMs: 500 });
    assert.equal(await kindOf(dead.retrieveCheckoutSession('cs_test_doesnotexist0000')), 'unreachable');
  });

  test('the secret key is never sent along a redirect', async (t) => {
    const seen = [];
    const elsewhere = http.createServer((req, res) => { seen.push(req.headers.authorization); res.end('{}'); });
    const redirector = http.createServer((req, res) => {
      res.writeHead(307, { Location: 'http://127.0.0.1:' + elsewhere.address().port + '/steal' });
      res.end();
    });
    const listen = (s) => listenInRange((p) => new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(p, '127.0.0.1', () => { s.removeListener('error', reject); resolve(); });
    }));
    await listen(elsewhere);
    const port = await listen(redirector);
    t.after(() => { elsewhere.close(); redirector.close(); });
    const stripe = createStripeClient({ secretKey: KEY, apiBase: 'http://127.0.0.1:' + port, timeoutMs: 1000 });
    await assert.rejects(stripe.retrieveCheckoutSession('cs_test_redirect00000'), (e) => e.kind === 'unreachable');
    assert.deepEqual(seen, []);
  });
});

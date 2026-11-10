// Payments + entitlements, end to end against a local Stripe mock:
//   checkout -> (webhook | claim) -> verify -> relay join, refunds, disputes,
// plus the dormant/disabled states, the admin endpoint and CORS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ConfigError } from '../app.js';
import { signStripePayload } from '../stripe.js';
import {
  Client, http, makeTempDir, rawRequest, sleep, startServer, TEST_SECRETS,
} from './helpers/harness.mjs';
import { startStripeMock } from './helpers/stripe-mock.mjs';

const JSON_HEADERS = { 'content-type': 'application/json' };
const post = (url, body, headers = {}) => http(url, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
const admin = (srv, body, token = TEST_SECRETS.ADMIN_TOKEN) => post(srv.origin + '/api/admin/license', body, { authorization: 'Bearer ' + token });

function sendWebhook(srv, event, { secret = TEST_SECRETS.STRIPE_WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000), header } = {}) {
  const raw = Buffer.from(JSON.stringify(event));
  return rawRequest(srv.origin + '/api/stripe/webhook', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'content-length': raw.length, 'stripe-signature': header || signStripePayload(raw, secret, at) },
    body: raw,
  });
}

// server + Stripe mock, fully configured
async function storeSetup(t, env = {}) {
  const mock = await startStripeMock({ secretKey: TEST_SECRETS.STRIPE_SECRET_KEY, priceId: TEST_SECRETS.STRIPE_PRICE_ID });
  const srv = await startServer({
    ...TEST_SECRETS,
    STRIPE_API_BASE: mock.base,
    PUBLIC_URL: 'https://play.example.com/',
    PRODUCT_NAME: 'Founder’s Pass',
    PRICE_LABEL: '$9.99',
    ...env,
  });
  t.after(async () => { await srv.close(); await mock.close(); });
  const checkout = async () => {
    const res = await post(srv.origin + '/api/checkout', {});
    assert.equal(res.status, 200, res.text);
    return { url: res.json.url, sessionId: mock.lastSessionId() };
  };
  const claim = (sessionId) => http(srv.origin + '/api/license/claim?session_id=' + encodeURIComponent(sessionId));
  const verify = (token) => post(srv.origin + '/api/license/verify', { token }).then((r) => r.json);
  return { srv, mock, checkout, claim, verify };
}

async function relayTry(srv, msg) {
  const c = await Client.open(srv.wsUrl);
  c.send(msg);
  const reply = await c.next((m) => m.t === 'room' || m.t === 'error');
  return { c, reply };
}

describe('dormant until configured', () => {
  test('no payment env: every payment route says so (503), the game itself is unaffected', async (t) => {
    const srv = await startServer();
    t.after(() => srv.close());
    const cfg = (await http(srv.origin + '/config.js')).text;
    assert.match(cfg, /"storeEnabled": false/);
    assert.match(cfg, /"redeemEnabled": false/);
    assert.match(cfg, /"paywall": "off"/);

    const checkout = await post(srv.origin + '/api/checkout', {});
    assert.equal(checkout.status, 503);
    assert.deepEqual(checkout.json, { error: 'store-disabled', message: 'Purchases are not available on this server.' });
    assert.equal(checkout.headers.get('cache-control'), 'no-store');
    assert.equal((await post(srv.origin + '/api/stripe/webhook', { type: 'checkout.session.completed' })).json.error, 'store-disabled');
    const claim = await http(srv.origin + '/api/license/claim?session_id=cs_test_abcdefgh12345678');
    assert.equal(claim.status, 503);
    assert.equal(claim.json.error, 'store-disabled');
    const verify = await post(srv.origin + '/api/license/verify', { token: 'MCA1.x.y' });
    assert.equal(verify.status, 503);
    assert.equal(verify.json.error, 'licensing-disabled');
    assert.equal((await http(srv.origin + '/api/license/pubkey')).status, 503);
    const adm = await post(srv.origin + '/api/admin/license', { action: 'mint' }, { authorization: 'Bearer anything-at-all-000000000000' });
    assert.equal(adm.status, 503);
    assert.equal(adm.json.error, 'admin-disabled');
    assert.equal((await http(srv.origin + '/healthz')).json.storeEnabled, false);
    assert.equal(fs.existsSync(srv.dataDir), false, 'nothing is written while licensing is off');

    const { c, reply } = await relayTry(srv, { t: 'create', name: 'free player' });
    assert.equal(reply.t, 'room', 'paywall off: multiplayer needs no license');
    c.terminate();
  });

  test('license signing without Stripe: keys can be minted and redeemed, nothing can be bought', async (t) => {
    const srv = await startServer({ LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN });
    t.after(() => srv.close());
    assert.deepEqual(srv.app.features, { licensing: true, store: false, admin: true });
    const cfg = (await http(srv.origin + '/config.js')).text;
    assert.match(cfg, /"storeEnabled": false/);
    assert.match(cfg, /"redeemEnabled": true/);
    assert.equal((await post(srv.origin + '/api/checkout', {})).status, 503);
    assert.equal((await http(srv.origin + '/api/license/claim?session_id=cs_test_abcdefgh12345678')).status, 503);
    const minted = await admin(srv, { action: 'mint' });
    assert.equal(minted.status, 200);
    const v = await post(srv.origin + '/api/license/verify', { token: minted.json.licenses[0].token });
    assert.deepEqual(v.json, { valid: true, license: { id: minted.json.licenses[0].id, product: 'founders-pass', issuedAt: v.json.license.issuedAt } });
    const pub = await http(srv.origin + '/api/license/pubkey');
    assert.equal(pub.json.algorithm, 'Ed25519');
    assert.match(pub.json.publicKeyPem, /BEGIN PUBLIC KEY/);
  });

  test('weak or partial secrets leave features OFF rather than half-working', async (t) => {
    const weak = await startServer({ LICENSE_SECRET: 'hunter2', ADMIN_TOKEN: 'admin' });
    t.after(() => weak.close());
    assert.deepEqual(weak.app.features, { licensing: false, store: false, admin: false });
    assert.equal((await post(weak.origin + '/api/license/verify', { token: 'x' })).status, 503);
    assert.equal((await post(weak.origin + '/api/admin/license', { action: 'mint' }, { authorization: 'Bearer admin' })).status, 503);

    // Stripe keys present but no signing secret / webhook secret: still no store
    const partial = await startServer({
      STRIPE_SECRET_KEY: TEST_SECRETS.STRIPE_SECRET_KEY, STRIPE_PRICE_ID: TEST_SECRETS.STRIPE_PRICE_ID,
      PUBLIC_URL: 'https://play.example.com', LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET,
    });
    t.after(() => partial.close());
    assert.equal(partial.app.features.store, false);
    assert.equal((await post(partial.origin + '/api/checkout', {})).status, 503);
    assert.ok(partial.config.warnings.some((w) => /partially configured/.test(w) && /STRIPE_WEBHOOK_SECRET/.test(w)));
  });

  test('a paywall that cannot be satisfied refuses to start; an unusable DATA_DIR disables licensing', async (t) => {
    await assert.rejects(startServer({ MCA_PAYWALL: 'multiplayer' }), (e) => e instanceof ConfigError && /LICENSE_SECRET/.test(e.message));
    await assert.rejects(startServer({ MCA_PAYWALL: 'full', LICENSE_SECRET: 'too-short' }), ConfigError);
    await assert.rejects(startServer({ MCA_PAYWALL: 'multiplyer', LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET }), /MCA_PAYWALL must be one of/);

    const dir = makeTempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'data'), 'a file where the data directory should be');
    const srv = await startServer({ LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN }, { dir });
    t.after(() => srv.close());
    assert.deepEqual(srv.app.features, { licensing: false, store: false, admin: false });
    assert.equal((await post(srv.origin + '/api/license/verify', { token: 'x' })).status, 503);
    assert.ok(srv.logs.some((l) => l.evt === 'license.disabled'));
    assert.match(srv.app.featureReasons.licensing.join(' '), /DATA_DIR .* is not writable/);
    assert.ok(srv.app.featureReasons.store.includes('license signing is disabled'));
    await assert.rejects(startServer({ LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, MCA_PAYWALL: 'multiplayer' }, { dir }), /writable DATA_DIR/);
  });
});

describe('checkout -> webhook -> claim -> verify -> relay (multiplayer paywall)', () => {
  test('the whole purchase flow, then a refund', async (t) => {
    const { srv, mock, checkout, claim, verify } = await storeSetup(t, { MCA_PAYWALL: 'multiplayer' });

    // 1. the client is told the truth about this server
    const cfg = (await http(srv.origin + '/config.js')).text;
    assert.match(cfg, /"storeEnabled": true/);
    assert.match(cfg, /"paywall": "multiplayer"/);
    assert.match(cfg, /"priceLabel": "\$9\.99"/);
    assert.equal((await http(srv.origin + '/healthz')).json.paywall, 'multiplayer');

    // 2. without a license the relay refuses to host or join -- with a reason a client can show
    const noLic = await relayTry(srv, { t: 'create', name: 'freeloader' });
    assert.equal(noLic.reply.t, 'error');
    assert.equal(noLic.reply.reason, 'license-required');
    assert.equal(noLic.reply.message, 'Online play on this server requires the Founder’s Pass.');
    noLic.c.send({ t: 'join', code: 'ABCD', name: 'freeloader' });
    assert.equal((await noLic.c.next('error')).reason, 'license-required', 'room codes cannot be probed without a license');
    noLic.c.send({ t: 'create', name: 'x', license: 'MCA1.bm90LWEtcmVhbC10b2tlbg.AAAA' });
    assert.equal((await noLic.c.next('error')).reason, 'license-invalid');
    assert.ok(noLic.c.open, 'the connection survives so the player can buy and retry');

    // 3. start a Checkout: only server-side values reach Stripe
    const res = await post(srv.origin + '/api/checkout', { success_url: 'https://evil.example/steal', price: 'price_free', quantity: 0 });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json), ['url']);
    assert.match(res.json.url, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    const sessionId = mock.lastSessionId();
    const sent = mock.requests.at(-1);
    assert.equal(sent.form.success_url, 'https://play.example.com/?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(sent.form.cancel_url, 'https://play.example.com/?checkout=cancelled');
    assert.equal(sent.form['line_items[0][price]'], TEST_SECRETS.STRIPE_PRICE_ID);
    assert.equal(sent.form['line_items[0][quantity]'], '1');
    assert.equal(sent.form['metadata[mca_product]'], 'founders-pass');

    // 4. nothing can be claimed before the buyer has paid
    const early = await claim(sessionId);
    assert.equal(early.status, 402);
    assert.equal(early.json.error, 'payment-not-completed');
    assert.equal(srv.app.licenses.stats().licenses, 0);

    // 5. the buyer pays; forged / stale webhooks are rejected, the real one issues a license
    const paid = mock.pay(sessionId, { email: 'buyer@example.com' });
    const forged = await sendWebhook(srv, paid, { secret: 'whsec_not_the_real_signing_secret' });
    assert.equal(forged.status, 400);
    assert.deepEqual(JSON.parse(forged.body), { error: 'invalid-signature' });
    assert.equal((await sendWebhook(srv, paid, { at: Math.floor(Date.now() / 1000) - 3600 })).status, 400, 'replayed old event');
    assert.equal((await sendWebhook(srv, paid, { header: 'nonsense' })).status, 400);
    assert.equal((await rawRequest(srv.origin + '/api/stripe/webhook', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(paid) })).status, 400, 'unsigned');
    assert.equal(srv.app.licenses.stats().licenses, 0);

    const ok = await sendWebhook(srv, paid);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { received: true });
    assert.equal(srv.app.licenses.stats().licenses, 1);
    assert.equal((await sendWebhook(srv, paid)).status, 200, 'Stripe retries are harmless');
    assert.equal(srv.app.licenses.stats().licenses, 1);

    // 6. the returning browser claims its license -- idempotently
    const stripeCalls = mock.requests.length;
    const first = await claim(sessionId);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.match(first.json.token, /^MCA1\./);
    assert.deepEqual(Object.keys(first.json).sort(), ['license', 'ok', 'token']);
    const second = await claim(sessionId);
    assert.equal(second.json.token, first.json.token);
    const viaPost = await post(srv.origin + '/api/license/claim', { session_id: sessionId });
    assert.equal(viaPost.json.token, first.json.token);
    assert.equal(mock.requests.length, stripeCalls, 'an issued license is served from the ledger');
    assert.equal(srv.app.licenses.stats().licenses, 1);
    const token = first.json.token;

    // 7. the token verifies
    const v = await verify(token);
    assert.equal(v.valid, true);
    assert.equal(v.license.id, first.json.license.id);
    assert.equal(v.license.product, 'founders-pass');
    assert.deepEqual(await verify(token.slice(0, -4) + 'AAAA'), { valid: false, reason: 'bad-signature' });
    assert.deepEqual(await verify('garbage'), { valid: false, reason: 'malformed' });

    // 8. ...and opens the relay: host + join + traffic
    const host = await relayTry(srv, { t: 'create', name: 'owner', license: token });
    assert.equal(host.reply.t, 'room');
    const code = host.reply.code;
    const guest = await relayTry(srv, { t: 'join', code, name: 'friend', license: token });
    assert.deepEqual(guest.reply, { t: 'room', code, slot: 1, host: false });
    const stranger = await relayTry(srv, { t: 'join', code, name: 'stranger' });
    assert.equal(stranger.reply.reason, 'license-required');
    guest.c.send({ t: 'chat', msg: 'worth every cent' });
    assert.equal((await host.c.next('chat')).msg, 'worth every cent');
    await host.c.flush();
    assert.ok(!JSON.stringify(host.c.inbox).includes('MCA1.'), 'tokens are never relayed to other players');

    // 9. a partial refund keeps the license; a full refund revokes it everywhere
    assert.equal((await sendWebhook(srv, mock.refund(sessionId, { full: false }))).status, 200);
    assert.equal((await verify(token)).valid, true);
    assert.equal((await sendWebhook(srv, mock.refund(sessionId))).status, 200);
    assert.deepEqual(await verify(token), { valid: false, reason: 'revoked' });
    const after = await relayTry(srv, { t: 'create', name: 'owner', license: token });
    assert.equal(after.reply.reason, 'license-revoked');
    const reclaim = await claim(sessionId);
    assert.equal(reclaim.status, 410);
    assert.equal(reclaim.json.error, 'license-revoked');
    assert.equal(reclaim.json.token, undefined);

    // 10. nothing secret ever reached the logs
    const logText = JSON.stringify(srv.logs);
    for (const secret of [token, token.split('.')[2], sessionId, 'buyer@example.com', ...Object.values(TEST_SECRETS)]) {
      assert.ok(!logText.includes(secret), 'log leak: ' + secret.slice(0, 14) + '…');
    }
    assert.ok(srv.logs.some((l) => l.evt === 'license.issue' && l.lid === first.json.license.id));
    assert.ok(srv.logs.some((l) => l.evt === 'stripe.webhook.rejected' && l.reason === 'signature-mismatch'));
    for (const c of [noLic.c, host.c, guest.c, stranger.c, after.c]) c.terminate();
  });

  test('claim works when the webhook has not arrived yet, and the late webhook does not double-issue', async (t) => {
    const { srv, mock, checkout, claim } = await storeSetup(t);
    const { sessionId } = await checkout();
    const event = mock.pay(sessionId);
    const first = await claim(sessionId); // verified live against Stripe
    assert.equal(first.status, 200);
    assert.equal(mock.requests.at(-1).method, 'GET');
    assert.equal(JSON.parse((await sendWebhook(srv, event)).body).received, true);
    assert.equal(srv.app.licenses.stats().licenses, 1);
    assert.equal((await claim(sessionId)).json.token, first.json.token);
    // concurrent claims for one fresh session still yield exactly one license
    const { sessionId: s2 } = await checkout();
    mock.pay(s2);
    const many = await Promise.all(Array.from({ length: 8 }, () => claim(s2)));
    assert.equal(new Set(many.map((r) => r.json.token)).size, 1);
    assert.equal(srv.app.licenses.stats().licenses, 2);
  });

  test('delayed payment methods: no license until the money has actually arrived', async (t) => {
    const { srv, mock, checkout, claim } = await storeSetup(t);
    const { sessionId } = await checkout();
    const completed = mock.pay(sessionId, { paymentStatus: 'unpaid' }); // e.g. bank debit pending
    assert.equal((await sendWebhook(srv, completed)).status, 200);
    assert.equal(srv.app.licenses.stats().licenses, 0);
    assert.equal((await claim(sessionId)).status, 402);
    assert.equal((await sendWebhook(srv, mock.settle(sessionId))).status, 200);
    assert.equal(srv.app.licenses.stats().licenses, 1);
    assert.equal((await claim(sessionId)).status, 200);
  });

  test('disputes revoke; a won dispute reinstates; a refund is final', async (t) => {
    const { srv, mock, checkout, claim, verify } = await storeSetup(t);
    const { sessionId } = await checkout();
    await sendWebhook(srv, mock.pay(sessionId));
    const token = (await claim(sessionId)).json.token;
    await sendWebhook(srv, mock.dispute(sessionId));
    assert.deepEqual(await verify(token), { valid: false, reason: 'revoked' });
    assert.equal((await claim(sessionId)).status, 410);
    await sendWebhook(srv, mock.disputeClosed(sessionId, 'lost'));
    assert.equal((await verify(token)).valid, false);
    await sendWebhook(srv, mock.disputeClosed(sessionId, 'won'));
    assert.equal((await verify(token)).valid, true);
    assert.equal((await claim(sessionId)).json.token, token);
    await sendWebhook(srv, mock.refund(sessionId));
    await sendWebhook(srv, mock.disputeClosed(sessionId, 'won'));
    assert.deepEqual(await verify(token), { valid: false, reason: 'revoked' }, 'winning a dispute does not undo a refund');
  });

  test('a refunded or disputed payment can never be claimed, even if we never saw the webhook', async (t) => {
    const { srv, mock, checkout, claim } = await storeSetup(t);
    const a = await checkout();
    mock.pay(a.sessionId);
    mock.refund(a.sessionId); // refund happened, webhook lost
    const res = await claim(a.sessionId);
    assert.equal(res.status, 410);
    assert.equal(srv.app.licenses.stats().licenses, 0);

    const b = await checkout();
    mock.pay(b.sessionId);
    mock.dispute(b.sessionId);
    assert.equal((await claim(b.sessionId)).status, 410);

    // refund webhook first, payment webhook second (out of order): still nothing issued
    const c = await checkout();
    const paid = mock.pay(c.sessionId);
    await sendWebhook(srv, mock.refund(c.sessionId));
    await sendWebhook(srv, paid);
    assert.equal(srv.app.licenses.stats().licenses, 0);
    assert.equal((await claim(c.sessionId)).status, 410);
  });

  test('sessions that are not ours, unknown or malformed are refused', async (t) => {
    const { srv, mock, checkout, claim } = await storeSetup(t);
    // a paid session of some OTHER product on the same Stripe account
    const { sessionId } = await checkout();
    const foreign = mock.sessions.get(sessionId);
    foreign.metadata = { mca_product: 'another-game' };
    const event = mock.pay(sessionId);
    assert.equal((await sendWebhook(srv, event)).status, 200);
    assert.equal(srv.app.licenses.stats().licenses, 0);
    assert.equal((await claim(sessionId)).status, 404);
    assert.equal((await claim('cs_test_0000000000000000unknown')).status, 404);

    const calls = mock.requests.length;
    for (const bad of ['', 'x', 'cs_', '../../v1/charges', 'cs_test_ab/../x', 'pi_1234567890', 'cs_test_<script>', 'cs_test_' + 'a'.repeat(300)]) {
      const res = await claim(bad);
      assert.equal(res.status, 400, bad);
      assert.equal(res.json.error, 'invalid-session-id');
    }
    assert.equal((await http(srv.origin + '/api/license/claim')).status, 400);
    assert.equal(mock.requests.length, calls, 'malformed ids never reach Stripe');

    // signed, but not an event we act on / not well-formed
    assert.equal((await sendWebhook(srv, mock.event('customer.created', { id: 'cus_1' }))).status, 200);
    assert.equal((await sendWebhook(srv, { nonsense: true })).status, 400);
    const live = mock.event('checkout.session.completed', mock.sessions.get(sessionId));
    live.livemode = true; // a live-mode event must never be honoured by a test-mode server
    const { sessionId: s2 } = await checkout();
    const paid2 = mock.pay(s2);
    paid2.livemode = true;
    assert.deepEqual(JSON.parse((await sendWebhook(srv, paid2)).body), { received: true, ignored: 'livemode-mismatch' });
    assert.equal(srv.app.licenses.stats().licenses, 0);
    void live;
  });

  test('Stripe being down is reported honestly and leaks nothing', async (t) => {
    const { srv, mock, checkout, claim } = await storeSetup(t);
    mock.failNext({ status: 500 });
    const res = await post(srv.origin + '/api/checkout', {});
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'payment-provider-error');
    assert.ok(!res.text.includes('sk_test'));
    const { sessionId } = await checkout();
    mock.pay(sessionId);
    mock.failNext({ status: 503 });
    assert.equal((await claim(sessionId)).status, 502);
    assert.equal((await claim(sessionId)).status, 200, 'works again once Stripe is back');
    assert.ok(srv.logs.some((l) => l.evt === 'stripe.checkout.failed' && l.status === 500));
  });

  test('a wrong Stripe key is a 502 for the buyer and an error in the log (not a crash)', async (t) => {
    const mock = await startStripeMock({ secretKey: 'sk_test_theRealKeyIsDifferent00', priceId: TEST_SECRETS.STRIPE_PRICE_ID });
    const srv = await startServer({ ...TEST_SECRETS, STRIPE_API_BASE: mock.base, PUBLIC_URL: 'https://play.example.com' });
    t.after(async () => { await srv.close(); await mock.close(); });
    const res = await post(srv.origin + '/api/checkout', {});
    assert.equal(res.status, 502);
    assert.ok(srv.logs.some((l) => l.evt === 'stripe.checkout.failed' && l.kind === 'auth'));
    assert.ok(!JSON.stringify(srv.logs).includes(TEST_SECRETS.STRIPE_SECRET_KEY));
  });

  test('request hygiene: methods, content type, body size, rate limit', async (t) => {
    const { srv } = await storeSetup(t);
    assert.equal((await http(srv.origin + '/api/checkout')).status, 405);
    assert.equal((await http(srv.origin + '/api/stripe/webhook')).status, 405);
    assert.equal((await http(srv.origin + '/api/license/verify')).status, 405);
    assert.equal((await http(srv.origin + '/api/license/claim?session_id=cs_test_aaaaaaaaaaaa', { method: 'DELETE' })).status, 405);
    assert.equal((await http(srv.origin + '/api/nope')).status, 404);
    const form = await http(srv.origin + '/api/checkout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    assert.equal(form.status, 415, 'cross-site form posts cannot start a checkout');
    assert.equal((await http(srv.origin + '/api/license/verify', { method: 'POST', headers: JSON_HEADERS, body: '{broken' })).status, 400);
    assert.equal((await http(srv.origin + '/api/license/verify', { method: 'POST', headers: JSON_HEADERS, body: '[1,2]' })).status, 400);
    // bodies over the limit: a clean 413 when the request fits in one piece...
    const over = await http(srv.origin + '/api/license/verify', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'x'.repeat(9000) }) });
    assert.equal(over.status, 413);
    assert.equal(over.json.error, 'payload-too-large');
    // ...and a huge upload is cut off (413, or the connection is simply dropped) -- never buffered, never processed
    const flood = (pathname, size, extra = {}) => rawRequest(srv.origin + pathname, {
      method: 'POST', headers: { ...JSON_HEADERS, 'content-length': size, ...extra }, body: Buffer.alloc(size, 0x20),
    }).then((r) => r.status, (e) => 'dropped:' + e.code);
    const outcomes = [
      await flood('/api/license/verify', 4 * 1024 * 1024),
      await flood('/api/stripe/webhook', 4 * 1024 * 1024, { 'stripe-signature': 't=1,v1=00' }),
    ];
    for (const o of outcomes) assert.ok(o === 413 || String(o).startsWith('dropped:'), 'unexpected outcome ' + o);
    assert.equal((await http(srv.origin + '/healthz')).json.status, 'ok');

    let last = null;
    for (let i = 0; i < 8; i++) last = await post(srv.origin + '/api/checkout', {});
    assert.equal(last.status, 429, 'checkout creation is throttled per address');
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    assert.equal((await http(srv.origin + '/healthz')).status, 200, 'health checks are never throttled');
  });
});

describe('paywall enforcement on the relay', () => {
  for (const mode of ['multiplayer', 'full']) {
    test('MCA_PAYWALL=' + mode + ': create/join need a valid license', async (t) => {
      const srv = await startServer({ MCA_PAYWALL: mode, LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN });
      t.after(() => srv.close());
      assert.match((await http(srv.origin + '/config.js')).text, new RegExp('"paywall": "' + mode + '"'));
      const keys = (await admin(srv, { action: 'mint', count: 2 })).json.licenses;

      const denied = await relayTry(srv, { t: 'create', name: 'a' });
      assert.equal(denied.reply.reason, 'license-required');
      for (const bad of [123, null, {}, '', 'nope', keys[0].token + 'x', keys[0].token.replace('MCA1', 'MCA2')]) {
        denied.c.send({ t: 'create', name: 'a', license: bad });
        const err = await denied.c.next('error');
        assert.ok(['license-required', 'license-invalid'].includes(err.reason), JSON.stringify(bad));
      }
      // the same socket succeeds once it presents a real key
      denied.c.send({ t: 'create', name: 'a', license: keys[0].token });
      const room = await denied.c.next('room');
      const guest = await relayTry(srv, { t: 'join', code: room.code, name: 'b', license: keys[1].token });
      assert.equal(guest.reply.slot, 1);
      const freeloader = await relayTry(srv, { t: 'join', code: room.code, name: 'c' });
      assert.equal(freeloader.reply.reason, 'license-required');

      // revocation applies to new sessions
      await admin(srv, { action: 'revoke', id: keys[1].id, reason: 'chargeback' });
      const again = await relayTry(srv, { t: 'join', code: room.code, name: 'b2', license: keys[1].token });
      assert.equal(again.reply.reason, 'license-revoked');
      await admin(srv, { action: 'reinstate', id: keys[1].id });
      again.c.send({ t: 'join', code: room.code, name: 'b2', license: keys[1].token });
      assert.equal((await again.c.next('room')).slot, 2);
      for (const c of [denied.c, guest.c, freeloader.c, again.c]) c.terminate();
    });
  }

  test('a key from another deployment (different secret) or another product does not work', async (t) => {
    const other = await startServer({ LICENSE_SECRET: 'Zx8#another-deployment-secret-value-0001', ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN });
    const dlc = await startServer({ LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN, PRODUCT_ID: 'soundtrack' });
    const srv = await startServer({ MCA_PAYWALL: 'multiplayer', LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET });
    t.after(async () => { await other.close(); await dlc.close(); await srv.close(); });
    for (const issuer of [other, dlc]) {
      const token = (await admin(issuer, { action: 'mint' })).json.licenses[0].token;
      const res = await relayTry(srv, { t: 'create', name: 'x', license: token });
      assert.equal(res.reply.reason, 'license-invalid');
      res.c.terminate();
    }
  });

  test('one key cannot be shared without limit (MAX_CONNS_PER_LICENSE)', async (t) => {
    const srv = await startServer({ MCA_PAYWALL: 'multiplayer', LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN, MAX_CONNS_PER_LICENSE: '2' });
    t.after(() => srv.close());
    const token = (await admin(srv, { action: 'mint' })).json.licenses[0].token;
    const a = await relayTry(srv, { t: 'create', name: 'a', license: token });
    const b = await relayTry(srv, { t: 'join', code: a.reply.code, name: 'b', license: token });
    assert.equal(b.reply.slot, 1);
    const c = await relayTry(srv, { t: 'join', code: a.reply.code, name: 'c', license: token });
    assert.equal(c.reply.reason, 'license-in-use');
    b.c.send({ t: 'leave' });
    await b.c.waitClose();
    await sleep(30);
    c.c.send({ t: 'join', code: a.reply.code, name: 'c', license: token });
    assert.equal((await c.c.next('room')).slot, 1, 'the seat frees up when a session ends');
    // a host leaving frees the seats of everyone in the room
    a.c.terminate();
    await c.c.next('bye');
    c.c.send({ t: 'create', name: 'c', license: token });
    assert.equal((await c.c.next('room')).slot, 0);
    const d = await relayTry(srv, { t: 'create', name: 'd', license: token });
    assert.equal(d.reply.t, 'room');
    c.c.terminate(); d.c.terminate();
  });
});

describe('admin endpoint', () => {
  test('authentication: missing, wrong and right tokens; brute force is throttled', async (t) => {
    const srv = await startServer({ LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN });
    t.after(() => srv.close());
    const url = srv.origin + '/api/admin/license';
    const none = await post(url, { action: 'mint' });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('www-authenticate'), 'Bearer');
    assert.equal(none.json.licenses, undefined);
    assert.equal((await admin(srv, { action: 'mint' }, 'wrong-token-wrong-token-wrong')).status, 401);
    assert.equal((await admin(srv, { action: 'mint' }, TEST_SECRETS.ADMIN_TOKEN.slice(0, -1))).status, 401);
    assert.equal((await admin(srv, { action: 'mint' }, TEST_SECRETS.ADMIN_TOKEN + 'x')).status, 401);
    assert.equal((await post(url, { action: 'mint' }, { authorization: 'Basic ' + Buffer.from('admin:' + TEST_SECRETS.ADMIN_TOKEN).toString('base64') })).status, 401);
    assert.equal(srv.app.licenses.stats().licenses, 0);
    assert.equal((await http(url)).status, 405);
    // 5 failures so far: the address is now locked out, even with the right token
    const locked = await admin(srv, { action: 'mint' });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    assert.equal(srv.app.licenses.stats().licenses, 0);
    assert.equal(srv.logs.filter((l) => l.evt === 'admin.denied').length, 5);
    assert.ok(!JSON.stringify(srv.logs).includes(TEST_SECRETS.ADMIN_TOKEN));
  });

  test('mint / lookup / revoke / reinstate / list', async (t) => {
    const srv = await startServer({ LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN });
    t.after(() => srv.close());
    const verify = (token) => post(srv.origin + '/api/license/verify', { token }).then((r) => r.json);

    const batch = await admin(srv, { action: 'mint', count: 3, note: 'itch.io batch 1', email: 'Press@Example.com' });
    assert.equal(batch.status, 200);
    assert.equal(batch.json.licenses.length, 3);
    assert.equal(new Set(batch.json.licenses.map((l) => l.token)).size, 3);
    for (const l of batch.json.licenses) assert.equal((await verify(l.token)).valid, true);
    const [k1, k2] = batch.json.licenses;

    const found = await admin(srv, { action: 'lookup', email: 'press@example.com' });
    assert.equal(found.json.licenses.length, 3);
    assert.equal(found.json.licenses[0].token, k1.token, 'a lost key can be re-sent to its owner');
    assert.equal(found.json.licenses[0].note, 'itch.io batch 1');
    assert.equal((await admin(srv, { action: 'lookup', email: 'nobody@example.com' })).json.licenses.length, 0);
    assert.equal((await admin(srv, { action: 'lookup', id: k2.id })).json.licenses[0].token, k2.token);

    assert.deepEqual((await admin(srv, { action: 'revoke', id: k1.id, reason: 'leaked on a forum' })).json, { ok: true, id: k1.id, changed: true });
    assert.deepEqual((await admin(srv, { action: 'revoke', token: k2.token })).json, { ok: true, id: k2.id, changed: true });
    assert.deepEqual(await verify(k1.token), { valid: false, reason: 'revoked' });
    assert.deepEqual(await verify(k2.token), { valid: false, reason: 'revoked' });
    assert.equal((await admin(srv, { action: 'reinstate', token: k2.token })).json.changed, true);
    assert.equal((await verify(k2.token)).valid, true);

    const list = await admin(srv, { action: 'list' });
    assert.equal(list.json.licenses.length, 3);
    assert.equal(list.json.revoked, 1);
    assert.deepEqual(list.json.licenses.find((l) => l.id === k1.id), {
      id: k1.id, product: 'founders-pass', issuedAt: list.json.licenses[0].issuedAt, source: 'admin',
      revoked: true, revokedReason: 'leaked on a forum', note: 'itch.io batch 1',
    });
    assert.ok(!list.text.includes('MCA1.'), 'list never returns tokens');

    for (const bad of [{ action: 'mint', count: 0 }, { action: 'mint', count: 101 }, { action: 'mint', count: '5' }, { action: 'mint', count: 1.5 }]) {
      assert.equal((await admin(srv, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await admin(srv, { action: 'revoke', id: 'nope' })).status, 400);
    assert.equal((await admin(srv, { action: 'revoke', token: 'MCA1.a.b' })).status, 400);
    assert.equal((await admin(srv, { action: 'drop-table' })).status, 400);
    assert.equal((await admin(srv, {})).status, 400);
    assert.equal(srv.app.licenses.stats().licenses, 3);

    // a browser on some other site is turned away even with the right token
    const cross = await post(srv.origin + '/api/admin/license', { action: 'list' }, { authorization: 'Bearer ' + TEST_SECRETS.ADMIN_TOKEN, origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
  });
});

describe('CORS', () => {
  test('same-origin only by default; ALLOWED_ORIGINS opens the public API to a separately hosted client', async (t) => {
    const closed = await startServer({ LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN });
    const open = await startServer({ LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, ADMIN_TOKEN: TEST_SECRETS.ADMIN_TOKEN, ALLOWED_ORIGINS: 'https://game.example.io' });
    t.after(async () => { await closed.close(); await open.close(); });
    const preflight = (srv, pathname, origin) => rawRequest(srv.origin + pathname, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });

    // default: no CORS headers for anyone, preflights are refused
    let res = await rawRequest(closed.origin + '/api/rooms', { headers: { origin: 'https://game.example.io' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    res = await preflight(closed, '/api/license/verify', 'https://game.example.io');
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);

    // allowlisted origin
    res = await rawRequest(open.origin + '/api/rooms', { headers: { origin: 'https://game.example.io' } });
    assert.equal(res.headers['access-control-allow-origin'], 'https://game.example.io');
    assert.equal(res.headers.vary, 'Origin');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
    res = await preflight(open, '/api/license/verify', 'https://game.example.io');
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'https://game.example.io');
    assert.match(res.headers['access-control-allow-methods'], /POST/);
    assert.match(res.headers['access-control-allow-headers'], /content-type/i);

    // anyone else, lookalikes, and the sensitive routes
    for (const origin of ['https://evil.example', 'https://game.example.io.evil.example', 'http://game.example.io', 'null']) {
      res = await rawRequest(open.origin + '/api/rooms', { headers: { origin } });
      assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
      assert.equal((await preflight(open, '/api/checkout', origin)).status, 403, origin);
    }
    for (const pathname of ['/api/admin/license', '/api/stripe/webhook']) {
      res = await preflight(open, pathname, 'https://game.example.io');
      assert.equal(res.status, 403, pathname);
      assert.equal(res.headers['access-control-allow-origin'], undefined, pathname);
    }
  });
});

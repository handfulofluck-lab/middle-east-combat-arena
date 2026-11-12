// License tokens and the append-only ledger (unit level, no network).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createLicenseService, deriveKeys } from '../license.js';
import { makeTempDir, TEST_SECRETS } from './helpers/harness.mjs';

const SECRET = TEST_SECRETS.LICENSE_SECRET;

function service(t, overrides = {}) {
  const dir = overrides.dataDir || makeTempDir('mca-lic-');
  if (!overrides.dataDir) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const svc = createLicenseService({ secret: SECRET, productId: 'founders-pass', dataDir: dir, log: null, ...overrides });
  t.after(() => svc.close());
  return svc;
}

const decodePayload = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

describe('license tokens', () => {
  test('sign -> verify round trip; the token carries no personal data', (t) => {
    const svc = service(t);
    const { record, created } = svc.issue({ source: 'stripe', sessionId: 'cs_test_abc12345', paymentIntentId: 'pi_1', email: 'Buyer@Example.com' });
    assert.equal(created, true);
    const token = svc.tokenFor(record);
    assert.match(token, /^MCA1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
    const v = svc.verify(token);
    assert.equal(v.ok, true);
    assert.equal(v.payload.lid, record.lid);

    const payload = decodePayload(token);
    assert.deepEqual(Object.keys(payload).sort(), ['eh', 'iat', 'lid', 'prd', 'src', 'v']);
    assert.match(payload.lid, /^lic_[0-9a-f]{24}$/);
    assert.equal(payload.prd, 'founders-pass');
    assert.equal(payload.src, 'stripe');
    assert.ok(Math.abs(payload.iat - Date.now() / 1000) < 5);
    const text = Buffer.from(token.split('.')[1], 'base64url').toString('utf8').toLowerCase();
    assert.ok(!text.includes('buyer') && !text.includes('example.com') && !text.includes('cs_test') && !text.includes('pi_1'));
    // the e-mail hash is keyed: it is not a plain digest anyone could recompute
    const plain = crypto.createHash('sha256').update('buyer@example.com').digest();
    assert.ok(!payload.eh.startsWith(plain.toString('base64url').slice(0, 10)));
    assert.equal(payload.eh.length, 22);
  });

  test('tokens are deterministic and survive whitespace; e-mail hash is case/space-insensitive', (t) => {
    const svc = service(t);
    const a = svc.issue({ source: 'admin', email: ' Someone@Example.com ' }).record;
    const b = svc.issue({ source: 'admin', email: 'someone@example.com' }).record;
    const c = svc.issue({ source: 'admin', email: 'other@example.com' }).record;
    const d = svc.issue({ source: 'admin' }).record;
    assert.equal(svc.tokenFor(a), svc.tokenFor(a));
    assert.notEqual(svc.tokenFor(a), svc.tokenFor(b));
    assert.equal(a.eh, b.eh);
    assert.notEqual(a.eh, c.eh);
    assert.equal(d.eh, undefined);
    assert.deepEqual(Object.keys(decodePayload(svc.tokenFor(d))).sort(), ['iat', 'lid', 'prd', 'src', 'v']);
    assert.equal(svc.verify('  ' + svc.tokenFor(a) + '\n').ok, true);
    assert.deepEqual(svc.findByEmail('SOMEONE@example.com').map((r) => r.lid).sort(), [a.lid, b.lid].sort());
  });

  test('tampering is detected', (t) => {
    const svc = service(t);
    const token = svc.tokenFor(svc.issue({ source: 'admin' }).record);
    const [prefix, body, sig] = token.split('.');

    // forge a different license id under the original signature
    const forged = { ...decodePayload(token), lid: 'lic_' + 'a'.repeat(24) };
    const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
    assert.deepEqual(svc.verify([prefix, forgedBody, sig].join('.')), { ok: false, reason: 'bad-signature' });

    // flip one character anywhere in the payload or the signature
    for (const i of [0, 5, body.length - 1]) {
      const ch = body[i] === 'A' ? 'B' : 'A';
      const bad = [prefix, body.slice(0, i) + ch + body.slice(i + 1), sig].join('.');
      assert.equal(svc.verify(bad).ok, false, 'payload flip at ' + i);
    }
    for (const i of [0, 40, 84]) {
      const ch = sig[i] === 'A' ? 'B' : 'A';
      const bad = [prefix, body, sig.slice(0, i) + ch + sig.slice(i + 1)].join('.');
      assert.equal(svc.verify(bad).ok, false, 'signature flip at ' + i);
    }
    // a self-signed token (attacker's own key) and a token from another secret
    const evil = crypto.generateKeyPairSync('ed25519');
    const evilSig = crypto.sign(null, Buffer.from(prefix + '.' + body), evil.privateKey).toString('base64url');
    assert.deepEqual(svc.verify([prefix, body, evilSig].join('.')), { ok: false, reason: 'bad-signature' });
    const other = createLicenseService({ secret: SECRET + 'x', productId: 'founders-pass', dataDir: makeTempDir('mca-lic-'), log: null });
    t.after(() => { other.close(); fs.rmSync(path.dirname(other.file), { recursive: true, force: true }); });
    assert.deepEqual(svc.verify(other.tokenFor(other.issue({ source: 'admin' }).record)), { ok: false, reason: 'bad-signature' });

    // structurally broken input never throws
    const junk = [undefined, null, 42, {}, [], '', 'MCA1', 'MCA1..', 'a.b.c', token + '.x', 'MCA2.' + body + '.' + sig,
      prefix + '.' + body, prefix + '.' + body + '.' + sig + 'A', prefix + '.' + body + '.' + sig.slice(0, 80),
      prefix + '.!!!.' + sig, prefix + '.' + body + '.' + sig.replace(/.$/, '='), 'x'.repeat(5000), prefix + '.' + 'A'.repeat(2000) + '.' + sig];
    for (const j of junk) {
      const v = svc.verify(j);
      assert.equal(v.ok, false);
      assert.ok(['malformed', 'bad-signature'].includes(v.reason), String(j).slice(0, 30) + ' -> ' + v.reason);
    }
    assert.equal(svc.verify(token).ok, true, 'the genuine token still verifies');
  });

  test('a correctly signed token for another product is refused', (t) => {
    const dir = makeTempDir('mca-lic-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dlc = service(t, { productId: 'some-dlc', dataDir: path.join(dir, 'a') });
    const base = service(t, { dataDir: path.join(dir, 'b') });
    const token = dlc.tokenFor(dlc.issue({ source: 'admin' }).record);
    assert.equal(dlc.verify(token).ok, true);
    assert.deepEqual(base.verify(token), { ok: false, reason: 'wrong-product' });
  });

  test('revoke / reinstate', (t) => {
    const svc = service(t);
    const rec = svc.issue({ source: 'admin' }).record;
    const token = svc.tokenFor(rec);
    assert.deepEqual(svc.revoke(rec.lid, 'refunded'), { ok: true, changed: true });
    assert.deepEqual(svc.revoke(rec.lid, 'again'), { ok: true, changed: false });
    const v = svc.verify(token);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'revoked');
    assert.equal(svc.revokedReason(rec.lid), 'refunded');
    assert.deepEqual(svc.reinstate(rec.lid), { ok: true, changed: true });
    assert.equal(svc.verify(token).ok, true);
    assert.equal(svc.revoke('not-a-license', 'x').ok, false);
  });

  test('the public key alone verifies a token (and the key is derived, stable, secret-specific)', (t) => {
    const svc = service(t);
    const token = svc.tokenFor(svc.issue({ source: 'admin' }).record);
    const [prefix, body, sig] = token.split('.');
    const pub = crypto.createPublicKey(svc.publicKeyPem);
    assert.equal(crypto.verify(null, Buffer.from(prefix + '.' + body), pub, Buffer.from(sig, 'base64url')), true);
    assert.equal(Buffer.from(svc.publicKeyRaw, 'base64url').length, 32);
    const pem = (s) => deriveKeys(s).publicKey.export({ type: 'spki', format: 'pem' });
    assert.equal(pem(SECRET), pem(SECRET));
    assert.notEqual(pem(SECRET), pem(SECRET + '!'));
    assert.equal(svc.publicKeyPem, pem(SECRET));
  });
});

describe('license ledger', () => {
  test('issue is idempotent per Checkout Session', (t) => {
    const svc = service(t);
    const a = svc.issue({ source: 'stripe', sessionId: 'cs_test_one11111', paymentIntentId: 'pi_one' });
    const b = svc.issue({ source: 'stripe', sessionId: 'cs_test_one11111', paymentIntentId: 'pi_one' });
    const c = svc.issue({ source: 'stripe', sessionId: 'cs_test_two22222', paymentIntentId: 'pi_two' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.record.lid, a.record.lid);
    assert.notEqual(c.record.lid, a.record.lid);
    assert.equal(svc.findBySession('cs_test_one11111').lid, a.record.lid);
    assert.equal(svc.findBySession('cs_test_nope0000'), null);
    assert.deepEqual(svc.stats(), { licenses: 2, revoked: 0 });
  });

  test('refund / dispute by payment: revoke, tombstone, reinstate', (t) => {
    const svc = service(t);
    const a = svc.issue({ source: 'stripe', sessionId: 'cs_test_aaaaaaaa', paymentIntentId: 'pi_a' }).record;
    assert.equal(svc.revokePayment('pi_a', 'refunded').lid, a.lid);
    assert.equal(svc.isRevoked(a.lid), true);

    // refunded before any license existed: one can never be issued for it
    assert.equal(svc.revokePayment('pi_ghost', 'refunded').lid, null);
    assert.equal(svc.isPaymentBlocked('pi_ghost'), 'refunded');
    const blocked = svc.issue({ source: 'stripe', sessionId: 'cs_test_ghost000', paymentIntentId: 'pi_ghost' });
    assert.equal(blocked.record, null);
    assert.equal(blocked.blocked, 'refunded');
    // ...unless we could not even tell the payment was ours
    svc.revokePayment('pi_foreign', 'disputed', { tombstone: false });
    assert.equal(svc.isPaymentBlocked('pi_foreign'), null);

    // dispute lost stays revoked; dispute won is undone, but a refund is not
    const d = svc.issue({ source: 'stripe', sessionId: 'cs_test_dddddddd', paymentIntentId: 'pi_d' }).record;
    svc.revokePayment('pi_d', 'disputed');
    assert.equal(svc.isRevoked(d.lid), true);
    assert.equal(svc.reinstatePayment('pi_d', 'disputed').changed, true);
    assert.equal(svc.isRevoked(d.lid), false);
    assert.equal(svc.reinstatePayment('pi_a', 'disputed').changed, false);
    assert.equal(svc.isRevoked(a.lid), true);
  });

  test('everything survives a restart; nothing sensitive is written to disk', (t) => {
    const dir = makeTempDir('mca-lic-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let svc = createLicenseService({ secret: SECRET, productId: 'founders-pass', dataDir: dir, log: null });
    const kept = svc.issue({ source: 'stripe', sessionId: 'cs_test_keep0000', paymentIntentId: 'pi_keep', email: 'keeper@example.com' }).record;
    const gone = svc.issue({ source: 'admin', note: 'press\u0007 key\nfor Kotaku' }).record;
    svc.revoke(gone.lid, 'leaked');
    svc.revokePayment('pi_ghost', 'refunded');
    const keptToken = svc.tokenFor(kept);
    const goneToken = svc.tokenFor(gone);
    svc.close();

    const raw = fs.readFileSync(path.join(dir, 'licenses.jsonl'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 4);
    for (const line of raw.trim().split('\n')) JSON.parse(line); // every line is one JSON record
    for (const secretish of [keptToken, goneToken, keptToken.split('.')[2], 'keeper@example.com', 'cs_test_keep0000', 'pi_keep', SECRET]) {
      assert.ok(!raw.includes(secretish), 'ledger must not contain ' + secretish.slice(0, 12) + '…');
    }
    assert.equal(fs.statSync(path.join(dir, 'licenses.jsonl')).mode & 0o077, 0, 'ledger is private to the server user');
    assert.equal(svc.describe(gone).note, 'press  key for Kotaku');

    svc = createLicenseService({ secret: SECRET, productId: 'founders-pass', dataDir: dir, log: null });
    t.after(() => svc.close());
    assert.deepEqual(svc.stats(), { licenses: 2, revoked: 1 });
    assert.equal(svc.verify(keptToken).ok, true);
    assert.equal(svc.verify(goneToken).reason, 'revoked');
    assert.equal(svc.findBySession('cs_test_keep0000').lid, kept.lid);
    assert.equal(svc.tokenFor(svc.findBySession('cs_test_keep0000')), keptToken, 're-derived token is byte-identical');
    assert.equal(svc.isPaymentBlocked('pi_ghost'), 'refunded');
    assert.equal(svc.issue({ source: 'stripe', sessionId: 'cs_test_keep0000' }).created, false);
  });

  test('a torn final line (crash mid-write) is skipped and never corrupts later records', (t) => {
    const dir = makeTempDir('mca-lic-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'licenses.jsonl');
    let svc = createLicenseService({ secret: SECRET, productId: 'founders-pass', dataDir: dir, log: null });
    const first = svc.issue({ source: 'admin' }).record;
    svc.close();
    fs.appendFileSync(file, '{"op":"issue","lid":"lic_0000'); // power cut mid-record
    fs.appendFileSync(file.replace('licenses', 'unrelated'), 'x');

    const warnings = [];
    const log = { warn: (evt, f) => warnings.push([evt, f]), info: () => {} };
    svc = createLicenseService({ secret: SECRET, productId: 'founders-pass', dataDir: dir, log });
    assert.deepEqual(warnings, [['license.ledger.skipped', { lines: 1 }]]);
    assert.deepEqual(svc.stats(), { licenses: 1, revoked: 0 });
    const second = svc.issue({ source: 'admin' }).record;
    svc.revoke(first.lid, 'test');
    svc.close();

    svc = createLicenseService({ secret: SECRET, productId: 'founders-pass', dataDir: dir, log: null });
    t.after(() => svc.close());
    assert.deepEqual(svc.stats(), { licenses: 2, revoked: 1 });
    assert.ok(svc.get(second.lid));
    assert.equal(svc.isRevoked(first.lid), true);
    // garbage and foreign lines are tolerated too
    svc.close();
    fs.appendFileSync(file, 'not json\n{"op":"unknown"}\n[]\n{"op":"issue","lid":"bad"}\n');
    const again = createLicenseService({ secret: SECRET, productId: 'founders-pass', dataDir: dir, log: null });
    t.after(() => again.close());
    assert.deepEqual(again.stats(), { licenses: 2, revoked: 1 });
  });

  test('a write that cannot be made durable fails loudly and changes nothing', (t) => {
    const svc = service(t);
    svc.issue({ source: 'admin' });
    svc.close(); // simulates a dead descriptor / full disk
    assert.throws(() => svc.issue({ source: 'admin' }), /ledger/);
    assert.deepEqual(svc.stats(), { licenses: 1, revoked: 0 });
  });
});

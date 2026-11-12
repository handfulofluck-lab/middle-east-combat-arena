// Configuration rules and the real process (node server/index.js): what turns
// features on, what keeps them off, what refuses to boot, graceful shutdown.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, test } from 'node:test';
import { describeConfig, loadConfig, secretStrength } from '../config.js';
import { clientIp, ipKey, pickEncoding, safeEqual } from '../http-util.js';
import { createLogger } from '../log.js';
import { KeyedLimiter, TokenBucket } from '../ratelimit.js';
import { Client, http, listenInRange, makeTempDir, makeWebRoot, sleep, TEST_SECRETS } from './helpers/harness.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const FULL = { ...TEST_SECRETS, PUBLIC_URL: 'https://play.example.com' };

describe('configuration', () => {
  test('defaults: everything money-related is off, limits are sane', () => {
    const c = loadConfig({});
    assert.deepEqual(c.errors, []);
    assert.equal(c.port, 8790);
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.webRoot, path.join(REPO, 'dist', 'web'));
    assert.equal(c.dataDir, path.join(REPO, 'data'));
    assert.equal(c.paywall, 'off');
    assert.equal(c.trustProxy, 0);
    assert.equal(c.allowedOrigins.size, 0);
    assert.deepEqual(c.product, { id: 'founders-pass', name: "Founder's Pass", priceLabel: '' });
    assert.equal(c.features.licensing.enabled, false);
    assert.equal(c.features.store.enabled, false);
    assert.equal(c.features.admin.enabled, false);
    assert.deepEqual(c.features.licensing.reasons, ['LICENSE_SECRET is not set']);
    assert.ok(c.features.store.reasons.includes('STRIPE_SECRET_KEY is not set'));
    assert.equal(c.limits.maxMsgBytes, 64 * 1024);
    assert.equal(c.limits.maxConnsPerIp, 16);
    assert.equal(c.stripe.apiBase, 'https://api.stripe.com');
    assert.deepEqual(c.secrets, { license: '', admin: '', stripeKey: '', stripeWebhook: '' });
    assert.equal(c.version, JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version);
  });

  test('secret strength', () => {
    assert.equal(secretStrength(undefined, 32), 'missing');
    assert.equal(secretStrength('', 32), 'missing');
    assert.match(secretStrength('short', 32), /shorter than 32/);
    assert.match(secretStrength('a'.repeat(40), 32), /variety/);
    assert.match(secretStrength('abababababababababababababababababab', 32), /variety/);
    assert.match(secretStrength('please-changeme-this-is-a-placeholder-0000', 32), /placeholder/);
    assert.match(secretStrength('your-secret-goes-here-abcdefghijklmnop', 32), /placeholder/);
    assert.equal(secretStrength(TEST_SECRETS.LICENSE_SECRET, 32), 'ok');
    assert.equal(secretStrength(TEST_SECRETS.ADMIN_TOKEN, 24), 'ok');
  });

  test('weak or missing secrets never enable a feature', () => {
    for (const bad of ['', 'hunter2', 'x'.repeat(64), 'changeme-changeme-changeme-changeme-1234']) {
      const c = loadConfig({ ...FULL, LICENSE_SECRET: bad });
      assert.equal(c.features.licensing.enabled, false, bad);
      assert.equal(c.features.store.enabled, false, 'no store without license signing');
      assert.equal(c.features.admin.enabled, false, 'no admin without license signing');
      assert.equal(c.secrets.license, '');
      assert.equal(c.secrets.stripeKey, '', 'a disabled store keeps no key in memory');
    }
    const weakAdmin = loadConfig({ ...FULL, ADMIN_TOKEN: 'admin' });
    assert.equal(weakAdmin.features.admin.enabled, false);
    assert.equal(weakAdmin.features.store.enabled, true);
    assert.equal(weakAdmin.secrets.admin, '');
    assert.ok(weakAdmin.warnings.some((w) => /ADMIN_TOKEN is set but was rejected/.test(w)));
  });

  test('the store needs ALL of: Stripe key, price, webhook secret, PUBLIC_URL, license signing', () => {
    const ok = loadConfig(FULL);
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.features.store.enabled, true);
    assert.equal(ok.features.store.livemode, false);
    assert.equal(ok.secrets.stripeKey, TEST_SECRETS.STRIPE_SECRET_KEY);
    for (const missing of ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'PUBLIC_URL', 'LICENSE_SECRET']) {
      const env = { ...FULL };
      delete env[missing];
      const c = loadConfig(env);
      assert.equal(c.features.store.enabled, false, 'without ' + missing);
      assert.ok(c.features.store.reasons.length >= 1);
    }
    // values that are present but wrong
    for (const [k, v] of [['STRIPE_SECRET_KEY', 'pk_test_thisIsAPublishableKey00'], ['STRIPE_SECRET_KEY', 'not-a-key'],
      ['STRIPE_PRICE_ID', 'prod_1234567890'], ['STRIPE_WEBHOOK_SECRET', 'sk_test_wrongKindOfSecret0000'],
      ['STRIPE_API_BASE', 'http://api.stripe.com'], ['STRIPE_API_BASE', 'ftp://x'], ['STRIPE_API_BASE', 'https://user:pw@api.stripe.com']]) {
      const c = loadConfig({ ...FULL, [k]: v });
      assert.equal(c.features.store.enabled, false, k + '=' + v);
    }
    // plain http is fine for a loopback test double only
    assert.equal(loadConfig({ ...FULL, STRIPE_API_BASE: 'http://127.0.0.1:8899' }).features.store.enabled, true);
    // live keys demand an https PUBLIC_URL
    // assembled at runtime so no key-shaped literal sits in the repository
    // (secret scanners rightly reject anything that looks like a live key)
    const live = { ...FULL, STRIPE_SECRET_KEY: ['sk', 'live', '51LiveKeyShapedValue000000'].join('_') };
    assert.equal(loadConfig(live).features.store.livemode, true);
    assert.equal(loadConfig(live).features.store.enabled, true);
    assert.equal(loadConfig({ ...live, PUBLIC_URL: 'http://play.example.com' }).features.store.enabled, false);
    assert.equal(loadConfig({ ...FULL, PUBLIC_URL: 'http://play.example.com' }).features.store.enabled, true, 'test keys may use http');
  });

  test('paywall: must be a known mode and must be satisfiable', () => {
    assert.equal(loadConfig({ MCA_PAYWALL: 'OFF' }).paywall, 'off');
    assert.equal(loadConfig({ ...FULL, MCA_PAYWALL: 'Multiplayer' }).paywall, 'multiplayer');
    assert.deepEqual(loadConfig({ ...FULL, MCA_PAYWALL: 'full' }).errors, []);
    assert.ok(loadConfig({ ...FULL, MCA_PAYWALL: 'full' }).warnings.some((w) => /gates the client UI only/.test(w)));
    assert.match(loadConfig({ MCA_PAYWALL: 'premium' }).errors.join('\n'), /MCA_PAYWALL must be one of: off, multiplayer, full/);
    for (const mode of ['multiplayer', 'full']) {
      assert.match(loadConfig({ MCA_PAYWALL: mode }).errors.join('\n'), /requires working license signing.*LICENSE_SECRET is not set/);
      assert.match(loadConfig({ MCA_PAYWALL: mode, LICENSE_SECRET: 'weak' }).errors.join('\n'), /LICENSE_SECRET rejected/);
    }
    const locked = loadConfig({ MCA_PAYWALL: 'multiplayer', LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET });
    assert.deepEqual(locked.errors, []);
    assert.ok(locked.warnings.some((w) => /nobody can obtain a license/.test(w)));
  });

  test('secrets cannot leak through serialization or the boot summary', () => {
    const c = loadConfig({ ...FULL, MCA_PAYWALL: 'multiplayer' });
    const dumps = [JSON.stringify(c), JSON.stringify(describeConfig(c)), JSON.stringify(Object.entries(c)), String(Object.keys(c))];
    for (const dump of dumps) for (const secret of Object.values(TEST_SECRETS)) {
      if (secret === TEST_SECRETS.STRIPE_PRICE_ID) continue; // a price id is not a secret
      assert.ok(!dump.includes(secret), 'secret found in a serialized config');
    }
    assert.equal(Object.keys(c).includes('secrets'), false);
    assert.equal(c.secrets.license, TEST_SECRETS.LICENSE_SECRET);
    assert.throws(() => { 'use strict'; c.paywall = 'off'; }, TypeError, 'config is frozen');
    // the logger redacts credential-looking fields and truncates long strings as a last line of defence
    const lines = [];
    const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });
    log.info('x', { token: 'MCA1.aaa.bbb', license: 'MCA1.aaa.bbb', nested: { authorization: 'Bearer abc', secret: 's3' }, note: 'y'.repeat(1000), err: new Error('boom\nline2') });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('\n'), 'one record = one line');
    const rec = JSON.parse(lines[0]);
    assert.deepEqual([rec.token, rec.license, rec.nested.authorization, rec.nested.secret], ['[redacted]', '[redacted]', '[redacted]', '[redacted]']);
    assert.ok(rec.note.length < 320);
    assert.equal(rec.err, 'boom\nline2');
    assert.match(rec.ts, /^\d{4}-\d\d-\d\dT/);
    assert.equal(rec.lvl, 'info');
  });

  test('numbers, origins, proxies and CSP extras are validated', () => {
    for (const [k, v] of [['PORT', 'eighty'], ['PORT', '70000'], ['MAX_ROOMS', '0'], ['MAX_MSG_BYTES', '12'], ['RATE_BURST', '-1'], ['HEARTBEAT_MS', '1.5']]) {
      assert.ok(loadConfig({ [k]: v }).errors.some((e) => e.startsWith(k + ' must be an integer')), k + '=' + v);
    }
    assert.ok(loadConfig({ MAX_MSG_BYTES: '1000000' }).errors.some((e) => /RATE_BYTES_BURST/.test(e)), 'a full-size message must fit the byte budget');
    assert.equal(loadConfig({ PORT: '0' }).port, 0);
    assert.equal(loadConfig({ PORT: ' 8080 ' }).port, 8080);

    const o = loadConfig({ ALLOWED_ORIGINS: 'https://A.example.com/, http://localhost:5173 ,' });
    assert.deepEqual([...o.allowedOrigins], ['https://a.example.com', 'http://localhost:5173']);
    assert.ok(loadConfig({ ALLOWED_ORIGINS: 'example.com' }).errors.length > 0);
    assert.ok(loadConfig({ ALLOWED_ORIGINS: '*' }).errors.length > 0, 'no wildcard origin');

    assert.equal(loadConfig({ TRUST_PROXY: '1' }).trustProxy, 1);
    assert.equal(loadConfig({ TRUST_PROXY: 'true' }).trustProxy, 1);
    assert.equal(loadConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
    assert.equal(loadConfig({ TRUST_PROXY: 'false' }).trustProxy, 0);
    assert.ok(loadConfig({ TRUST_PROXY: 'maybe' }).errors.length > 0);
    assert.ok(loadConfig({ CLIENT_IP_HEADER: 'bad header!' }).errors.length > 0);

    for (const bad of ['ftp://x', 'not a url', 'https://user:pw@example.com']) assert.ok(loadConfig({ PUBLIC_URL: bad }).errors.length > 0, bad);
    assert.equal(loadConfig({ PUBLIC_URL: 'https://Play.Example.com/game/?x=1#y' }).publicUrl, 'https://play.example.com/game');
    assert.ok(loadConfig({ RELAY_URL: 'https://relay.example.com' }).errors.length > 0, 'RELAY_URL must be ws(s)');
    assert.equal(loadConfig({ RELAY_URL: 'wss://relay.example.com/ws' }).relayUrl, 'wss://relay.example.com/ws');
    assert.ok(loadConfig({ PRODUCT_ID: 'Bad Id' }).errors.length > 0);

    const csp = loadConfig({ CSP_EXTRA: 'connect-src wss://eu.example.com https://stats.example.com; script-src https://plausible.io;' });
    assert.deepEqual(csp.cspExtra.map((e) => [e.directive, [...e.sources]]), [['connect-src', ['wss://eu.example.com', 'https://stats.example.com']], ['script-src', ['https://plausible.io']]]);
    assert.ok(loadConfig({ CSP_EXTRA: 'connect-src' }).errors.length > 0);
    assert.ok(loadConfig({ CSP_EXTRA: 'Connect-Src x, y' }).errors.length > 0);
  });
});

describe('small building blocks', () => {
  test('token bucket: burst, refill, retry-after', () => {
    const b = new TokenBucket(10, 20, 0);
    for (let i = 0; i < 20; i++) assert.equal(b.take(1, 0), true);
    assert.equal(b.take(1, 0), false);
    assert.equal(b.retryAfter(1, 0), 1);
    assert.equal(b.take(1, 100), true);     // 100 ms -> 1 token
    assert.equal(b.take(1, 100), false);
    assert.equal(b.take(5, 600), true);     // +500 ms -> 5 tokens
    assert.equal(b.take(21, 1e9), false);   // never more than the burst
    assert.equal(b.take(20, 1e9), true);
    assert.equal(b.take(1, 5), false, 'time going backwards mints nothing');
  });

  test('keyed limiter: independent keys, bounded memory', () => {
    const l = new KeyedLimiter({ ratePerSec: 1, burst: 2, maxKeys: 100 });
    assert.equal(l.take('a', 1, 0), true);
    assert.equal(l.take('a', 1, 0), true);
    assert.equal(l.take('a', 1, 0), false);
    assert.equal(l.peek('a', 1, 0), false);
    assert.equal(l.peek('b', 1, 0), true);
    assert.equal(l.take('b', 1, 0), true);
    assert.equal(l.take('a', 1, 1000), true);
    for (let i = 0; i < 5000; i++) l.take('flood-' + i, 1, 2000);
    assert.ok(l.buckets.size <= 100, 'table stays bounded: ' + l.buckets.size);
    l.sweep(1e9);
    assert.equal(l.buckets.size, 0, 'idle buckets are forgotten');
  });

  test('client address: forwarding headers only behind a trusted proxy; IPv6 is limited per /64', () => {
    const req = (remote, headers = {}) => ({ socket: { remoteAddress: remote }, headers });
    const direct = { trustProxy: 0, clientIpHeader: '' };
    assert.equal(clientIp(req('::ffff:198.51.100.7', { 'x-forwarded-for': '1.1.1.1' }), direct), '198.51.100.7');
    const one = { trustProxy: 1, clientIpHeader: '' };
    assert.equal(clientIp(req('10.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), one), '203.0.113.9', 'rightmost = what our proxy saw');
    assert.equal(clientIp(req('10.0.0.1', { 'x-forwarded-for': 'garbage' }), one), '10.0.0.1');
    assert.equal(clientIp(req('10.0.0.1', {}), one), '10.0.0.1');
    const two = { trustProxy: 2, clientIpHeader: '' };
    assert.equal(clientIp(req('10.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }), two), '203.0.113.9');
    assert.equal(clientIp(req('10.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), two), '203.0.113.9');
    const fly = { trustProxy: 1, clientIpHeader: 'fly-client-ip' };
    assert.equal(clientIp(req('10.0.0.1', { 'fly-client-ip': '2001:db8::1', 'x-forwarded-for': '9.9.9.9' }), fly), '2001:db8::1');
    assert.equal(clientIp(req('10.0.0.1', { 'x-forwarded-for': '9.9.9.9' }), fly), '9.9.9.9');
    assert.equal(clientIp(req('10.0.0.1', { 'fly-client-ip': '8.8.8.8' }), direct), '10.0.0.1', 'platform header ignored without TRUST_PROXY');

    assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
    assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKey('2001:db8:1:2::1'));
    assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
    assert.equal(ipKey('::1'), '0:0:0:0::/64');
  });

  test('constant-time compare and Accept-Encoding negotiation', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual(undefined, 'abc'), false);
    assert.equal(safeEqual('abc', null), false);
    assert.equal(pickEncoding('gzip, deflate, br'), 'br');
    assert.equal(pickEncoding('gzip'), 'gzip');
    assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
    assert.equal(pickEncoding('deflate'), '');
    assert.equal(pickEncoding('identity;q=1, *;q=0'), '');
    assert.equal(pickEncoding(undefined), '');
  });
});

describe('the real process: node server/index.js', () => {
  async function freePort() {
    let server = null;
    const port = await listenInRange((p) => new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(p, '127.0.0.1', () => { server = s; resolve(); });
    }));
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  function boot(env) {
    const child = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], {
      env: { PATH: process.env.PATH, HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = { stdout: '', stderr: '', code: undefined, signal: undefined };
    child.stdout.on('data', (d) => { out.stdout += d; });
    child.stderr.on('data', (d) => { out.stderr += d; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => { out.code = code; out.signal = signal; resolve(out); }));
    // a process that was expected to exit but keeps running is killed (and
    // reported with code 'still-running') instead of hanging the suite
    const exitWithin = (ms) => Promise.race([
      exited,
      sleep(ms).then(() => { if (out.code === undefined && out.signal === undefined) { child.kill('SIGKILL'); return { ...out, code: 'still-running' }; } return out; }),
    ]);
    const listening = async () => {
      for (let i = 0; i < 200; i++) {
        if (/"evt":"listening"/.test(out.stdout)) return true;
        if (out.code !== undefined) return false;
        await sleep(25);
      }
      return false;
    };
    const records = () => out.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { child, out, exited, exitWithin, listening, records };
  }

  test('an unsatisfiable or malformed configuration refuses to start (exit 1) and says why', async (t) => {
    const dir = makeTempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cases = [
      [{ MCA_PAYWALL: 'multiplayer' }, /MCA_PAYWALL=multiplayer requires working license signing/],
      [{ MCA_PAYWALL: 'full', LICENSE_SECRET: 'tooshort' }, /LICENSE_SECRET rejected/],
      [{ MCA_PAYWALL: 'everything' }, /MCA_PAYWALL must be one of/],
      [{ PORT: 'abc' }, /PORT must be an integer/],
      [{ ALLOWED_ORIGINS: 'nonsense' }, /ALLOWED_ORIGINS/],
    ];
    for (const [env, expected] of cases) {
      const p = boot({ PORT: String(await freePort()), WEB_ROOT: dir, DATA_DIR: path.join(dir, 'data'), ...env });
      const out = await p.exitWithin(10000);
      assert.equal(out.code, 1, JSON.stringify(env));
      assert.match(out.stderr, /did not start: invalid configuration/);
      assert.match(out.stderr, expected);
      assert.ok(!/"evt":"listening"/.test(out.stdout));
      for (const rec of p.records()) assert.equal(rec.evt, 'config.invalid');
    }
  });

  test('boots, serves, logs one JSON record per line with no secrets, and shuts down gracefully on SIGTERM', async (t) => {
    const dir = makeTempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const port = await freePort();
    const p = boot({
      PORT: String(port), WEB_ROOT: makeWebRoot(dir), DATA_DIR: path.join(dir, 'data'),
      ...FULL, MCA_PAYWALL: 'multiplayer', STRIPE_API_BASE: 'http://127.0.0.1:9', PRICE_LABEL: '$9.99',
    });
    t.after(() => { try { p.child.kill('SIGKILL'); } catch (e) { /* gone */ } });
    assert.equal(await p.listening(), true, p.out.stderr || p.out.stdout);
    const origin = 'http://127.0.0.1:' + port;

    assert.equal((await http(origin + '/healthz')).json.status, 'ok');
    assert.match((await http(origin + '/')).text, /MCA test shell/);
    assert.match((await http(origin + '/config.js')).text, /"storeEnabled": true/);
    const c = await Client.open('ws://127.0.0.1:' + port + '/ws');
    c.send({ t: 'create', name: 'no license' });
    assert.equal((await c.next('error')).reason, 'license-required');

    p.child.kill('SIGTERM');
    const out = await p.exitWithin(10000);
    assert.equal(out.code, 0, 'clean exit; stderr: ' + out.stderr);
    assert.equal(out.stderr, '');
    const closeInfo = await c.waitClose();
    assert.equal(closeInfo.code, 1001, 'clients are told the server is going away');
    assert.ok(c.inbox.some((m) => m.t === 'error' && m.reason === 'server-shutdown'));

    const recs = p.records(); // every stdout line parsed as JSON above
    const evts = recs.map((r) => r.evt);
    assert.ok(evts.includes('boot') && evts.includes('listening') && evts.includes('shutdown.begin'));
    assert.ok(evts.indexOf('boot') < evts.indexOf('listening') && evts.indexOf('listening') < evts.indexOf('shutdown.begin'));
    assert.equal(evts.at(-1), 'shutdown.done');
    const bootRec = recs.find((r) => r.evt === 'boot');
    assert.equal(bootRec.paywall, 'multiplayer');
    assert.equal(bootRec.storeMode, 'test');
    assert.deepEqual(bootRec.features, { licensing: true, store: true, admin: true });
    for (const secret of [TEST_SECRETS.LICENSE_SECRET, TEST_SECRETS.ADMIN_TOKEN, TEST_SECRETS.STRIPE_SECRET_KEY, TEST_SECRETS.STRIPE_WEBHOOK_SECRET]) {
      assert.ok(!out.stdout.includes(secret) && !out.stderr.includes(secret), 'a secret reached the process output');
    }
    assert.ok(fs.existsSync(path.join(dir, 'data', 'licenses.jsonl')), 'ledger created in DATA_DIR');
  });

  test('default boot explains every disabled feature; a busy port is a clear, fatal error', async (t) => {
    const dir = makeTempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const port = await freePort();
    const env = { PORT: String(port), WEB_ROOT: makeWebRoot(dir), DATA_DIR: path.join(dir, 'data') };
    const first = boot(env);
    t.after(() => { try { first.child.kill('SIGKILL'); } catch (e) { /* gone */ } });
    assert.equal(await first.listening(), true, first.out.stderr);
    const off = first.records().filter((r) => r.evt === 'feature.off');
    assert.deepEqual(off.map((r) => r.feature), ['licensing', 'store', 'admin']);
    assert.ok(off.every((r) => Array.isArray(r.why) && r.why.length > 0));
    assert.equal(fs.existsSync(path.join(dir, 'data')), false, 'no data directory is created while licensing is off');

    const second = boot(env);
    const out = await second.exitWithin(10000);
    assert.equal(out.code, 1);
    assert.match(out.stderr, new RegExp('could not listen on port ' + port));

    first.child.kill('SIGINT');
    assert.equal((await first.exitWithin(10000)).code, 0);
  });
});

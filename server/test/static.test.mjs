// Static hosting, /config.js and /healthz -- exercised over real HTTP with a
// raw client (no transparent decompression, paths sent verbatim).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { makeTempDir, rawRequest, startServer } from './helpers/harness.mjs';
import { inlineScriptHashes, isHashedAsset, safeRelativePath } from '../static.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');

describe('static hosting', () => {
  let srv;
  const get = (p, headers = {}, method = 'GET') => rawRequest(srv.origin, { path: p, headers, method });
  const disk = (rel) => fs.readFileSync(path.join(srv.webRoot, rel));

  before(async () => { srv = await startServer(); });
  after(() => srv.close());

  test('index.html: right type, no-cache, ETag, security headers, strict CSP', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.match(res.headers.etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
    assert.ok(res.headers['permissions-policy']);
    assert.equal(res.headers['strict-transport-security'], undefined, 'no HSTS without an https PUBLIC_URL');
    assert.deepEqual(res.body, disk('index.html'));

    const csp = res.headers['content-security-policy'];
    const directive = (name) => csp.split('; ').find((d) => d.startsWith(name + ' '));
    assert.equal(directive('default-src'), "default-src 'self'");
    assert.equal(directive('style-src'), "style-src 'self' 'unsafe-inline'");
    assert.equal(directive('img-src'), "img-src 'self' data: blob:");
    assert.equal(directive('object-src'), "object-src 'none'");
    assert.equal(directive('frame-ancestors'), "frame-ancestors 'self'");
    assert.equal(directive('connect-src'),
      `connect-src 'self' ws://127.0.0.1:${srv.port} wss://127.0.0.1:${srv.port} data: blob:`);
    // scripts: self + the exact hash of the page's inline script; no eval, no unsafe-inline
    const script = directive('script-src');
    const inline = 'window.__boot = "inline";';
    const hash = crypto.createHash('sha256').update(inline).digest('base64');
    assert.equal(script, `script-src 'self' 'wasm-unsafe-eval' 'sha256-${hash}'`);
    assert.ok(!/unsafe-inline|unsafe-eval'|\*/.test(script.replace("'wasm-unsafe-eval'", '')));
  });

  test('HEAD mirrors GET without a body', async () => {
    for (const p of ['/', '/assets/music.mp3', '/config.js', '/healthz']) {
      const g = await get(p);
      const h = await get(p, {}, 'HEAD');
      assert.equal(h.status, 200, p);
      assert.equal(h.body.length, 0, p);
      assert.equal(h.headers['content-type'], g.headers['content-type'], p);
      if (p !== '/healthz') assert.equal(h.headers['content-length'], String(g.body.length), p);
    }
    const hc = await get('/assets/index-BxK3a9Zq.js', { 'accept-encoding': 'gzip' }, 'HEAD');
    const gc = await get('/assets/index-BxK3a9Zq.js', { 'accept-encoding': 'gzip' });
    assert.equal(hc.headers['content-encoding'], 'gzip');
    assert.equal(hc.headers['content-length'], String(gc.body.length));
    assert.equal(hc.body.length, 0);
  });

  test('caching policy: hashed /assets are immutable, everything else revalidates', async () => {
    const immutable = 'public, max-age=31536000, immutable';
    assert.equal((await get('/assets/index-BxK3a9Zq.js')).headers['cache-control'], immutable);
    assert.equal((await get('/assets/style-Dq7hXk2P.css')).headers['cache-control'], immutable);
    assert.equal((await get('/assets/art.json')).headers['cache-control'], 'no-cache');
    assert.equal((await get('/maps/manifest.json')).headers['cache-control'], 'no-cache');
    assert.equal((await get('/index.html')).headers['cache-control'], 'no-cache');
    assert.equal((await get('/config.js')).headers['cache-control'], 'no-cache');
    // the classifier is biased towards "not hashed"
    assert.equal(isHashedAsset('/assets/index-BxK3a9Zq.js'), true);
    assert.equal(isHashedAsset('/assets/chunk-_aB-9xYz.js'), true);
    for (const p of ['/assets/art.json', '/assets/unit-artwork.json', '/assets/map-version2.json',
      '/assets/pack-20240101.json', '/assets/some-long-name.js', '/maps/index-BxK3a9Zq.js', '/index-BxK3a9Zq.js']) {
      assert.equal(isHashedAsset(p), false, p);
    }
  });

  test('ETag revalidation: If-None-Match -> 304, a changed file -> fresh 200', async () => {
    const first = await get('/maps/manifest.json');
    // prime the in-memory compressed copies of the ORIGINAL file
    for (const enc of ['br', 'gzip']) assert.equal((await get('/maps/manifest.json', { 'accept-encoding': enc })).headers['content-encoding'], enc);
    const again = await get('/maps/manifest.json', { 'if-none-match': first.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal(again.headers.etag, first.headers.etag);
    assert.equal(again.headers['cache-control'], 'no-cache');
    assert.equal((await get('/maps/manifest.json', { 'if-none-match': '"nope", ' + first.headers.etag })).status, 304);
    assert.equal((await get('/maps/manifest.json', { 'if-none-match': '"something-else"' })).status, 200);

    const file = path.join(srv.webRoot, 'maps', 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ maps: ['sinai', 'gulf'], pad: 'n'.repeat(3100) }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const changed = await get('/maps/manifest.json', { 'if-none-match': first.headers.etag, 'accept-encoding': 'br' });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, first.headers.etag);
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(changed.body)).maps, ['sinai', 'gulf'], 'no stale compressed copy');
    const gz = await get('/maps/manifest.json', { 'accept-encoding': 'gzip' });
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body)).maps, ['sinai', 'gulf'], 'no stale compressed copy (gzip)');
  });

  test('brotli / gzip on the fly for text types, cached, negotiated correctly', async () => {
    const raw = disk('assets/index-BxK3a9Zq.js');
    const br = await get('/assets/index-BxK3a9Zq.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.equal(br.headers['content-length'], String(br.body.length));
    assert.ok(br.body.length < raw.length / 4);
    assert.deepEqual(zlib.brotliDecompressSync(br.body), raw);

    const gz = await get('/assets/index-BxK3a9Zq.js', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.deepEqual(zlib.gunzipSync(gz.body), raw);

    const none = await get('/assets/index-BxK3a9Zq.js');
    assert.equal(none.headers['content-encoding'], undefined);
    assert.equal(none.headers.vary, 'Accept-Encoding', 'caches must still key on the encoding');
    assert.deepEqual(none.body, raw);

    assert.equal((await get('/assets/index-BxK3a9Zq.js', { 'accept-encoding': 'br;q=0, gzip;q=0.5' })).headers['content-encoding'], 'gzip');
    assert.equal((await get('/assets/index-BxK3a9Zq.js', { 'accept-encoding': 'identity' })).headers['content-encoding'], undefined);
    assert.equal((await get('/assets/index-BxK3a9Zq.js', { 'accept-encoding': '*' })).headers['content-encoding'], 'br');

    // json + html + css are compressed; tiny files and already-compressed media are not
    assert.equal((await get('/assets/art.json', { 'accept-encoding': 'br' })).headers['content-encoding'], 'br');
    assert.equal((await get('/assets/style-Dq7hXk2P.css', { 'accept-encoding': 'br' })).headers['content-encoding'], 'br');
    assert.equal((await get('/assets/tiny.json', { 'accept-encoding': 'br' })).headers['content-encoding'], undefined);
    const mp3 = await get('/assets/music.mp3', { 'accept-encoding': 'br, gzip' });
    assert.equal(mp3.headers['content-encoding'], undefined);
    assert.equal(mp3.headers['content-type'], 'audio/mpeg');
    assert.deepEqual(mp3.body, disk('assets/music.mp3'));

    // identical bytes on a repeat request (served from the in-memory cache)
    const br2 = await get('/assets/index-BxK3a9Zq.js', { 'accept-encoding': 'br' });
    assert.deepEqual(br2.body, br.body);
    // many concurrent first requests for one file all get a correct body
    const burst = await Promise.all(Array.from({ length: 12 }, () => get('/assets/style-Dq7hXk2P.css', { 'accept-encoding': 'gzip' })));
    for (const r of burst) assert.deepEqual(zlib.gunzipSync(r.body), disk('assets/style-Dq7hXk2P.css'));
  });

  test('MIME types', async () => {
    assert.equal((await get('/assets/index-BxK3a9Zq.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await get('/assets/style-Dq7hXk2P.css')).headers['content-type'], 'text/css; charset=utf-8');
    assert.equal((await get('/assets/art.json')).headers['content-type'], 'application/json; charset=utf-8');
    for (const res of [await get('/assets/index-BxK3a9Zq.js'), await get('/assets/music.mp3')]) {
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    }
  });

  test('byte ranges for media', async () => {
    const whole = disk('assets/music.mp3');
    const part = await get('/assets/music.mp3', { range: 'bytes=100-199' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], 'bytes 100-199/5000');
    assert.equal(part.headers['accept-ranges'], 'bytes');
    assert.deepEqual(part.body, whole.subarray(100, 200));
    const tail = await get('/assets/music.mp3', { range: 'bytes=-10' });
    assert.equal(tail.headers['content-range'], 'bytes 4990-4999/5000');
    assert.deepEqual(tail.body, whole.subarray(4990));
    const open = await get('/assets/music.mp3', { range: 'bytes=4000-' });
    assert.deepEqual(open.body, whole.subarray(4000));
    const beyond = await get('/assets/music.mp3', { range: 'bytes=4000-999999' });
    assert.equal(beyond.headers['content-range'], 'bytes 4000-4999/5000');
    const bad = await get('/assets/music.mp3', { range: 'bytes=9000-9100' });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers['content-range'], 'bytes */5000');
    assert.equal((await get('/assets/music.mp3', { range: 'lines=1-2' })).status, 200);
  });

  test('path traversal and hidden files never leak', async () => {
    const attacks = [
      '/../outside-secret.txt',
      '/..%2foutside-secret.txt',
      '/%2e%2e/outside-secret.txt',
      '/%2e%2e%2foutside-secret.txt',
      '/assets/../../outside-secret.txt',
      '/assets/..%2f..%2foutside-secret.txt',
      '/assets/..%5c..%5coutside-secret.txt',
      '/assets/%2e%2e/%2e%2e/outside-secret.txt',
      '/..%252foutside-secret.txt',
      '/....//outside-secret.txt',
      '/assets/link.txt',             // symlink that points outside the web root
      '/.env',
      '/.git/config',
      '/assets/.hidden',
      '/%00',
      '/index.html%00.png',
      '/assets/%ZZ',
      '/%c0%ae%c0%ae/outside-secret.txt', // overlong-encoded dots
      '/' + '..%2f'.repeat(30) + 'etc/passwd',
      '//etc/passwd',
      '/etc/passwd',
      '/etc/passwd.txt',
    ];
    const mustRefuse = attacks.filter((p) => p.includes('outside-secret') || p.includes('/.') || p.includes('%') || p.includes('link.txt'));
    for (const p of mustRefuse) assert.ok([400, 404].includes((await get(p)).status), p + ' must be refused');
    const shell = disk('index.html').toString('utf8');
    for (const p of attacks) {
      const res = await get(p);
      const body = res.body.toString('utf8');
      // refused outright, or (for a harmless extension-less path that merely
      // LOOKS absolute) answered with the app shell -- never with file contents
      if (res.status === 200) assert.equal(body, shell, p + ' -> 200 with a body that is not the app shell');
      else assert.ok([400, 404].includes(res.status), p + ' -> ' + res.status);
      assert.ok(!body.includes('TOP-SECRET'), p + ' leaked a file outside the web root');
      assert.ok(!body.includes('must-never-be-served'), p + ' leaked a dotfile');
      assert.ok(!body.includes('root:'), p);
    }
    assert.deepEqual(safeRelativePath('/a/./b//c'), { rel: 'a/b/c' });
    assert.deepEqual(safeRelativePath('/.well-known/security.txt'), { rel: '.well-known/security.txt' });
    assert.equal(safeRelativePath('/a/.well-known/x').error, 'hidden');
    assert.equal(safeRelativePath('/a/../b').error, 'traversal');
  });

  test('SPA fallback for routes, honest 404 for missing files', async () => {
    for (const p of ['/lobby/ABCD', '/play', '/some/deep/route/', '/?session_id=cs_test_abc123', '/index.html?x=1']) {
      const res = await get(p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', p);
      assert.deepEqual(res.body, disk('index.html'), p);
      assert.ok(res.headers['content-security-policy'], p);
    }
    for (const p of ['/assets/missing-BxK3a9Zq.js', '/maps/nope.json', '/favicon.ico', '/assets/', '/maps']) {
      const res = await get(p);
      if (p === '/assets/' || p === '/maps') { assert.equal(res.status, 200, p); continue; } // extension-less -> app shell
      assert.equal(res.status, 404, p);
      assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8', p);
    }
  });

  test('only GET and HEAD; over-long URLs are refused', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await get('/', {}, method);
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, 'GET, HEAD');
    }
    assert.equal((await get('/' + 'a'.repeat(3000))).status, 414);
  });
});

describe('/config.js', () => {
  // run the script the way a browser would, in a throwaway global
  function evaluate(source, preset) {
    const sandbox = { window: preset ? { MCA_CONFIG: preset } : {} };
    vm.runInNewContext(source, sandbox);
    return JSON.parse(JSON.stringify(sandbox.window.MCA_CONFIG));
  }

  test('defaults: nothing gated, store off, same-origin relay', async (t) => {
    const srv = await startServer();
    t.after(() => srv.close());
    const res = await rawRequest(srv.origin + '/config.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.deepEqual(evaluate(res.body.toString()), {
      relayUrl: '',
      apiBase: '',
      paywall: 'off',
      storeEnabled: false,
      redeemEnabled: false,
      product: { name: "Founder's Pass", priceLabel: '' },
      version: pkg.version,
    });
    // same shape as the static fallback the client ships with
    const fallback = evaluate(fs.readFileSync(path.join(REPO, 'client', 'public', 'config.js'), 'utf8'));
    for (const key of Object.keys(fallback)) assert.ok(key in evaluate(res.body.toString()), 'missing key ' + key);
  });

  test('reflects the environment; a pre-set window.MCA_CONFIG wins; values cannot break out of the script', async (t) => {
    const srv = await startServer({
      RELAY_URL: 'wss://relay.example.com/ws',
      API_BASE: 'https://api.example.com/',
      PRODUCT_NAME: 'Founder\u2028Pass </script><script>alert(1)</script>',
      PRICE_LABEL: '€9.99 & up',
    });
    t.after(() => srv.close());
    const body = (await rawRequest(srv.origin + '/config.js')).body.toString();
    assert.ok(!body.includes('</script>'));
    const code = body.split('\n').filter((line) => !line.startsWith('//')).join('\n');
    assert.ok(!/[<>&]/.test(code), 'no raw <, > or & survives in the generated script');
    assert.ok(!body.includes('\u2028'));
    const cfg = evaluate(body);
    assert.equal(cfg.relayUrl, 'wss://relay.example.com/ws');
    assert.equal(cfg.apiBase, 'https://api.example.com');
    assert.deepEqual(cfg.product, { name: 'Founder\u2028Pass </script><script>alert(1)</script>', priceLabel: '€9.99 & up' });
    const merged = evaluate(body, { relayUrl: 'ws://override:1', custom: true });
    assert.equal(merged.relayUrl, 'ws://override:1');
    assert.equal(merged.custom, true);
    assert.equal(merged.paywall, 'off');

    // the page's CSP lets the client reach the configured relay and API
    const csp = (await rawRequest(srv.origin + '/')).headers['content-security-policy'];
    assert.match(csp, /connect-src [^;]*wss:\/\/relay\.example\.com[ ;]/);
    assert.match(csp, /connect-src [^;]*https:\/\/api\.example\.com[ ;]/);
  });
});

describe('/healthz and deployment switches', () => {
  test('healthz reports uptime, rooms, peers and the package version', async (t) => {
    const srv = await startServer();
    t.after(() => srv.close());
    const res = await rawRequest(srv.origin + '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = JSON.parse(res.body.toString());
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(body).sort(), ['connections', 'paywall', 'peers', 'rooms', 'status', 'storeEnabled', 'uptime', 'version']);
    assert.equal(body.status, 'ok');
    assert.equal(body.version, pkg.version);
    assert.equal(body.rooms, 0);
    assert.equal(body.peers, 0);
    assert.ok(Number.isInteger(body.uptime) && body.uptime >= 0);
    assert.equal((await rawRequest(srv.origin + '/healthz', { method: 'POST' })).status, 405);
  });

  test('no client build: the server still runs and says what is missing', async (t) => {
    const dir = makeTempDir();
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    const srv = await startServer({}, { dir, webRoot: empty });
    t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const res = await rawRequest(srv.origin + '/');
    assert.equal(res.status, 404);
    assert.match(res.body.toString(), /npm run build/);
    assert.equal((await rawRequest(srv.origin + '/healthz')).status, 200);
    assert.equal((await rawRequest(srv.origin + '/config.js')).status, 200);
    // WEB_ROOT that does not exist at all behaves the same
    const srv2 = await startServer({}, { dir, webRoot: path.join(dir, 'does-not-exist') });
    t.after(() => srv2.close());
    assert.equal((await rawRequest(srv2.origin + '/')).status, 404);
  });

  test('CSP / framing / HSTS switches', async (t) => {
    const framed = await startServer({ FRAME_ANCESTORS: 'https://itch.io https://*.itch.io', PUBLIC_URL: 'https://play.example.com' });
    t.after(() => framed.close());
    let h = (await rawRequest(framed.origin + '/')).headers;
    assert.match(h['content-security-policy'], /frame-ancestors https:\/\/itch\.io https:\/\/\*\.itch\.io$/);
    assert.equal(h['x-frame-options'], undefined);
    assert.equal(h['strict-transport-security'], 'max-age=31536000');

    const custom = await startServer({ CSP: "default-src 'self' https://cdn.example.com", CSP_REPORT_ONLY: '1' });
    t.after(() => custom.close());
    h = (await rawRequest(custom.origin + '/')).headers;
    assert.equal(h['content-security-policy-report-only'], "default-src 'self' https://cdn.example.com");
    assert.equal(h['content-security-policy'], undefined);
  });

  test('inline script hashing matches what a browser hashes', () => {
    const html = '<script src="a.js"></script>\r\n<script>\r\nlet a = 1;\r\n</script><script type="module">import "./x.js";</script><script></script>';
    const expected = [
      "'sha256-" + crypto.createHash('sha256').update('\nlet a = 1;\n').digest('base64') + "'", // CRLF -> LF
      "'sha256-" + crypto.createHash('sha256').update('import "./x.js";').digest('base64') + "'",
    ];
    assert.deepEqual(inlineScriptHashes(html), expected);
  });
});

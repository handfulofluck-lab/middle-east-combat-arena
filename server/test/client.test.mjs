// Client-side pieces owned by the online work, exercised headlessly:
//   client/src/net/net.js    resolveRelayUrl(), license attachment, and the
//                            project's own legacy net.js driver (tools/test_net.py)
//   client/src/game/store.js purchase / redeem / gate logic against a fake DOM
//   client/src/styles/store.css  design-token discipline
// (The same modules are also verified in a real browser; see docs/ONLINE.md.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { describe, test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NET_FILE = path.join(REPO, 'client', 'src', 'net', 'net.js');
const STORE_FILE = path.join(REPO, 'client', 'src', 'game', 'store.js');
const NET_URL = new URL('../../client/src/net/net.js', import.meta.url).href;
const STORE_URL = new URL('../../client/src/game/store.js', import.meta.url).href;
const GOOD_TOKEN = 'MCA1.' + 'eyJ2IjoxLCJsaWQiOiJsaWNfYWJjIn0' + '.' + 'A'.repeat(86);

// store.js imports its stylesheet (a bundler concern); let Node treat *.css as empty
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, context, nextLoad) {'
  + ' if (url.split("?")[0].endsWith(".css")) return { format: "module", shortCircuit: true, source: "" };'
  + ' return nextLoad(url, context); }',
));

let instance = 0;
const fresh = (url) => import(url + '?instance=' + (++instance));

// Temporarily install browser-ish globals; always restored.
async function withGlobals(globals, fn) {
  const saved = {};
  for (const k of Object.keys(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: globals[k], configurable: true, writable: true });
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(globals)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k];
    }
  }
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    map,
  };
}

describe('net.js: default relay URL', () => {
  const loc = (href) => { const u = new URL(href); return { protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port }; };

  test('exports are intact and safe without any browser global', async () => {
    const mod = await fresh(NET_URL);
    assert.deepEqual(Object.keys(mod).sort(), ['DEFAULT_RELAY_URL', 'Net', 'resolveRelayUrl']);
    assert.equal(mod.DEFAULT_RELAY_URL, 'ws://127.0.0.1:8790');
    assert.equal(mod.resolveRelayUrl(), 'ws://127.0.0.1:8790');
    assert.equal(mod.Net.url, 'ws://127.0.0.1:8790');
    for (const fn of ['init', 'status', 'host', 'join', 'leave', 'sendSlot', 'lobbySlots', 'broadcastLobby', 'sendCfg', 'sendStart',
      'sendPause', 'sendChat', 'sendGame', 'sendDrop', 'sendLog', 'requestLog', 'netTick']) {
      assert.equal(typeof mod.Net[fn], 'function', 'Net.' + fn);
    }
  });

  test('resolution order: config.relayUrl, then same origin (/ws), then the local relay', async () => {
    const { resolveRelayUrl } = await fresh(NET_URL);
    const cases = [
      // [MCA_CONFIG, location, expected]
      [{ relayUrl: 'wss://relay.example.com/ws' }, loc('https://play.example.com/'), 'wss://relay.example.com/ws'],
      [{ relayUrl: '  wss://relay.example.com  ' }, undefined, 'wss://relay.example.com'],
      [{ relayUrl: '' }, loc('https://play.example.com/game/'), 'wss://play.example.com/ws'],
      [undefined, loc('https://play.example.com:8443/'), 'wss://play.example.com:8443/ws'],
      [undefined, loc('http://192.168.1.20:8790/'), 'ws://192.168.1.20:8790/ws'],
      [undefined, loc('http://localhost:8790/'), 'ws://localhost:8790/ws'],
      [{ relayUrl: 42 }, loc('http://mca.local/'), 'ws://mca.local/ws'],
      // Vite dev / preview servers have no relay behind them
      [undefined, loc('http://127.0.0.1:5173/'), 'ws://127.0.0.1:8790'],
      [undefined, loc('http://localhost:5180/'), 'ws://127.0.0.1:8790'],
      [undefined, loc('http://127.0.0.1:4173/'), 'ws://127.0.0.1:8790'],
      // not http(s): a file opened from disk, an app wrapper
      [undefined, { protocol: 'file:', host: '', hostname: '', port: '' }, 'ws://127.0.0.1:8790'],
      [{}, { protocol: 'app:', host: 'mca', hostname: 'mca', port: '' }, 'ws://127.0.0.1:8790'],
      [null, null, 'ws://127.0.0.1:8790'],
    ];
    for (const [cfg, location, expected] of cases) {
      const got = await withGlobals({ MCA_CONFIG: cfg, location }, () => resolveRelayUrl());
      assert.equal(got, expected, JSON.stringify([cfg, location]));
    }
    // the classic `window.X` spelling works too, and hostile globals cannot make it throw
    assert.equal(await withGlobals({ window: { MCA_CONFIG: { relayUrl: 'wss://w.example/ws' } } }, () => resolveRelayUrl()), 'wss://w.example/ws');
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
    assert.equal(await withGlobals({ MCA_CONFIG: hostile, location: hostile }, () => resolveRelayUrl()), 'ws://127.0.0.1:8790');
  });

  test('the license rides on create/join only towards the configured relay; envelopes are otherwise unchanged', async () => {
    const sockets = [];
    class FakeSocket {
      constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); queueMicrotask(() => this.onopen && this.onopen()); }
      send(raw) { this.sent.push(JSON.parse(raw)); }
      close() { this.readyState = 3; }
    }
    const run = async (globals, action) => {
      sockets.length = 0;
      return withGlobals({ WebSocket: FakeSocket, ...globals }, async () => {
        const { Net } = await fresh(NET_URL);
        Net.init({}, {});
        action(Net);
        await new Promise((r) => setImmediate(r));
        return { url: sockets[0].url, sent: sockets[0].sent[0] };
      });
    };
    const home = { MCA_CONFIG: { relayUrl: 'wss://relay.example.com/ws' } };
    const stored = { localStorage: memoryStorage({ 'mca.license': GOOD_TOKEN }) };

    // no license stored: byte-for-byte the old envelopes
    assert.deepEqual(await run(home, (n) => { n.host({ name: 'Ann' }); }), { url: 'wss://relay.example.com/ws', sent: { t: 'create', name: 'Ann' } });
    assert.deepEqual(await run(home, (n) => { n.join('', 'ab12', 'Bob'); }), { url: 'wss://relay.example.com/ws', sent: { t: 'join', code: 'AB12', name: 'Bob' } });
    assert.deepEqual(await run({}, (n) => { n.host(); }), { url: 'ws://127.0.0.1:8790', sent: { t: 'create', name: 'Host' } });

    // license stored + configured relay (default, or the same host typed by hand)
    assert.deepEqual((await run({ ...home, ...stored }, (n) => { n.host({ name: 'Ann' }); })).sent, { t: 'create', name: 'Ann', license: GOOD_TOKEN });
    assert.deepEqual((await run({ ...home, ...stored }, (n) => { n.join(undefined, 'ab12', 'Bob'); })).sent, { t: 'join', code: 'AB12', name: 'Bob', license: GOOD_TOKEN });
    assert.equal((await run({ ...home, ...stored }, (n) => { n.host({ url: 'wss://relay.example.com', name: 'Ann' }); })).sent.license, GOOD_TOKEN);
    assert.equal((await run({ ...stored, location: { protocol: 'https:', host: 'play.example.com', port: '' } }, (n) => { n.join(null, 'ab12', 'Bob'); })).sent.license, GOOD_TOKEN);

    // a bearer token never goes to some other relay
    for (const url of ['wss://evil.example/ws', 'ws://relay.example.com/ws', 'wss://relay.example.com.evil.example/ws', 'wss://relay.example.com:444/ws']) {
      const r = await run({ ...home, ...stored }, (n) => { n.host({ url, name: 'Ann' }); });
      assert.deepEqual(r.sent, { t: 'create', name: 'Ann' }, url);
      const j = await run({ ...home, ...stored }, (n) => { n.join(url, 'ab12', 'Bob'); });
      assert.deepEqual(j.sent, { t: 'join', code: 'AB12', name: 'Bob' }, url);
    }
    // a storage that throws (blocked cookies, sandboxed iframe) is survivable
    const broken = { getItem() { throw new Error('SecurityError'); } };
    assert.deepEqual((await run({ ...home, localStorage: broken }, (n) => { n.host({ name: 'Ann' }); })).sent, { t: 'create', name: 'Ann' });
  });

  test('legacy harness: the unmodified tools/test_net.py driver passes against the changed net.js', async (t) => {
    const legacy = path.join(REPO, 'tools', 'test_net.py');
    if (!fs.existsSync(legacy)) { t.skip('tools/test_net.py is not in this checkout'); return; }
    const py = fs.readFileSync(legacy, 'utf8');
    const m = /DRIVER = r"""([\s\S]*?)"""/.exec(py);
    assert.ok(m, 'driver block found');
    // the same "inline" transform the Python harness applies before eval
    const src = fs.readFileSync(NET_FILE, 'utf8')
      .replace(/import\s+[\s\S]*?\sfrom\s*'[^']*';/g, '')
      .replace(/^export\s+(async function|function|const|let)/gm, '$1')
      .replace(/^export\s*\{[\s\S]*?\};/gm, '');
    const ctx = vm.createContext({}); // a bare JS realm: no window, no WebSocket, no URL
    vm.runInContext(src, ctx, { filename: 'net.js (inlined)' });
    vm.runInContext(m[1], ctx, { filename: 'test_net.py DRIVER' });
    vm.runInContext('runPart1();', ctx);
    await new Promise((r) => setImmediate(r)); // promise callbacks flush between the two parts
    vm.runInContext('runPart2();', ctx);
    const results = JSON.parse(vm.runInContext('JSON.stringify(results)', ctx));
    assert.ok(results.length >= 20, 'ran ' + results.length + ' legacy checks');
    const failed = results.filter((r) => !r.pass);
    assert.deepEqual(failed, [], 'legacy net.js checks failed: ' + JSON.stringify(failed));
    t.diagnostic(results.length + '/' + results.length + ' legacy net.js checks passed');
  });
});

// ---- a DOM small enough to read, big enough for store.js --------------------
function fakeDocument() {
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {};
      this.textContent = ''; this.value = ''; this.disabled = false; this.id = ''; this.type = '';
      const set = new Set();
      this.classList = {
        add: (...c) => c.forEach((x) => set.add(x)),
        remove: (...c) => c.forEach((x) => set.delete(x)),
        contains: (c) => set.has(c),
        toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
        _set: set,
      };
    }
    get className() { return [...this.classList._set].join(' '); }
    set className(v) { this.classList._set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => this.classList._set.add(x)); }
    get firstChild() { return this.children[0] || null; }
    appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
    removeChild(n) { this.children = this.children.filter((c) => c !== n); n.parentNode = null; return n; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    emit(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ type, target: this, stopPropagation() {}, preventDefault() {}, ...extra }); }
    click() { if (!this.disabled) this.emit('click'); }
    focus() { doc.activeElement = this; }
    select() {}
  }
  const body = new El('body');
  const doc = {
    body,
    activeElement: null,
    createElement: (tag) => new El(tag),
    getElementById: (id) => { const walk = (n) => (n.id === id ? n : n.children.map(walk).find(Boolean)); return walk(body) || null; },
  };
  const find = (cls, from = body) => { const walk = (n) => (n.classList.contains(cls) ? n : n.children.map(walk).find(Boolean)); return walk(from) || null; };
  const text = (n) => n.textContent + n.children.map(text).join(' ');
  const shown = (n) => { for (let p = n; p; p = p.parentNode) if (p.classList.contains('store-hidden')) return false; return true; };
  return { doc, El, find, text, shown };
}

// A scripted server: answers(url, init) -> [status, json]
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers || {} });
    const [status, data] = answers(url, init, calls.length);
    if (status === 0) throw new TypeError('network down');
    return { status, json: async () => { if (data === undefined) throw new Error('no body'); return data; } };
  };
  fn.calls = calls;
  return fn;
}

async function storeEnv({ config = {}, search = '', license = null, answers = () => [404, {}], withDom = true } = {}) {
  const dom = fakeDocument();
  const root = dom.doc.createElement('div');
  root.id = 'store-root';
  dom.doc.body.appendChild(root);
  const localStorage = memoryStorage(license ? { 'mca.license': license } : {});
  const sessionStorage = memoryStorage();
  const history = { state: null, replaced: [], replaceState(state, title, url) { this.replaced.push(url); } };
  const location = { search, pathname: '/', hash: '', assigned: [], assign(u) { this.assigned.push(u); } };
  const fetch = fakeFetch(answers);
  const keys = {};
  const window = { addEventListener: (t, fn) => { keys[t] = fn; }, removeEventListener: (t) => { delete keys[t]; } };
  const globals = { MCA_CONFIG: config, localStorage, sessionStorage, history, location, fetch, window };
  if (withDom) globals.document = dom.doc;
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return { dom, globals, localStorage, sessionStorage, history, location, fetch, keys, settle, root };
}

describe('store.js', () => {
  test('imports only its own stylesheet; never throws without a browser', async () => {
    const src = fs.readFileSync(STORE_FILE, 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[^;]*;/gm)].map((m) => m[0].trim());
    assert.deepEqual(imports, ["import '../styles/store.css';"]);
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(src), 'DOM is built with createElement/textContent only');

    const mod = await fresh(STORE_URL);
    assert.deepEqual(Object.keys(mod).sort(), ['closeStore', 'getLicense', 'hasPass', 'initStore', 'openStore']);
    const game = {};
    assert.equal(mod.initStore(game), false);          // no document: nothing to build
    assert.equal(typeof game.openStore, 'function');   // ...but the hook exists and is harmless
    assert.equal(game.openStore(), false);
    assert.equal(mod.getLicense(), null);
    assert.equal(mod.hasPass(), false);
    assert.doesNotThrow(() => { mod.initStore(); mod.initStore(null); mod.openStore(); mod.closeStore(); });
    // hostile environment: storage that throws, a document that cannot build
    await withGlobals({ localStorage: { getItem() { throw new Error('denied'); } }, document: {} }, async () => {
      const m2 = await fresh(STORE_URL);
      assert.equal(m2.initStore({}), false);
      assert.equal(m2.hasPass(), false);
    });
  });

  test('getLicense() only returns well-formed tokens', async () => {
    for (const [stored, expected] of [[GOOD_TOKEN, GOOD_TOKEN], ['garbage', null], ['', null], ['MCA1.a.b', null], ['MCA2.' + GOOD_TOKEN.slice(5), null], [GOOD_TOKEN + '<script>', null]]) {
      await withGlobals({ localStorage: memoryStorage({ 'mca.license': stored }) }, async () => {
        const mod = await fresh(STORE_URL);
        assert.equal(mod.getLicense(), expected, stored.slice(0, 20));
        assert.equal(mod.hasPass(), expected !== null);
      });
    }
  });

  test('store disabled: says so plainly, Buy is dead, nothing is fetched', async () => {
    const env = await storeEnv({ config: { storeEnabled: false, redeemEnabled: false, paywall: 'off', product: { name: 'Founder\'s Pass', priceLabel: '' } } });
    await withGlobals(env.globals, async () => {
      const mod = await fresh(STORE_URL);
      const game = {};
      assert.equal(mod.initStore(game), true);
      const { find, text, shown } = env.dom;
      const rootEl = find('store-root', env.root);
      assert.ok(rootEl, 'DOM injected into #store-root');
      assert.equal(shown(rootEl), false, 'hidden until opened');
      assert.equal(game.openStore(), true);
      assert.equal(shown(rootEl), true);
      assert.equal(find('store-panel').attrs.role, 'dialog');
      assert.match(text(find('store-notice')), /Purchases are not available in this build/);
      assert.equal(shown(find('store-notice')), true);
      const buy = find('store-btn-primary');
      assert.equal(buy.disabled, true);
      assert.equal(buy.textContent, 'Unavailable');
      buy.emit('click'); // even a forced click does nothing
      assert.match(text(find('store-includes')), /unlocks nothing extra/);
      assert.equal(find('store-input').disabled, true);
      await env.settle();
      assert.deepEqual(env.fetch.calls, []);
      assert.deepEqual(env.location.assigned, []);
      // Escape (delivered to the window, wherever the focus is) closes it
      env.keys.keydown({ type: 'keydown', key: 'Escape', stopPropagation() {}, preventDefault() {} });
      assert.equal(shown(rootEl), false);
      assert.equal(env.keys.keydown, undefined, 'key capture is released when the modal closes');
    });
  });

  test('buying: POST /api/checkout, then a redirect -- but only to a safe https URL', async () => {
    const cfg = { storeEnabled: true, redeemEnabled: true, paywall: 'multiplayer', apiBase: 'https://api.example.com/', product: { name: 'Founder\'s Pass', priceLabel: '$9.99' } };
    let reply = [200, { url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }];
    const env = await storeEnv({ config: cfg, answers: () => reply });
    await withGlobals(env.globals, async () => {
      const mod = await fresh(STORE_URL);
      mod.initStore({});
      mod.openStore();
      const { find, text } = env.dom;
      const buy = find('store-btn-primary');
      assert.equal(buy.disabled, false);
      assert.equal(buy.textContent, 'Buy — $9.99');
      assert.equal(env.dom.shown(find('store-notice')), false);
      assert.match(text(find('store-includes')), /Online multiplayer on this server/);
      buy.click();
      await env.settle();
      assert.deepEqual(env.fetch.calls.map((c) => [c.method, c.url, c.body]), [['POST', 'https://api.example.com/api/checkout', {}]]);
      assert.deepEqual(env.location.assigned, ['https://checkout.stripe.com/c/pay/cs_test_abc']);

      for (const bad of ['javascript:alert(1)', 'http://evil.example/pay', 'data:text/html,x', '//evil.example', '', 42]) {
        reply = [200, { url: bad }];
        buy.click();
        await env.settle();
        assert.equal(env.location.assigned.length, 1, 'refused to navigate to ' + bad);
        assert.match(find('store-status').textContent, /could not be started/);
      }
      for (const [status, expected] of [[503, /not available on this server/], [429, /Too many attempts/], [0, /could not be reached/], [502, /could not be started/]]) {
        reply = [status, { error: 'x' }];
        buy.click();
        await env.settle();
        assert.match(find('store-status').textContent, expected);
        assert.equal(env.location.assigned.length, 1);
      }
    });
  });

  test('returning from Checkout: claim, store the key, clean the URL', async () => {
    const env = await storeEnv({
      config: { storeEnabled: true, redeemEnabled: true, paywall: 'off', product: { name: 'Founder\'s Pass', priceLabel: '$9.99' } },
      search: '?session_id=cs_test_abc12345&utm=x',
      answers: (url) => (url.includes('/api/license/claim') ? [200, { ok: true, token: GOOD_TOKEN, license: { id: 'lic_abc' } }] : [200, { valid: true }]),
    });
    await withGlobals(env.globals, async () => {
      const mod = await fresh(STORE_URL);
      mod.initStore({});
      assert.deepEqual(env.history.replaced, ['/?utm=x'], 'session id leaves the address bar immediately, other params stay');
      await env.settle();
      assert.equal(env.fetch.calls[0].url, '/api/license/claim?session_id=cs_test_abc12345');
      assert.equal(env.localStorage.getItem('mca.license'), GOOD_TOKEN);
      assert.equal(mod.getLicense(), GOOD_TOKEN);
      assert.equal(mod.hasPass(), true);
      const { find, shown } = env.dom;
      assert.equal(shown(find('store-root', env.root)), true, 'the modal opens to confirm the purchase');
      assert.match(find('store-status').textContent, /Thank you!/);
      assert.equal(find('store-key').value, GOOD_TOKEN);
      assert.equal(find('store-btn-primary').textContent, 'Pass active');
      assert.equal(find('store-btn-primary').disabled, true);
      assert.equal(env.sessionStorage.getItem('mca.pendingSession'), null);
    });
  });

  test('payment still settling: retried, then "Check again" finishes the claim later', async () => {
    let paid = false;
    const env = await storeEnv({
      config: { storeEnabled: true, redeemEnabled: true },
      search: '?session_id=cs_test_slowpay00',
      answers: (url) => (url.includes('/claim') ? (paid ? [200, { ok: true, token: GOOD_TOKEN }] : [402, { error: 'payment-not-completed' }]) : [200, { valid: true }]),
    });
    const realSetTimeout = globalThis.setTimeout;
    await withGlobals({ ...env.globals, setTimeout: (fn) => realSetTimeout(fn, 0) }, async () => {
      const mod = await fresh(STORE_URL);
      mod.initStore({});
      const { find, shown } = env.dom;
      const claims = () => env.fetch.calls.filter((c) => c.url.includes('/claim')).length;
      for (let i = 0; i < 200 && !/has not completed yet/.test(find('store-status').textContent); i++) await env.settle();
      assert.equal(claims(), 5, 'one try + four retries while the payment settles');
      assert.equal(mod.hasPass(), false);
      assert.match(find('store-status').textContent, /has not completed yet/);
      const retry = find('store-btn-quiet');
      assert.equal(retry.textContent, 'Check again');
      assert.equal(shown(retry), true);
      assert.equal(env.sessionStorage.getItem('mca.pendingSession'), 'cs_test_slowpay00');
      paid = true;
      retry.click();
      await env.settle();
      assert.equal(mod.getLicense(), GOOD_TOKEN);
      assert.equal(shown(retry), false);
      assert.equal(env.sessionStorage.getItem('mca.pendingSession'), null);
    });
  });

  test('checkout return edge cases: refunded, unknown, malformed, cancelled, offline', async () => {
    const scenario = async (search, reply, check) => {
      const env = await storeEnv({ config: { storeEnabled: true }, search, answers: () => reply });
      await withGlobals(env.globals, async () => {
        const mod = await fresh(STORE_URL);
        mod.initStore({});
        await env.settle();
        assert.equal(mod.hasPass(), false, search);
        assert.equal(env.history.replaced.length, 1, 'URL cleaned for ' + search);
        check(env, env.dom.find('store-status').textContent);
      });
    };
    await scenario('?session_id=cs_test_refunded0', [410, { error: 'license-revoked' }], (env, s) => assert.match(s, /refunded or disputed/));
    await scenario('?session_id=cs_test_unknown00', [404, { error: 'unknown-session' }], (env, s) => assert.match(s, /could not be found/));
    await scenario('?session_id=cs_test_offline00', [0], (env, s) => { assert.match(s, /could not be reached/); assert.equal(env.sessionStorage.getItem('mca.pendingSession'), 'cs_test_offline00'); });
    await scenario('?session_id=<script>alert(1)</script>', [200, { token: GOOD_TOKEN }], (env, s) => { assert.match(s, /could not be found/); assert.deepEqual(env.fetch.calls, [], 'a malformed id is never sent anywhere'); });
    await scenario('?checkout=cancelled', [200, {}], (env, s) => { assert.match(s, /cancelled\. You have not been charged/); assert.deepEqual(env.fetch.calls, []); });
    // a "token" that is not a token is not stored, whatever the status says
    await scenario('?session_id=cs_test_weird0000', [200, { ok: true, token: '<img src=x onerror=alert(1)>' }], (env, s) => assert.match(s, /could not be confirmed/));
  });

  test('redeeming a key: checked by the server first, stored only when valid', async () => {
    let reply = [200, { valid: false, reason: 'bad-signature' }];
    const env = await storeEnv({ config: { storeEnabled: false, redeemEnabled: true, paywall: 'multiplayer' }, answers: () => reply });
    await withGlobals(env.globals, async () => {
      const mod = await fresh(STORE_URL);
      mod.initStore({});
      mod.openStore();
      const { find } = env.dom;
      const input = find('store-input');
      const redeem = find('store-row').children[1];
      const status = () => find('store-status').textContent;
      assert.equal(input.disabled, false, 'redeeming works even where nothing can be bought');

      redeem.click();
      assert.match(status(), /Paste your license key/);
      input.value = 'definitely not a key';
      redeem.click();
      await env.settle();
      assert.match(status(), /does not look like a valid license key/);
      assert.deepEqual(env.fetch.calls, [], 'malformed input is rejected locally');

      input.value = '  ' + GOOD_TOKEN + '\n';
      redeem.click();
      await env.settle();
      assert.deepEqual(env.fetch.calls.map((c) => [c.method, c.url, c.body]), [['POST', '/api/license/verify', { token: GOOD_TOKEN }]]);
      assert.match(status(), /not valid for this server/);
      assert.equal(mod.hasPass(), false);

      for (const [r, expected] of [[[200, { valid: false, reason: 'revoked' }], /revoked/], [[503, { error: 'licensing-disabled' }], /not enabled on this server/],
        [[0], /could not be reached.*Nothing was stored/], [[500, {}], /Nothing was stored/]]) {
        reply = r;
        redeem.click();
        await env.settle();
        assert.match(status(), expected);
        assert.equal(mod.hasPass(), false);
      }

      reply = [200, { valid: true, license: { id: 'lic_abc' } }];
      env.keys.keydown({ type: 'keydown', key: 'Enter', target: input, stopPropagation() {}, preventDefault() {} }); // Enter in the field
      await env.settle();
      assert.equal(mod.getLicense(), GOOD_TOKEN);
      assert.match(status(), /Key accepted/);
      assert.equal(input.value, '');
      assert.equal(env.dom.doc.activeElement, find('store-panel'), 'focus stays inside the modal when the redeem field disappears');

      // remove it again
      find('store-key-actions').children[1].click();
      assert.equal(mod.hasPass(), false);
      assert.equal(env.localStorage.getItem('mca.license'), null);
    });
  });

  test('a stored key the server now rejects (refund) is dropped on load; an unreachable server changes nothing', async () => {
    const revoked = await storeEnv({ config: { redeemEnabled: true }, license: GOOD_TOKEN, answers: () => [200, { valid: false, reason: 'revoked' }] });
    await withGlobals(revoked.globals, async () => {
      const mod = await fresh(STORE_URL);
      assert.equal(mod.hasPass(), true);
      mod.initStore({});
      await revoked.settle();
      assert.equal(mod.hasPass(), false);
      mod.openStore();
      assert.match(revoked.dom.find('store-status').textContent, /no longer valid and was removed/);
    });
    for (const reply of [[0], [503, { error: 'licensing-disabled' }], [500, {}], [200, { valid: true }]]) {
      const env = await storeEnv({ config: { redeemEnabled: true }, license: GOOD_TOKEN, answers: () => reply });
      await withGlobals(env.globals, async () => {
        const mod = await fresh(STORE_URL);
        mod.initStore({});
        await env.settle();
        assert.equal(mod.getLicense(), GOOD_TOKEN, 'kept after ' + JSON.stringify(reply));
      });
    }
  });

  test('MCA_PAYWALL=full: a gate that cannot be dismissed until a key is redeemed', async () => {
    const env = await storeEnv({ config: { storeEnabled: false, redeemEnabled: true, paywall: 'full' }, answers: () => [200, { valid: true }] });
    await withGlobals(env.globals, async () => {
      const mod = await fresh(STORE_URL);
      mod.initStore({});
      const { find, shown, text } = env.dom;
      const rootEl = find('store-root', env.root);
      assert.equal(shown(rootEl), true, 'shown on load');
      assert.equal(rootEl.classList.contains('store-gate'), true);
      assert.match(text(find('store-lede')), /requires the Founder's Pass to play/);
      mod.closeStore();
      find('store-backdrop').click();
      find('store-close').click();
      env.keys.keydown({ type: 'keydown', key: 'Escape', stopPropagation() {}, preventDefault() {} });
      assert.equal(shown(rootEl), true, 'cannot be closed');

      find('store-input').value = GOOD_TOKEN;
      find('store-row').children[1].click();
      await env.settle();
      assert.equal(mod.hasPass(), true);
      assert.equal(rootEl.classList.contains('store-gate'), false);
      mod.closeStore();
      assert.equal(shown(rootEl), false, 'closes once the pass is active');
    });
    // with a pass already stored there is no gate at all
    const owned = await storeEnv({ config: { paywall: 'full', redeemEnabled: true }, license: GOOD_TOKEN, answers: () => [200, { valid: true }] });
    await withGlobals(owned.globals, async () => {
      const mod = await fresh(STORE_URL);
      mod.initStore({});
      assert.equal(owned.dom.shown(owned.dom.find('store-root', owned.root)), false);
    });
  });
});

describe('store.css', () => {
  const css = fs.readFileSync(path.join(REPO, 'client', 'src', 'styles', 'store.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = fs.readFileSync(path.join(REPO, 'client', 'src', 'styles', 'tokens.css'), 'utf8');

  test('colours come only from design tokens', () => {
    assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g) || [], []);
    const named = /:\s*(?:white|black|red|green|blue|gold|gray|grey|orange|yellow|silver)\b/gi;
    assert.deepEqual(css.match(named) || [], []);
  });

  test('every variable it uses exists in tokens.css; it defines none of its own', () => {
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    assert.ok(used.size >= 15, 'uses the token set (' + used.size + ' variables)');
    for (const v of used) assert.ok(defined.has(v), v + ' is not defined in tokens.css');
    assert.deepEqual([...css.matchAll(/(?:^|[{;\s])(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]), []);
    assert.ok(used.has('--font-display') && used.has('--gold') && used.has('--glass-strong') && used.has('--z-modal'));
  });

  test('all class names are prefixed store-; all class names used by store.js are styled or stateful', () => {
    const classes = new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]).filter((c) => !/^\d/.test(c)));
    for (const c of classes) assert.ok(c.startsWith('store-'), 'unprefixed class .' + c);
    const js = fs.readFileSync(STORE_FILE, 'utf8');
    const usedInJs = new Set([...js.matchAll(/'([^']*store-[^']*)'/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => /^store-[\w-]+$/.test(c)));
    for (const c of usedInJs) {
      if (c === 'store-title' || c === 'store-root' || c === 'store-col') continue; // an id / the host id / layout-only wrapper
      if (c.endsWith('-')) continue; // a prefix completed at runtime (store-status-<kind>), checked below
      assert.ok(classes.has(c), 'store.js uses .' + c + ' but store.css does not define it');
    }
    for (const kind of ['ok', 'warn', 'error', 'busy']) assert.ok(classes.has('store-status-' + kind), 'missing .store-status-' + kind);
    assert.ok(usedInJs.size >= 25, 'found the class names in store.js (' + usedInJs.size + ')');
    assert.match(css, /@keyframes store-/);
    assert.ok(![...css.matchAll(/@keyframes\s+([\w-]+)/g)].some((m) => !m[1].startsWith('store-')));
  });
});

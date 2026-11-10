// Deployment artefacts and documentation must stay in step with the code:
// Dockerfile, render.yaml, fly.toml, the GitHub workflows, the static-config
// tool, and the environment-variable reference in docs/ONLINE.md.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { buildConfig, parseServerConfig, renderConfig } from '../static-config.mjs';
import { http, makeTempDir, startServer, TEST_SECRETS } from './helpers/harness.mjs';

const run = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const TOOL = path.join(REPO, 'server', 'static-config.mjs');

// every environment variable server/config.js reads
function configEnvVars() {
  const src = read('server/config.js');
  const names = new Set();
  for (const m of src.matchAll(/(?:str\(env, |flag\(env, |int\()'([A-Z][A-Z0-9_]+)'/g)) names.add(m[1]);
  for (const m of src.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
  return names;
}

const evalConfig = (source) => {
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.MCA_CONFIG));
};

describe('static-config tool (config.js for statically hosted clients)', () => {
  test('--server mirrors a live server and points relay + API at it', async (t) => {
    const srv = await startServer({ LICENSE_SECRET: TEST_SECRETS.LICENSE_SECRET, MCA_PAYWALL: 'multiplayer', PRICE_LABEL: '€12', PRODUCT_NAME: 'Founder </script> Pass' });
    t.after(() => srv.close());
    const dir = makeTempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'nested', 'config.js');
    const { stdout } = await run(process.execPath, [TOOL, out, '--server', srv.origin]);
    assert.match(stdout, /wrote /);
    const source = fs.readFileSync(out, 'utf8');
    assert.ok(!source.includes('</script>'));
    assert.ok(!/[<>&]/.test(source.split('\n').filter((line) => !line.startsWith('//')).join('\n')), 'no raw <, > or & in the generated script');
    const cfg = evalConfig(source);
    const live = parseServerConfig((await http(srv.origin + '/config.js')).text);
    assert.deepEqual(cfg, {
      ...live,
      relayUrl: 'ws://127.0.0.1:' + srv.port + '/ws',
      apiBase: srv.origin,
    });
    assert.equal(cfg.paywall, 'multiplayer');
    assert.equal(cfg.redeemEnabled, true);
    assert.equal(cfg.storeEnabled, false);
    assert.deepEqual(cfg.product, { name: 'Founder </script> Pass', priceLabel: '€12' });
    // same keys as the static fallback the client ships
    for (const key of Object.keys(evalConfig(read('client/public/config.js')))) assert.ok(key in cfg, key);
  });

  test('relay-only and explicit flags; a store without a server is refused', async (t) => {
    assert.deepEqual(await buildConfig({ relay: 'wss://relay.example.com/ws' }), {
      relayUrl: 'wss://relay.example.com/ws', apiBase: '', paywall: 'off', storeEnabled: false, redeemEnabled: false,
      product: { name: "Founder's Pass", priceLabel: '' },
    });
    const full = await buildConfig({ relay: 'wss://r.example.com/ws', api: 'https://api.example.com/x', paywall: 'multiplayer', storeEnabled: true, redeemEnabled: true, productName: 'Pass', priceLabel: '$5' });
    assert.deepEqual(full, { relayUrl: 'wss://r.example.com/ws', apiBase: 'https://api.example.com', paywall: 'multiplayer', storeEnabled: true, redeemEnabled: true, product: { name: 'Pass', priceLabel: '$5' } });
    assert.deepEqual(evalConfig(renderConfig(full)), full);
    assert.throws(() => parseServerConfig('window.MCA_CONFIG = {}'), /not a server-generated/);

    const dir = makeTempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'config.js');
    for (const args of [['--store-enabled'], ['--paywall', 'multiplayer'], ['--paywall', 'bogus'], ['--relay', 'https://not-ws.example'],
      ['--server', 'ftp://x'], ['--bogus'], ['--relay'], []]) {
      const res = await run(process.execPath, args.length ? [TOOL, out, ...args] : [TOOL]).then(() => ({ code: 0 }), (e) => ({ code: e.code, stderr: e.stderr }));
      assert.equal(res.code, 1, args.join(' '));
      assert.match(res.stderr, /^static-config: /);
    }
    assert.equal(fs.existsSync(out), false, 'nothing is written on error');
    const dead = await run(process.execPath, [TOOL, out, '--server', 'http://127.0.0.1:9']).then(() => 0, (e) => e.code);
    assert.equal(dead, 1);
  });
});

describe('deployment files', () => {
  test('Dockerfile: multi-stage, locked installs, non-root, health check', () => {
    const d = read('Dockerfile');
    const stages = [...d.matchAll(/^FROM \$\{NODE_IMAGE\} AS (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(stages, ['build', 'deps', 'runtime']);
    assert.match(d, /^ARG NODE_IMAGE=node:22-/m);
    assert.match(d, /RUN npm ci --no-audit --no-fund\n/);
    assert.match(d, /RUN npm run build/);
    assert.match(d, /RUN npm ci --omit=dev/);
    const runtime = d.slice(d.indexOf('AS runtime'));
    assert.match(runtime, /^ARG RUNTIME_USER=node$/m, 'the default image is non-root');
    assert.match(runtime, /^USER \$\{RUNTIME_USER\}$/m);
    assert.match(runtime, /COPY --from=deps \/app\/node_modules/);
    assert.match(runtime, /COPY --from=build \/app\/dist\/web/);
    assert.match(runtime, /HEALTHCHECK[\s\S]*\/healthz/);
    assert.match(runtime, /EXPOSE 8790/);
    assert.match(runtime, /PORT=8790/);
    assert.match(runtime, /DATA_DIR=\/data/);
    assert.match(runtime, /CMD \["node", "server\/index\.js"\]/);
    assert.ok(!/npm install/.test(d), 'only reproducible installs');
    // no secrets baked in
    assert.ok(!/(LICENSE_SECRET|ADMIN_TOKEN|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)\s*=/.test(d));

    const entry = read('server/docker-entrypoint.sh');
    assert.match(entry, /^#!\/bin\/sh/);
    assert.match(entry, /exec setpriv --reuid=node --regid=node --init-groups "\$@"/);
    assert.match(entry, /\nexec "\$@"\n$/);
    assert.match(d, /ENTRYPOINT \["\/bin\/sh", "\/app\/server\/docker-entrypoint\.sh"\]/);

    const ignore = read('.dockerignore').split('\n').map((l) => l.trim());
    for (const entry2 of ['.git', 'node_modules', 'dist', 'data', '.env', '.env.*']) assert.ok(ignore.includes(entry2), '.dockerignore must exclude ' + entry2);
    assert.ok(!ignore.includes('server') && !ignore.includes('client') && !ignore.includes('package-lock.json'));
  });

  test('render.yaml and fly.toml agree with the server (port, health path, data dir, known variables)', () => {
    const known = configEnvVars();
    const render = read('render.yaml');
    assert.match(render, /runtime: docker/);
    assert.match(render, /healthCheckPath: \/healthz/);
    assert.match(render, /numInstances: 1\b/);
    assert.match(render, /mountPath: \/data/);
    const renderEnv = Object.fromEntries([...render.matchAll(/- key: ([A-Z_]+)\n\s+(value|sync|generateValue): ?("?)([^"\n#]*)\3/g)].map((m) => [m[1], { kind: m[2], value: m[4].trim() }]));
    const buildArgs = new Set([...read('Dockerfile').matchAll(/^ARG ([A-Z_]+)/gm)].map((m) => m[1]));
    for (const key of Object.keys(renderEnv)) assert.ok(known.has(key) || buildArgs.has(key), 'render.yaml sets an unknown variable ' + key);
    assert.equal(renderEnv.RUNTIME_USER.value, 'root');
    assert.equal(renderEnv.PORT.value, '8790');
    assert.equal(renderEnv.DATA_DIR.value, '/data');
    assert.equal(renderEnv.TRUST_PROXY.value, '1');
    assert.equal(renderEnv.MCA_PAYWALL.value, 'off');
    for (const secret of ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET']) assert.equal(renderEnv[secret].kind, 'sync', secret + ' must be entered in the dashboard, never committed');
    for (const secret of ['LICENSE_SECRET', 'ADMIN_TOKEN']) assert.equal(renderEnv[secret].kind, 'generateValue');

    const fly = read('fly.toml');
    assert.match(fly, /internal_port = 8790/);
    assert.match(fly, /path = "\/healthz"/);
    assert.match(fly, /destination = "\/data"/);
    assert.match(fly, /kill_signal = "SIGTERM"/);
    assert.match(fly, /min_machines_running = 1/);
    assert.match(fly, /auto_stop_machines = "off"/);
    assert.match(fly, /RUNTIME_USER = "root"/);
    const envBlock = /\[env\]\n([\s\S]*?)\n\n/.exec(fly)[1];
    const flyEnv = Object.fromEntries([...envBlock.matchAll(/^\s*([A-Z_]+) = "([^"]*)"/gm)].map((m) => [m[1], m[2]]));
    for (const key of Object.keys(flyEnv)) assert.ok(known.has(key), 'fly.toml sets an unknown variable ' + key);
    assert.equal(flyEnv.PORT, '8790');
    assert.equal(flyEnv.DATA_DIR, '/data');
    assert.equal(flyEnv.TRUST_PROXY, '1');
    assert.equal(flyEnv.CLIENT_IP_HEADER, 'fly-client-ip');
    for (const secret of ['LICENSE_SECRET', 'ADMIN_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
      assert.ok(!(secret in flyEnv), secret + ' must not be in fly.toml');
      assert.ok(!new RegExp('^\\s*' + secret + '\\s*=', 'm').test(fly));
    }
  });

  test('CI workflow: push + pull_request, Node 22 with npm cache, ci -> build -> test -> server tests', () => {
    const ci = read('.github/workflows/ci.yml');
    assert.match(ci, /^on:\n  push:\n  pull_request:\n/m);
    assert.match(ci, /uses: actions\/checkout@v4/);
    assert.match(ci, /uses: actions\/setup-node@v4\n\s+with:\n\s+node-version: 22\n\s+cache: npm/);
    const runs = [...ci.matchAll(/^\s+run: (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(runs, ['npm ci', 'npm run build', 'npm test', 'node --test server/test/']);
    assert.match(ci, /timeout-minutes: \d+/);
    assert.match(ci, /^permissions:\n  contents: read$/m);
    assert.ok(!/secrets\./.test(ci), 'CI needs no secrets');
    const pkg = JSON.parse(read('package.json'));
    for (const script of ['build', 'test', 'start']) assert.ok(pkg.scripts[script], 'package.json script "' + script + '" used by CI / Docker');
    assert.equal(pkg.scripts.start, 'node server/index.js');
    assert.ok(fs.existsSync(path.join(REPO, 'server', 'test', 'index.js')), 'entry for `node --test server/test/`');
  });

  test('Pages workflow: manual only, official actions, publishes dist/web', () => {
    const pages = read('.github/workflows/pages.yml');
    const on = /^on:\n([\s\S]*?)\n\S/m.exec(pages)[1];
    assert.deepEqual([...on.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]), ['workflow_dispatch'], 'never triggered by a push');
    for (const action of ['actions/checkout@v4', 'actions/setup-node@v4', 'actions/configure-pages@v5', 'actions/upload-pages-artifact@v3', 'actions/deploy-pages@v4']) {
      assert.ok(pages.includes('uses: ' + action), action);
    }
    assert.match(pages, /path: dist\/web/);
    assert.match(pages, /pages: write/);
    assert.match(pages, /id-token: write/);
    assert.match(pages, /environment:\n\s+name: github-pages/);
    // the user-supplied input reaches the shell through an env var, not by interpolation into the script
    assert.match(pages, /SERVER_URL: \$\{\{ inputs\.server_url \}\}/);
    assert.match(pages, /run: node server\/static-config\.mjs dist\/web\/config\.js --server "\$SERVER_URL"/);
    assert.ok(![...pages.matchAll(/^\s+run: (.+)$/gm)].some((m) => m[1].includes('${{')));
  });

  test('every file a deployment needs exists and the server entry runs with only node built-ins + ws', () => {
    for (const rel of ['Dockerfile', '.dockerignore', 'render.yaml', 'fly.toml', '.github/workflows/ci.yml', '.github/workflows/pages.yml',
      'docs/ONLINE.md', 'docs/MONETIZATION.md', 'server/index.js', 'server/docker-entrypoint.sh', 'server/static-config.mjs',
      'client/src/game/store.js', 'client/src/styles/store.css']) {
      assert.ok(fs.statSync(path.join(REPO, rel)).size > 0, rel);
    }
    const imports = new Set();
    for (const file of fs.readdirSync(path.join(REPO, 'server')).filter((f) => /\.m?js$/.test(f))) {
      for (const m of read('server/' + file).matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        if (!m[1].startsWith('.')) imports.add(m[1]);
      }
    }
    const external = [...imports].filter((i) => !i.startsWith('node:'));
    assert.deepEqual(external, ['ws'], 'runtime dependencies: ' + external.join(', '));
    assert.ok(JSON.parse(read('package.json')).dependencies.ws);
  });
});

describe('documentation matches the code', () => {
  const online = read('docs/ONLINE.md');
  const money = read('docs/MONETIZATION.md');

  test('docs/ONLINE.md documents every environment variable the server reads, with its real default', () => {
    const known = configEnvVars();
    assert.ok(known.size >= 35, 'found ' + known.size + ' variables in config.js');
    const documented = new Set([...online.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]));
    for (const name of known) assert.ok(documented.has(name), name + ' is read by server/config.js but missing from the tables in docs/ONLINE.md');
    for (const name of documented) assert.ok(known.has(name), 'docs/ONLINE.md documents ' + name + ', which the server does not read');

    const defaults = Object.fromEntries([...online.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| `([^`|]+)` \|/gm)].map((m) => [m[1], m[2]]));
    const limitName = { MAX_ROOMS: 'maxRooms', MAX_CONNECTIONS: 'maxConnections', MAX_CONNS_PER_IP: 'maxConnsPerIp', MAX_MSG_BYTES: 'maxMsgBytes',
      RATE_MSGS_PER_SEC: 'rateMsgsPerSec', RATE_BURST: 'rateBurst', RATE_BYTES_PER_SEC: 'rateBytesPerSec', RATE_BYTES_BURST: 'rateBytesBurst',
      MAX_BUFFERED_BYTES: 'maxBufferedBytes', HEARTBEAT_MS: 'heartbeatMs', ROOM_IDLE_MS: 'roomIdleMs', UNJOINED_TIMEOUT_MS: 'unjoinedTimeoutMs',
      JOIN_FAILS_PER_MIN: 'joinFailsPerMin', MAX_CONNS_PER_LICENSE: 'maxConnsPerLicense' };
    return import('../config.js').then(({ loadConfig }) => {
      const c = loadConfig({});
      for (const [env, key] of Object.entries(limitName)) assert.equal(defaults[env], String(c.limits[key]), 'documented default of ' + env);
      assert.equal(defaults.PORT, String(c.port));
      assert.equal(defaults.HOST, c.host);
      assert.equal(defaults.MCA_PAYWALL, c.paywall);
      assert.equal(defaults.PRODUCT_NAME, c.product.name);
      assert.equal(defaults.PRODUCT_ID, c.product.id);
      assert.equal(defaults.STRIPE_API_BASE, c.stripe.apiBase);
      assert.equal(defaults.LOG_LEVEL, c.logLevel);
    });
  });

  test('routes, error reasons and webhook events named in the docs exist in the code', () => {
    const api = read('server/api.js');
    const app = read('server/app.js');
    const relay = read('server/relay.js');
    for (const route of ['/api/rooms', '/api/stats', '/api/checkout', '/api/stripe/webhook', '/api/license/claim', '/api/license/verify', '/api/license/pubkey', '/api/admin/license']) {
      assert.ok(api.includes("'" + route + "'"), route + ' in api.js');
      assert.ok(money.includes(route) || online.includes(route), route + ' documented');
    }
    for (const route of ['/healthz', '/config.js']) assert.ok(app.includes("'" + route + "'") && online.includes(route), route);
    const reasons = /New\s+reasons:([\s\S]*?)\.\n/.exec(online)[1].match(/`([a-z-]+)`/g).map((s) => s.slice(1, -1));
    assert.ok(reasons.length >= 10);
    for (const reason of reasons) assert.ok(relay.includes("'" + reason + "'"), 'documented relay error "' + reason + '" exists');
    for (const event of ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed']) {
      assert.ok(api.includes("'" + event + "'"), event + ' handled');
      assert.ok(money.includes('`' + event + '`'), event + ' in the Stripe checklist');
    }
    for (const action of ['mint', 'revoke', 'reinstate', 'lookup', 'list']) {
      assert.ok(api.includes("case '" + action + "'") && money.includes('"action":"' + action + '"'), 'admin action ' + action);
    }
    for (const mode of ['off', 'multiplayer', 'full']) assert.ok(money.includes('| `' + mode + '`'), 'paywall mode ' + mode);
  });

  test('the documents are honest about what is unverified and what the owner must supply', () => {
    assert.match(money, /has ever talked to the real Stripe API/);
    assert.match(money, /Not verified/);
    assert.match(money, /legal or tax advice/);
    for (const topic of ['Terms of sale', 'Refund policy', 'Privacy policy', 'Tax']) assert.ok(money.includes('**' + topic), topic);
    assert.match(money, /cannot truly lock single-player/);
    assert.match(online, /Exactly one instance/);
  });
});

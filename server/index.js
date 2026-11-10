// MCA server entry point (npm start).
//   node server/index.js
// Configuration comes from the environment only; see docs/ONLINE.md for the
// full table. Nothing here needs configuring to run locally:
//   npm run build && npm start   ->   http://localhost:8790
import { ConfigError, createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';

const config = loadConfig(process.env);
const log = createLogger({ level: config.logLevel });

function fail(errors) {
  for (const message of errors) log.error('config.invalid', { message });
  process.stderr.write('\nMCA server did not start: invalid configuration.\n' + errors.map((e) => '  - ' + e).join('\n') + '\n');
  process.exit(1);
}

if (config.errors.length) fail(config.errors);

let app;
try {
  app = createApp(config, { log });
} catch (e) {
  if (e instanceof ConfigError) fail(e.errors);
  throw e;
}

for (const message of config.warnings) log.warn('config.warning', { message });

// Say exactly what is on and what is off, and why -- with no secret values.
log.info('boot', app.describe());
for (const feature of ['licensing', 'store', 'admin']) {
  if (!app.features[feature]) log.info('feature.off', { feature, why: app.featureReasons[feature] });
}

// An unexpected exception must not take every running match down with it:
// log it and keep serving. (Rooms live in this process's memory.)
process.on('uncaughtException', (err) => {
  log.error('uncaught.exception', { err: err && err.stack ? String(err.stack).slice(0, 2000) : String(err) });
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled.rejection', { err: err && err.stack ? String(err.stack).slice(0, 2000) : String(err) });
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info('shutdown.begin', { signal, ...app.relay.stats() });
  const hard = setTimeout(() => {
    log.warn('shutdown.forced', {});
    process.exit(1);
  }, 8000);
  hard.unref();
  try {
    await app.close('server-shutdown', 3000);
    log.info('shutdown.done', {});
    process.exit(0);
  } catch (e) {
    log.error('shutdown.error', { err: e });
    process.exit(1);
  }
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

app.listen().then((addr) => {
  log.info('listening', { host: addr.address, port: addr.port, url: 'http://localhost:' + addr.port });
}).catch((err) => {
  log.error('listen.failed', { code: err.code || 'error', message: err.message });
  process.stderr.write('\nMCA server could not listen on port ' + config.port + ': ' + err.message + '\n');
  process.exit(1);
});

// Structured one-line JSON logs. Every record is a single line on stdout:
//   {"ts":"2026-01-01T00:00:00.000Z","lvl":"info","evt":"room.create","room":"AB12"}
// Secrets never belong in a log line; as defence in depth any field whose key
// looks like a credential is redacted, and long strings are truncated.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SENSITIVE_KEY = /^(token|license|licence|secret|password|authorization|signature|key|cookie)$/i;
const MAX_STRING = 300;

function clean(value, depth) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return clean(value.message, depth);
  if (depth >= 3) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 30)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : clean(value[k], depth + 1);
    }
    return out;
  }
  return String(value);
}

export function createLogger(options = {}) {
  const level = options.level in LEVELS ? options.level : 'info';
  const min = LEVELS[level];
  const write = options.write || ((line) => { process.stdout.write(line + '\n'); });

  function emit(lvl, evt, fields) {
    if (LEVELS[lvl] < min) return;
    const rec = { ts: new Date().toISOString(), lvl, evt };
    if (fields && typeof fields === 'object') {
      for (const k of Object.keys(fields)) {
        if (k === 'ts' || k === 'lvl' || k === 'evt') continue;
        rec[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : clean(fields[k], 0);
      }
    }
    let line;
    try { line = JSON.stringify(rec); } catch (e) { line = JSON.stringify({ ts: rec.ts, lvl, evt, note: 'unserializable' }); }
    try { write(line); } catch (e) { /* a broken stdout must never take the server down */ }
  }

  return {
    level,
    debug: (evt, fields) => emit('debug', evt, fields),
    info: (evt, fields) => emit('info', evt, fields),
    warn: (evt, fields) => emit('warn', evt, fields),
    error: (evt, fields) => emit('error', evt, fields),
  };
}

export const silentLogger = createLogger({ level: 'silent' });

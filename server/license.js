// License tokens + the license ledger.
//
// Token:  MCA1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>
//   payload = { v:1, lid, prd, iat, src, eh? }
//     lid  license id ("lic_" + 96 random bits, hex)
//     prd  product id (PRODUCT_ID, e.g. "founders-pass")
//     iat  issued-at, unix seconds
//     src  "stripe" | "admin"
//     eh   keyed hash (HMAC-SHA256, truncated) of the buyer's e-mail, if
//          known. It is the only buyer-derived datum in a token and cannot be
//          reversed or dictionary-tested without LICENSE_SECRET.
//   The signature covers the ASCII bytes "MCA1.<payload>". Ed25519 signatures
//   are deterministic, so a token can always be re-derived from its ledger
//   record: tokens themselves are never written to disk or to logs.
//
// Keys: one env secret (LICENSE_SECRET) is stretched with HKDF-SHA256 into an
// Ed25519 seed plus independent HMAC keys. The public key can be published;
// only this server can mint.
//
// Verification is signature + product + "not revoked". It deliberately does
// NOT require the license to be present in the local ledger, so a token stays
// valid across instances and across a lost data directory. The price is that
// revocations live only in the ledger: DATA_DIR must be persistent storage.
//
// Ledger: DATA_DIR/licenses.jsonl, append-only JSON lines (issue / revoke /
// reinstate / block). Each record is written with a single write(2) on an
// O_APPEND descriptor and fsync'ed before the operation is acknowledged; the
// in-memory view is only updated after the record is durable. A torn final
// line (crash mid-write) is detected and skipped at boot.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_PREFIX = 'MCA1';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const HKDF_SALT = Buffer.from('mca-license-v1', 'utf8');
const LID_RE = /^lic_[0-9a-f]{24}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 1024;
const LEDGER_FILE = 'licenses.jsonl';

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hkdf(secret, info) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), HKDF_SALT, Buffer.from(info, 'utf8'), 32));
}

export function deriveKeys(secret) {
  const seed = hkdf(secret, 'ed25519-signing-key');
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    emailKey: hkdf(secret, 'email-hash-key'),
    indexKey: hkdf(secret, 'ledger-index-key'),
  };
}

function cleanNote(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function createLicenseService({ secret, productId, dataDir, log, now = () => Date.now() }) {
  const keys = deriveKeys(secret);
  const file = path.join(dataDir, LEDGER_FILE);

  const byId = new Map();        // lid -> issue record
  const bySession = new Map();   // keyed hash of Checkout Session id -> lid
  const byPayment = new Map();   // keyed hash of PaymentIntent id -> lid
  const revoked = new Map();     // lid -> reason
  const blocked = new Map();     // keyed hash of PaymentIntent id -> reason
  let fd = null;

  // ---- hashing -------------------------------------------------------------
  const indexHash = (value) => crypto.createHmac('sha256', keys.indexKey).update(String(value), 'utf8').digest('hex').slice(0, 40);
  function emailHash(email) {
    if (typeof email !== 'string') return '';
    const norm = email.trim().toLowerCase();
    if (!norm || norm.length > 320 || !norm.includes('@')) return '';
    return b64u(crypto.createHmac('sha256', keys.emailKey).update(norm, 'utf8').digest()).slice(0, 22);
  }

  // ---- ledger --------------------------------------------------------------
  function apply(rec) {
    if (!rec || typeof rec !== 'object') return false;
    switch (rec.op) {
      case 'issue':
        if (typeof rec.lid !== 'string' || !LID_RE.test(rec.lid) || !Number.isSafeInteger(rec.iat)) return false;
        byId.set(rec.lid, rec);
        if (typeof rec.sid === 'string') bySession.set(rec.sid, rec.lid);
        if (typeof rec.pid === 'string') byPayment.set(rec.pid, rec.lid);
        return true;
      case 'revoke':
        if (typeof rec.lid !== 'string' || !LID_RE.test(rec.lid)) return false;
        revoked.set(rec.lid, typeof rec.reason === 'string' ? rec.reason : 'revoked');
        return true;
      case 'reinstate':
        if (typeof rec.lid !== 'string') return false;
        revoked.delete(rec.lid);
        return true;
      case 'block':
        if (typeof rec.pid !== 'string') return false;
        blocked.set(rec.pid, typeof rec.reason === 'string' ? rec.reason : 'blocked');
        return true;
      case 'unblock':
        if (typeof rec.pid !== 'string') return false;
        blocked.delete(rec.pid);
        return true;
      default:
        return false;
    }
  }

  function load() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    let good = 0;
    let bad = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec = null;
      try { rec = JSON.parse(line); } catch (e) { /* torn or corrupt line */ }
      if (apply(rec)) good++; else bad++;
    }
    fd = fs.openSync(file, 'a', 0o600);
    // start the next record on a fresh line if the last write was torn
    if (raw.length > 0 && !raw.endsWith('\n')) fs.writeSync(fd, '\n');
    if (bad && log) log.warn('license.ledger.skipped', { lines: bad });
    if (log) log.info('license.ledger.loaded', { records: good, licenses: byId.size, revoked: revoked.size });
  }

  // durable append; throws if the record could not be stored
  function persist(rec) {
    if (fd === null) throw new Error('license ledger is closed');
    const buf = Buffer.from(JSON.stringify(rec) + '\n', 'utf8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    apply(rec);
  }

  // ---- tokens --------------------------------------------------------------
  function payloadOf(rec) {
    const p = { v: 1, lid: rec.lid, prd: rec.prd, iat: rec.iat, src: rec.src };
    if (rec.eh) p.eh = rec.eh;
    return p;
  }

  function tokenFor(rec) {
    const body = TOKEN_PREFIX + '.' + b64u(JSON.stringify(payloadOf(rec)));
    const sig = crypto.sign(null, Buffer.from(body, 'ascii'), keys.privateKey);
    return body + '.' + b64u(sig);
  }

  // -> { ok:true, payload } | { ok:false, reason }
  // reasons: malformed | bad-signature | wrong-product | revoked
  function verify(token) {
    if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
    const t = token.trim();
    if (t.length < 16 || t.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
    const parts = t.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !B64U_RE.test(parts[1]) || !B64U_RE.test(parts[2])) {
      return { ok: false, reason: 'malformed' };
    }
    const sig = Buffer.from(parts[2], 'base64url');
    if (sig.length !== 64 || b64u(sig) !== parts[2]) return { ok: false, reason: 'malformed' };
    let valid = false;
    try {
      valid = crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1], 'ascii'), keys.publicKey, sig);
    } catch (e) {
      valid = false;
    }
    if (!valid) return { ok: false, reason: 'bad-signature' };
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) {
      return { ok: false, reason: 'malformed' };
    }
    if (!payload || typeof payload !== 'object' || payload.v !== 1
      || typeof payload.lid !== 'string' || !LID_RE.test(payload.lid)
      || typeof payload.prd !== 'string' || !Number.isSafeInteger(payload.iat)) {
      return { ok: false, reason: 'malformed' };
    }
    if (payload.prd !== productId) return { ok: false, reason: 'wrong-product' };
    if (revoked.has(payload.lid)) return { ok: false, reason: 'revoked', payload };
    return { ok: true, payload };
  }

  // ---- operations ----------------------------------------------------------
  function issue({ source, sessionId, paymentIntentId, email, note }) {
    const sid = sessionId ? indexHash(sessionId) : undefined;
    const pid = paymentIntentId ? indexHash(paymentIntentId) : undefined;
    if (sid && bySession.has(sid)) {
      return { created: false, record: byId.get(bySession.get(sid)) };
    }
    if (pid && blocked.has(pid)) return { created: false, record: null, blocked: blocked.get(pid) };
    const rec = {
      op: 'issue',
      lid: 'lic_' + crypto.randomBytes(12).toString('hex'),
      prd: productId,
      iat: Math.floor(now() / 1000),
      src: source === 'stripe' ? 'stripe' : 'admin',
    };
    const eh = emailHash(email);
    if (eh) rec.eh = eh;
    if (sid) rec.sid = sid;
    if (pid) rec.pid = pid;
    const n = cleanNote(note, 200);
    if (n) rec.note = n;
    persist(rec);
    if (log) log.info('license.issue', { lid: rec.lid, src: rec.src });
    return { created: true, record: rec };
  }

  function revoke(lid, reason) {
    if (!byId.has(lid) && !LID_RE.test(String(lid))) return { ok: false, reason: 'unknown-license' };
    if (revoked.has(lid)) return { ok: true, changed: false };
    persist({ op: 'revoke', lid, reason: cleanNote(reason, 80) || 'revoked', at: Math.floor(now() / 1000) });
    if (log) log.info('license.revoke', { lid, reason: revoked.get(lid) });
    return { ok: true, changed: true };
  }

  function reinstate(lid) {
    if (!revoked.has(lid)) return { ok: true, changed: false };
    persist({ op: 'reinstate', lid, at: Math.floor(now() / 1000) });
    if (log) log.info('license.reinstate', { lid });
    return { ok: true, changed: true };
  }

  // A payment was refunded / disputed: revoke its license, or (when no
  // license exists yet) remember the payment so one can never be issued.
  // `tombstone:false` skips the second part (used when we cannot tell whether
  // the payment was ours at all).
  function revokePayment(paymentIntentId, reason, { tombstone = true } = {}) {
    const pid = indexHash(paymentIntentId);
    const lid = byPayment.get(pid);
    if (lid) return { lid, ...revoke(lid, reason) };
    if (tombstone && !blocked.has(pid)) {
      persist({ op: 'block', pid, reason: cleanNote(reason, 80) || 'blocked', at: Math.floor(now() / 1000) });
    }
    return { lid: null, ok: true, changed: !!tombstone };
  }

  // A dispute was won: undo a revocation that was made because of it.
  function reinstatePayment(paymentIntentId, onlyIfReason) {
    const pid = indexHash(paymentIntentId);
    if (blocked.has(pid) && (!onlyIfReason || blocked.get(pid) === onlyIfReason)) {
      persist({ op: 'unblock', pid, at: Math.floor(now() / 1000) });
    }
    const lid = byPayment.get(pid);
    if (!lid || !revoked.has(lid)) return { lid: lid || null, changed: false };
    if (onlyIfReason && revoked.get(lid) !== onlyIfReason) return { lid, changed: false };
    return { lid, ...reinstate(lid) };
  }

  function describe(rec) {
    return {
      id: rec.lid,
      product: rec.prd,
      issuedAt: rec.iat,
      source: rec.src,
      revoked: revoked.has(rec.lid),
      revokedReason: revoked.get(rec.lid) || null,
      note: rec.note || null,
    };
  }

  load();

  return {
    productId,
    file,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicKeyRaw: b64u(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)),
    tokenFor,
    verify,
    issue,
    revoke,
    reinstate,
    revokePayment,
    reinstatePayment,
    describe,
    get: (lid) => byId.get(lid) || null,
    isRevoked: (lid) => revoked.has(lid),
    revokedReason: (lid) => revoked.get(lid) || null,
    findBySession: (sessionId) => {
      const lid = bySession.get(indexHash(sessionId));
      return lid ? byId.get(lid) : null;
    },
    isPaymentBlocked: (paymentIntentId) => blocked.get(indexHash(paymentIntentId)) || null,
    findByEmail: (email) => {
      const eh = emailHash(email);
      if (!eh) return [];
      return [...byId.values()].filter((r) => r.eh === eh);
    },
    list: (offset = 0, limit = 100) => [...byId.values()].slice(offset, offset + limit).map(describe),
    stats: () => ({ licenses: byId.size, revoked: revoked.size }),
    close: () => {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (e) { /* no-op */ }
        fd = null;
      }
    },
  };
}

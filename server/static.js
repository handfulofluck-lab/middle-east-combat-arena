// Static hosting for the built client (dist/web).
//   * path-traversal safe: decoded path segments are validated, the resolved
//     file must live under the (real) web root, dotfiles are never served
//   * caching: weak ETag + 304s everywhere; `immutable` for content-hashed
//     files under /assets/, `no-cache` (always revalidate) for everything
//     else. Unhashed data (maps, game data) MUST revalidate: two lockstep
//     peers running different data desync, so stale caches are a real bug.
//   * brotli/gzip on the fly for text-like types, compressed buffers cached
//     in memory (bounded), concurrent compressions of one file de-duplicated
//   * HEAD, single-range requests (media seeking), SPA fallback to index.html
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { pickEncoding } from './http-util.js';

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.pdf': 'application/pdf',
};

const COMPRESSIBLE = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.md',
  '.csv', '.xml', '.svg', '.wasm', '.gltf', '.glb', '.bin', '.ttf', '.otf', '.ico', '.bmp', '.hdr',
]);

const MIN_COMPRESS_BYTES = 1024;
const MAX_COMPRESS_BYTES = 32 * 1024 * 1024;
const COMPRESS_CACHE_BYTES = 96 * 1024 * 1024;

// "name-<hash>.ext" as emitted by Vite (Rollup/Rolldown): exactly 8 base64url
// characters after the last dash. This is a heuristic, so it is biased hard
// towards "not hashed": the candidate must mix an uppercase letter with other
// characters, which ~98% of real hashes do and hand-written names ("-artwork",
// "-version2", "-20240101") do not. A miss only costs a 304 revalidation; a
// false hit would pin a mutable file in browser caches for a year.
const HASHED_NAME = /-([A-Za-z0-9_-]{8})\.[A-Za-z0-9]+$/;
export function isHashedAsset(urlPath) {
  if (!urlPath.startsWith('/assets/')) return false;
  const m = HASHED_NAME.exec(urlPath);
  return !!m && /[A-Z]/.test(m[1]) && /[a-z0-9]/.test(m[1]);
}

// Decode + validate a URL path. Returns a clean relative path ('' = root),
// or { error } describing why it is refused.
export function safeRelativePath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (e) { return { error: 'malformed' }; }
  if (decoded.includes('\0') || decoded.includes('\\')) return { error: 'malformed' };
  const out = [];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return { error: 'traversal' };
    if (seg.startsWith('.') && !(out.length === 0 && seg === '.well-known')) return { error: 'hidden' };
    out.push(seg);
  }
  return { rel: out.join('/') };
}

function etagFor(st) {
  return 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
}

function etagMatches(header, etag) {
  if (typeof header !== 'string' || !header) return false;
  const bare = etag.replace(/^W\//, '');
  for (const part of header.split(',')) {
    const tag = part.trim();
    if (tag === '*' || tag.replace(/^W\//, '') === bare) return true;
  }
  return false;
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // not understood: send it all
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end };
}

// sha256 hashes of the inline <script> blocks of an HTML document, so the CSP
// can stay strict ('self' + exact hashes, no 'unsafe-inline') whatever the
// page template does. The HTML parser normalizes CRLF to LF before the
// browser hashes script text, so we do the same.
export function inlineScriptHashes(html) {
  const hashes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) && hashes.length < 32) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const body = m[2].replace(/\r\n?/g, '\n');
    if (!body.trim()) continue;
    hashes.push("'sha256-" + crypto.createHash('sha256').update(body, 'utf8').digest('base64') + "'");
  }
  return hashes;
}

export function createStaticHandler({ root, log, headersFor }) {
  let realRoot = null;
  const compressed = new Map();   // key -> Buffer
  let compressedBytes = 0;
  const inflight = new Map();     // key -> Promise<Buffer>
  const htmlMeta = new Map();     // key -> { hashes }

  async function getRealRoot() {
    if (realRoot) return realRoot;
    try { realRoot = await fs.promises.realpath(root); } catch (e) { return null; }
    return realRoot;
  }

  // -> { abs, st } for a regular file inside the web root, else null
  async function locate(rel) {
    const base = await getRealRoot();
    if (!base) return null;
    const joined = path.join(base, rel);
    if (joined !== base && !joined.startsWith(base + path.sep)) return null;
    let abs;
    try { abs = await fs.promises.realpath(joined); } catch (e) { return null; }
    if (abs !== base && !abs.startsWith(base + path.sep)) return null; // symlink out of the root
    let st;
    try { st = await fs.promises.stat(abs); } catch (e) { return null; }
    if (st.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      try { st = await fs.promises.stat(idx); } catch (e) { return null; }
      if (!st.isFile()) return null;
      return { abs: idx, st };
    }
    if (!st.isFile()) return null;
    return { abs, st };
  }

  function remember(key, buf) {
    if (buf.length > COMPRESS_CACHE_BYTES) return;
    compressed.set(key, buf);
    compressedBytes += buf.length;
    for (const [k, v] of compressed) {       // evict oldest first
      if (compressedBytes <= COMPRESS_CACHE_BYTES) break;
      if (k === key) continue;
      compressed.delete(k);
      compressedBytes -= v.length;
    }
  }

  async function compressedBody(abs, st, encoding) {
    const key = encoding + '\n' + abs + '\n' + st.size + '\n' + st.mtimeMs;
    const hit = compressed.get(key);
    if (hit) return hit;
    let job = inflight.get(key);
    if (!job) {
      job = (async () => {
        const raw = await fs.promises.readFile(abs);
        const buf = encoding === 'br'
          ? await brotliCompress(raw, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          })
          : await gzipCompress(raw, { level: 6 });
        remember(key, buf);
        return buf;
      })();
      inflight.set(key, job);
      job.then(() => inflight.delete(key), () => inflight.delete(key));
    }
    return job;
  }

  async function htmlInfo(abs, st) {
    const key = abs + '\n' + st.size + '\n' + st.mtimeMs;
    let meta = htmlMeta.get(key);
    if (!meta) {
      const html = await fs.promises.readFile(abs, 'utf8');
      meta = { hashes: inlineScriptHashes(html) };
      if (htmlMeta.size > 64) htmlMeta.clear();
      htmlMeta.set(key, meta);
    }
    return meta;
  }

  async function sendFile(req, res, urlPath, file) {
    const { abs, st } = file;
    const ext = path.extname(abs).toLowerCase();
    const isHtml = ext === '.html' || ext === '.htm';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: etagFor(st),
      'Cache-Control': !isHtml && isHashedAsset(urlPath)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    };
    const meta = isHtml ? await htmlInfo(abs, st) : null;
    Object.assign(headers, headersFor(req, { isHtml, scriptHashes: meta ? meta.hashes : [] }));

    const canCompress = COMPRESSIBLE.has(ext) && st.size >= MIN_COMPRESS_BYTES && st.size <= MAX_COMPRESS_BYTES;
    if (canCompress) headers.Vary = 'Accept-Encoding';

    if (etagMatches(req.headers['if-none-match'], headers.ETag)) {
      delete headers['Content-Type'];
      res.writeHead(304, headers);
      res.end();
      return;
    }

    const encoding = canCompress ? pickEncoding(req.headers['accept-encoding']) : '';
    if (encoding) {
      const body = await compressedBody(abs, st, encoding);
      headers['Content-Encoding'] = encoding;
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    headers['Accept-Ranges'] = 'bytes';
    let status = 200;
    let start = 0;
    let end = st.size - 1;
    const rangeHeader = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (rangeHeader && st.size > 0 && (!ifRange || etagMatches(ifRange, headers.ETag))) {
      const range = parseRange(rangeHeader, st.size);
      if (range === 'unsatisfiable') {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size, 'Content-Length': 0 });
        res.end();
        return;
      }
      if (range) {
        status = 206;
        start = range.start;
        end = range.end;
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      }
    }
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(abs, { start, end });
    pipeline(stream, res, (err) => {
      if (err && log) log.debug('static.stream', { path: urlPath, err: err.code || err.message });
    });
  }

  // Returns true when the request was answered.
  async function handle(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 });
      res.end();
      return true;
    }
    const safe = safeRelativePath(pathname);
    if (safe.error) {
      const status = safe.error === 'hidden' ? 404 : 400;
      const body = status === 404 ? 'Not found\n' : 'Bad request\n';
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    let file = await locate(safe.rel);
    let urlPath = '/' + safe.rel;
    if (!file) {
      // SPA fallback: extension-less routes get the app shell; a missing
      // asset ("/assets/x.js", "/maps/y.json") stays an honest 404.
      const last = safe.rel.split('/').pop() || '';
      if (last.includes('.')) return notFound(req, res);
      file = await locate('index.html');
      urlPath = '/index.html';
      if (!file) {
        const body = 'MCA server is running, but no client build was found.\n'
          + 'Run "npm run build" (or point WEB_ROOT at a built client).\n';
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : body);
        return true;
      }
    } else if (path.basename(file.abs) === 'index.html' && !safe.rel.endsWith('index.html')) {
      urlPath = '/' + (safe.rel ? safe.rel + '/' : '') + 'index.html';
    }
    await sendFile(req, res, urlPath, file);
    return true;
  }

  function notFound(req, res) {
    const body = 'Not found\n';
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  return { handle, stats: () => ({ compressedEntries: compressed.size, compressedBytes }) };
}

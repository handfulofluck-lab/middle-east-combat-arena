// Founder's Pass store: the purchase / redeem modal and the license kept in
// this browser. Self-contained -- it imports nothing from the UI modules,
// builds its own DOM with its own stylesheet, and every browser global is
// guarded so headless harnesses can load it.
//
//   initStore(game)   inject the (hidden) modal, set game.openStore, finish a
//                     Checkout return (?session_id=...) by claiming the license
//   openStore(game)   show the modal
//   getLicense()      the stored license token, or null
//   hasPass()         true when a license token is stored
//
// What this module will NOT do: pretend. If the server has no payment keys
// (MCA_CONFIG.storeEnabled is false) the Buy button is disabled and the modal
// says plainly that nothing can be bought in this build. A key is only stored
// after the server has verified it. Card details are never seen here: paying
// happens on Stripe's hosted Checkout page.
//
// The license is a bearer token in localStorage ('mca.license'); net/net.js
// attaches it to create/join so a paywalled relay can check it. With
// MCA_PAYWALL=full the modal turns into a gate that cannot be dismissed --
// a convenience lock on the UI, not DRM (see docs/MONETIZATION.md).
import '../styles/store.css';

const LICENSE_KEY = 'mca.license';
const PENDING_KEY = 'mca.pendingSession';
const TOKEN_RE = /^MCA1\.[A-Za-z0-9_-]{8,700}\.[A-Za-z0-9_-]{20,200}$/;
const SESSION_RE = /^cs_[A-Za-z0-9_]{8,250}$/;
const CLAIM_RETRY_MS = [1500, 2500, 4000, 6000]; // waits between attempts while a payment settles

const S = {
  game: null,
  els: null,       // DOM references once built
  open: false,
  gate: false,
  busy: false,
  status: null,    // { kind: 'ok'|'warn'|'error'|'busy'|'info', text }
  pending: null,   // Checkout session id whose claim has not succeeded yet
  lastFocus: null,
  checked: false,  // background re-verification done
};

// ---- guarded environment ----------------------------------------------------

function env(name) {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (!g) return undefined;
    if (g[name] !== undefined) return g[name];
    return g.window ? g.window[name] : undefined;
  } catch (e) { return undefined; }
}

function config() {
  const c = env('MCA_CONFIG');
  return c && typeof c === 'object' ? c : {};
}

function productName() {
  const p = config().product;
  return p && typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : "Founder's Pass";
}

function priceLabel() {
  const p = config().product;
  return p && typeof p.priceLabel === 'string' ? p.priceLabel.trim().slice(0, 40) : '';
}

function storage(kind) {
  try { return env(kind) || null; } catch (e) { return null; }
}

function read(kind, key) {
  try {
    const s = storage(kind);
    const v = s && typeof s.getItem === 'function' ? s.getItem(key) : null;
    return typeof v === 'string' ? v : null;
  } catch (e) { return null; }
}

function write(kind, key, value) {
  try {
    const s = storage(kind);
    if (!s) return false;
    if (value === null) s.removeItem(key); else s.setItem(key, value);
    return true;
  } catch (e) { return false; }
}

// ---- license ------------------------------------------------------------------

export function getLicense() {
  const tok = read('localStorage', LICENSE_KEY);
  return tok && TOKEN_RE.test(tok) ? tok : null;
}

export function hasPass() {
  return getLicense() !== null;
}

function saveLicense(token) {
  return write('localStorage', LICENSE_KEY, token);
}

function forgetLicense() {
  write('localStorage', LICENSE_KEY, null);
}

// ---- API ------------------------------------------------------------------------

function apiUrl(path) {
  const base = typeof config().apiBase === 'string' ? config().apiBase.trim().replace(/\/+$/, '') : '';
  return base + path;
}

// -> { status, data }   status 0 = the server could not be reached
async function api(path, options) {
  const doFetch = env('fetch');
  if (typeof doFetch !== 'function') return { status: 0, data: null };
  try {
    const init = { method: (options && options.method) || 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (options && options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const res = await doFetch(apiUrl(path), init);
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    return { status: res.status, data: data && typeof data === 'object' ? data : null };
  } catch (e) {
    return { status: 0, data: null };
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    const st = env('setTimeout');
    if (typeof st === 'function') st(resolve, ms); else resolve();
  });
}

// ---- copy ---------------------------------------------------------------------------

function includedItems() {
  const p = config().product;
  if (p && Array.isArray(p.includes)) {
    const custom = p.includes.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 140)).slice(0, 8);
    if (custom.length) return custom;
  }
  const mode = config().paywall;
  if (mode === 'multiplayer') {
    return [
      'Online multiplayer on this server: host and join rooms',
      'Skirmish against the AI stays free for everyone',
      'One-time purchase, no subscription',
      'A license key you can redeem in any browser',
    ];
  }
  if (mode === 'full') {
    return [
      'Full access to the game on this server',
      'One-time purchase, no subscription',
      'A license key you can redeem in any browser',
    ];
  }
  return [
    'Directly funds the development of MCA',
    'The whole game stays free to play: today this pass unlocks nothing extra',
    'One-time payment, no subscription',
    'A license key as your proof of support, redeemable in any browser',
  ];
}

function ledeText() {
  const mode = config().paywall;
  const name = productName();
  if (mode === 'multiplayer') return 'The ' + name + ' unlocks online multiplayer on this server. Single-player is free.';
  if (mode === 'full') return 'This server requires the ' + name + ' to play.';
  return 'The ' + name + ' is a supporter purchase. Nothing in the game is locked behind it.';
}

function reasonText(reason) {
  switch (reason) {
    case 'revoked': return 'That license key has been revoked (for example after a refund).';
    case 'wrong-product': return 'That key belongs to a different product.';
    case 'bad-signature': return 'That license key is not valid for this server.';
    default: return 'That does not look like a valid license key.';
  }
}

// ---- DOM ------------------------------------------------------------------------------

function make(tag, className, text) {
  const doc = env('document');
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function setHidden(node, hidden) {
  if (node && node.classList) node.classList.toggle('store-hidden', !!hidden);
}

function setStatus(kind, text) {
  S.status = text ? { kind, text } : null;
  render();
}

function build() {
  const doc = env('document');
  if (S.els || !doc || typeof doc.createElement !== 'function') return !!S.els;
  const host = (typeof doc.getElementById === 'function' && doc.getElementById('store-root')) || doc.body;
  if (!host || typeof host.appendChild !== 'function') return false;

  const root = make('div', 'store-root store-hidden');
  const backdrop = make('div', 'store-backdrop');
  const frame = make('div', 'store-frame');
  const panel = make('section', 'store-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'store-title');
  panel.setAttribute('tabindex', '-1');
  const scroll = make('div', 'store-scroll');

  const head = make('header', 'store-head');
  const headText = make('div', 'store-head-text');
  const kicker = make('div', 'store-kicker', 'Support the campaign');
  const title = make('h2', 'store-title');
  title.id = 'store-title';
  headText.appendChild(kicker);
  headText.appendChild(title);
  const close = make('button', 'store-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  head.appendChild(headText);
  head.appendChild(close);

  const body = make('div', 'store-body');
  const left = make('div', 'store-col');
  const lede = make('p', 'store-lede');
  const sub = make('h3', 'store-subhead', 'What the pass includes');
  const list = make('ul', 'store-includes');
  left.appendChild(lede);
  left.appendChild(sub);
  left.appendChild(list);
  const offer = make('div', 'store-offer');
  const priceLabelEl = make('div', 'store-price-label', 'One-time price');
  const price = make('div', 'store-price');
  const priceNote = make('div', 'store-price-note');
  const buy = make('button', 'store-btn store-btn-primary');
  buy.type = 'button';
  const secure = make('div', 'store-secure',
    'Payment happens on Stripe’s secure checkout page. Card details never touch this site.');
  offer.appendChild(priceLabelEl);
  offer.appendChild(price);
  offer.appendChild(priceNote);
  offer.appendChild(buy);
  offer.appendChild(secure);
  body.appendChild(left);
  body.appendChild(offer);

  const notice = make('p', 'store-notice');
  const noticeStrong = make('strong', null, 'Purchases are not available in this build.');
  const noticeRest = make('span', null, ' No payment can be made here and nothing will be charged.');
  notice.appendChild(noticeStrong);
  notice.appendChild(noticeRest);

  const status = make('p', 'store-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const retry = make('button', 'store-btn store-btn-quiet', 'Check again');
  retry.type = 'button';

  const owned = make('div', 'store-section');
  owned.appendChild(make('h3', 'store-subhead', 'Your license key'));
  const key = make('textarea', 'store-key');
  key.readOnly = true;
  key.setAttribute('readonly', '');
  key.setAttribute('aria-label', 'Your license key');
  key.setAttribute('spellcheck', 'false');
  const keyActions = make('div', 'store-key-actions');
  const copy = make('button', 'store-btn store-btn-quiet', 'Copy key');
  copy.type = 'button';
  const remove = make('button', 'store-btn store-btn-quiet', 'Remove from this browser');
  remove.type = 'button';
  const keyHint = make('span', 'store-hint',
    'Save this key somewhere safe: it is your proof of purchase and restores the pass on another device. Keep it private.');
  keyActions.appendChild(copy);
  keyActions.appendChild(remove);
  keyActions.appendChild(keyHint);
  owned.appendChild(key);
  owned.appendChild(keyActions);

  const redeem = make('div', 'store-section');
  redeem.appendChild(make('h3', 'store-subhead', 'Redeem a key'));
  const row = make('div', 'store-row');
  const input = make('input', 'store-input');
  input.type = 'text';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('placeholder', 'MCA1…');
  input.setAttribute('aria-label', 'License key');
  const redeemBtn = make('button', 'store-btn', 'Redeem');
  redeemBtn.type = 'button';
  row.appendChild(input);
  row.appendChild(redeemBtn);
  redeem.appendChild(row);

  const foot = make('p', 'store-foot');

  scroll.appendChild(head);
  scroll.appendChild(body);
  scroll.appendChild(notice);
  scroll.appendChild(status);
  scroll.appendChild(retry);
  scroll.appendChild(owned);
  scroll.appendChild(redeem);
  scroll.appendChild(foot);
  panel.appendChild(scroll);
  frame.appendChild(panel);
  root.appendChild(backdrop);
  root.appendChild(frame);
  host.appendChild(root);

  S.els = {
    root, backdrop, panel, title, kicker, close, lede, list, price, priceNote, buy, notice, status, retry,
    owned, key, copy, remove, redeem, input, redeemBtn, foot,
  };

  close.addEventListener('click', () => closeStore());
  backdrop.addEventListener('click', () => closeStore());
  buy.addEventListener('click', () => { startCheckout(); });
  redeemBtn.addEventListener('click', () => { redeemKey(); });
  retry.addEventListener('click', () => { if (S.pending) claim(S.pending); });
  copy.addEventListener('click', () => { copyKey(); });
  remove.addEventListener('click', () => {
    forgetLicense();
    setStatus('info', 'The key was removed from this browser. You can redeem it again at any time.');
    applyGate();
  });
  // pointer input on the modal never reaches the game underneath
  for (const type of ['wheel', 'mousedown', 'mouseup', 'contextmenu', 'dblclick']) {
    root.addEventListener(type, (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); });
  }
  render();
  return true;
}

// While the modal is open it owns the keyboard, wherever the focus happens
// to be: keys are stopped at the window (capture phase) so nothing typed here
// reaches the game's hotkeys, and Escape / Tab / Enter are handled here.
function onGlobalKey(e) {
  if (!S.open || !S.els || !e) return;
  if (typeof e.stopPropagation === 'function') e.stopPropagation();
  if (e.type !== 'keydown') return;
  if (e.key === 'Escape') {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    closeStore();
  } else if (e.key === 'Enter' && e.target === S.els.input) {
    redeemKey();
  } else if (e.key === 'Tab') {
    cycleFocus(e);
  }
}

function listenKeys(on) {
  const win = env('window') || (typeof globalThis !== 'undefined' ? globalThis : null);
  const fn = win && (on ? win.addEventListener : win.removeEventListener);
  if (typeof fn !== 'function') return;
  for (const type of ['keydown', 'keyup', 'keypress']) {
    try { fn.call(win, type, onGlobalKey, true); } catch (e) { /* no-op */ }
  }
}

function isShown(node) {
  const root = S.els.root;
  for (let p = node; p; p = p.parentNode) {
    if (p.classList && p.classList.contains('store-hidden')) return false;
    if (p === root) return true;
  }
  return false; // not inside the modal at all
}

// Keep the focus inside the modal: the element that had it may just have
// been hidden (e.g. the redeem field once a key is accepted).
function keepFocus() {
  if (!S.open || !S.els) return;
  const doc = env('document');
  const active = doc ? doc.activeElement : null;
  if (active && isShown(active)) return;
  try { S.els.panel.focus(); } catch (e) { /* best effort */ }
}

function focusables() {
  const E = S.els;
  return [E.close, E.buy, E.retry, E.key, E.copy, E.remove, E.input, E.redeemBtn]
    .filter((n) => n && !n.disabled && isShown(n) && !(S.gate && n === E.close));
}

function cycleFocus(e) {
  const list = focusables();
  if (!list.length) return;
  const doc = env('document');
  const i = list.indexOf(doc && doc.activeElement);
  const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i < 0 || i === list.length - 1 ? 0 : i + 1);
  if (typeof e.preventDefault === 'function') e.preventDefault();
  try { list[next].focus(); } catch (err) { /* no-op */ }
}

function render() {
  const E = S.els;
  if (!E) return;
  const cfg = config();
  const name = productName();
  const price = priceLabel();
  const license = getLicense();
  const canBuy = cfg.storeEnabled === true;
  const canRedeem = cfg.redeemEnabled !== false; // unknown (static config.js) -> let the server answer

  E.root.classList.toggle('store-gate', S.gate);
  E.kicker.textContent = S.gate ? 'Pass required' : 'Support the campaign';
  E.title.textContent = name;
  E.lede.textContent = ledeText();

  while (E.list.firstChild) E.list.removeChild(E.list.firstChild);
  for (const item of includedItems()) E.list.appendChild(make('li', null, item));

  E.price.textContent = price || (canBuy ? 'Shown at checkout' : 'Not on sale');
  E.price.classList.toggle('store-price-none', !price);
  E.priceNote.textContent = canBuy ? 'One-time payment. Taxes, if any, are shown at checkout.' : 'This build cannot take payments.';

  E.buy.disabled = !canBuy || S.busy || !!license;
  E.buy.textContent = license ? 'Pass active' : !canBuy ? 'Unavailable' : S.busy ? 'Please wait…' : (price ? 'Buy — ' + price : 'Buy now');
  setHidden(E.notice, canBuy);

  const st = S.status || (license ? { kind: 'ok', text: 'Your ' + name + ' is active in this browser. Thank you for backing MCA.' } : null);
  E.status.className = 'store-status' + (st && st.kind !== 'info' ? ' store-status-' + st.kind : '');
  E.status.textContent = st ? st.text : '';
  setHidden(E.retry, !(S.pending && !S.busy && !license));

  setHidden(E.owned, !license);
  E.key.value = license || '';

  setHidden(E.redeem, !!license);
  E.input.disabled = S.busy || !canRedeem;
  E.redeemBtn.disabled = S.busy || !canRedeem;

  E.foot.textContent = license
    ? 'Removing the key from this browser does not cancel it: you can redeem it again at any time.'
    : canRedeem
      ? 'Bought the game elsewhere or received a key? Redeem it above. Keys are checked by this server before they are stored.'
      : 'License keys cannot be checked by this server, so none can be redeemed here.';
  keepFocus();
}

function applyGate() {
  S.gate = config().paywall === 'full' && !hasPass();
  if (S.gate && S.els && !S.open) show();
  render();
}

function show() {
  if (!build()) return false;
  const E = S.els;
  const doc = env('document');
  if (!S.open) {
    S.lastFocus = doc && doc.activeElement ? doc.activeElement : null;
    listenKeys(true);
  }
  S.open = true;
  setHidden(E.root, false);
  render();
  try {
    const first = getLicense() ? E.copy : (E.buy.disabled ? E.input : E.buy);
    (first && !first.disabled ? first : E.panel).focus();
  } catch (e) { /* focus is best effort */ }
  return true;
}

export function closeStore() {
  if (!S.els || !S.open) return;
  if (S.gate) return; // the full-game gate cannot be dismissed
  S.open = false;
  listenKeys(false);
  setHidden(S.els.root, true);
  if (S.status && S.status.kind !== 'busy') S.status = null;
  try { if (S.lastFocus && typeof S.lastFocus.focus === 'function') S.lastFocus.focus(); } catch (e) { /* no-op */ }
  S.lastFocus = null;
}

export function openStore(game) {
  if (game && typeof game === 'object') S.game = game;
  S.gate = config().paywall === 'full' && !hasPass();
  return show();
}

// ---- actions ----------------------------------------------------------------------

function safeCheckoutUrl(url) {
  try {
    const U = env('URL');
    const u = new U(url);
    if (u.protocol === 'https:') return u.href;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.href;
  } catch (e) { /* fall through */ }
  return null;
}

async function startCheckout() {
  if (S.busy || config().storeEnabled !== true) return;
  S.busy = true;
  setStatus('busy', 'Opening secure checkout…');
  const res = await api('/api/checkout', { method: 'POST', body: {} });
  S.busy = false;
  const url = res.status === 200 && res.data && typeof res.data.url === 'string' ? safeCheckoutUrl(res.data.url) : null;
  if (url) {
    setStatus('busy', 'Redirecting to checkout…');
    const loc = env('location');
    try { if (loc && typeof loc.assign === 'function') loc.assign(url); else if (loc) loc.href = url; } catch (e) { /* no-op */ }
    return;
  }
  if (res.status === 503) setStatus('warn', 'Purchases are not available on this server.');
  else if (res.status === 429) setStatus('warn', 'Too many attempts. Please wait a minute and try again.');
  else if (res.status === 0) setStatus('error', 'The server could not be reached. Check your connection and try again.');
  else setStatus('error', 'Checkout could not be started. You have not been charged. Please try again in a moment.');
}

async function redeemKey() {
  const E = S.els;
  if (!E || S.busy) return;
  const token = String(E.input.value || '').trim();
  if (!token) { setStatus('warn', 'Paste your license key first.'); return; }
  if (!TOKEN_RE.test(token)) { setStatus('error', reasonText('malformed')); return; }
  S.busy = true;
  setStatus('busy', 'Checking your key…');
  const res = await api('/api/license/verify', { method: 'POST', body: { token } });
  S.busy = false;
  if (res.status === 200 && res.data && res.data.valid === true) {
    if (!saveLicense(token)) {
      setStatus('warn', 'The key is valid, but this browser refused to store it (private mode?).');
      return;
    }
    E.input.value = '';
    S.pending = null;
    write('sessionStorage', PENDING_KEY, null);
    setStatus('ok', 'Key accepted. Your ' + productName() + ' is active in this browser.');
    applyGate();
    return;
  }
  if (res.status === 200 && res.data) setStatus('error', reasonText(res.data.reason));
  else if (res.status === 503) setStatus('warn', 'License keys are not enabled on this server.');
  else if (res.status === 429) setStatus('warn', 'Too many attempts. Please wait a minute and try again.');
  else if (res.status === 0) setStatus('error', 'The server could not be reached, so the key could not be checked. Nothing was stored.');
  else setStatus('error', 'The key could not be checked right now. Nothing was stored.');
}

// Returning from Stripe Checkout: exchange the session id for the license.
// A payment can take a few seconds to settle, so "not paid yet" is retried.
async function claim(sessionId) {
  if (S.busy) return;
  S.busy = true;
  S.pending = sessionId;
  write('sessionStorage', PENDING_KEY, sessionId);
  setStatus('busy', 'Confirming your purchase…');
  let res = null;
  for (let attempt = 0; ; attempt++) {
    res = await api('/api/license/claim?session_id=' + encodeURIComponent(sessionId));
    if (res.status !== 402 || attempt >= CLAIM_RETRY_MS.length) break;
    await wait(CLAIM_RETRY_MS[attempt]);
  }
  S.busy = false;
  const done = () => { S.pending = null; write('sessionStorage', PENDING_KEY, null); };
  if (res.status === 200 && res.data && typeof res.data.token === 'string' && TOKEN_RE.test(res.data.token)) {
    done();
    if (saveLicense(res.data.token)) {
      setStatus('ok', 'Thank you! Your ' + productName() + ' is active. Your license key is shown below — save it somewhere safe.');
    } else {
      setStatus('warn', 'Purchase confirmed, but this browser refused to store the key (private mode?). Your key: ' + res.data.token);
    }
    applyGate();
    return;
  }
  if (res.status === 402) setStatus('warn', 'Your payment has not completed yet. Some payment methods take a while; use “Check again” in a few minutes.');
  else if (res.status === 410) { done(); setStatus('error', 'This purchase was refunded or disputed, so its license is not valid.'); }
  else if (res.status === 404 || res.status === 400) { done(); setStatus('error', 'That purchase could not be found.'); }
  else if (res.status === 503) { done(); setStatus('warn', 'Purchases are not available on this server.'); }
  else if (res.status === 0) setStatus('error', 'The server could not be reached. Your purchase is safe; use “Check again” once you are back online.');
  else setStatus('error', 'Your purchase could not be confirmed right now. Use “Check again” in a moment.');
}

async function copyKey() {
  const E = S.els;
  const token = getLicense();
  if (!E || !token) return;
  let ok = false;
  try {
    const nav = env('navigator');
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      await nav.clipboard.writeText(token);
      ok = true;
    }
  } catch (e) { ok = false; }
  if (!ok) {
    try { E.key.focus(); E.key.select(); } catch (e) { /* no-op */ }
    setStatus('info', 'Press Ctrl+C (or Cmd+C) to copy the selected key.');
    return;
  }
  setStatus('ok', 'License key copied to the clipboard.');
}

// ?session_id=... (success) or ?checkout=cancelled, as set by the server's
// Checkout return URLs. The parameters are removed from the address bar at
// once so a reload or a shared link never replays them.
function handleCheckoutReturn() {
  const loc = env('location');
  let sessionId = null;
  let cancelled = false;
  try {
    const USP = env('URLSearchParams');
    if (loc && typeof loc.search === 'string' && loc.search.length > 1 && typeof USP === 'function') {
      const params = new USP(loc.search);
      sessionId = params.get('session_id');
      cancelled = params.get('checkout') === 'cancelled';
      if (sessionId !== null || params.has('checkout')) {
        params.delete('session_id');
        params.delete('checkout');
        const rest = params.toString();
        const hist = env('history');
        if (hist && typeof hist.replaceState === 'function') {
          hist.replaceState(hist.state === undefined ? null : hist.state, '', (loc.pathname || '/') + (rest ? '?' + rest : '') + (loc.hash || ''));
        }
      }
    }
  } catch (e) { /* a broken URL must not break the game */ }

  if (sessionId !== null) {
    if (!SESSION_RE.test(sessionId)) {
      if (show()) setStatus('error', 'That purchase could not be found.');
      return;
    }
    if (show()) claim(sessionId);
    return;
  }
  if (cancelled) {
    if (show()) setStatus('info', 'Checkout was cancelled. You have not been charged.');
    return;
  }
  // an earlier claim that never completed (tab reloaded while offline, ...)
  const pending = read('sessionStorage', PENDING_KEY);
  if (pending && SESSION_RE.test(pending) && !hasPass()) S.pending = pending;
}

// A stored key is re-checked once per page load, quietly: a revoked or
// foreign key is dropped; an unreachable or key-less server changes nothing.
async function recheckStoredLicense() {
  if (S.checked) return;
  S.checked = true;
  const token = getLicense();
  if (!token || config().redeemEnabled === false) return;
  const res = await api('/api/license/verify', { method: 'POST', body: { token } });
  if (res.status === 200 && res.data && res.data.valid === false && getLicense() === token) {
    forgetLicense();
    S.status = { kind: 'warn', text: 'The license key saved in this browser is no longer valid and was removed. ' + reasonText(res.data.reason) };
    applyGate();
  }
}

export function initStore(game) {
  try {
    if (game && typeof game === 'object') {
      S.game = game;
      game.openStore = () => openStore(game);
    }
    if (!env('document')) return false; // headless harness: nothing to show
    if (!build()) return false;
    handleCheckoutReturn();
    applyGate();
    recheckStoredLicense();
    return true;
  } catch (e) {
    return false; // the store must never take the game down with it
  }
}

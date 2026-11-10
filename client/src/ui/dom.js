// Shared DOM helpers for the 2D interface (menus + HUD): element builders,
// the inline icon set, number formatting and small interaction utilities.
// Everything here is presentation-only and safe to call before a match exists.

export function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

// el('button', {class:'btn', title:'x', onclick: fn, dataset:{k:v}}, [children])
export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') { for (const d in v) node.dataset[d] = v[d]; }
      else if (k === 'style' && typeof v === 'object') { for (const s in v) node.style.setProperty(s, v[s]); }
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  if (children !== undefined && children !== null) append(node, children);
  return node;
}

export function append(node, children) {
  if (Array.isArray(children)) {
    for (const c of children) append(node, c);
  } else if (children instanceof Node) {
    node.appendChild(children);
  } else if (children !== undefined && children !== null && children !== false) {
    node.appendChild(document.createTextNode(String(children)));
  }
  return node;
}

export function clear(node) {
  if (node) node.textContent = '';
  return node;
}

// ---- icons ---------------------------------------------------------------------
// 24px grid, 1.75 stroke, round joins. `f` marks paths that are filled.
const ICONS = {
  back: 'M15 5l-7 7 7 7',
  chevL: 'M14 6l-6 6 6 6',
  chevR: 'M10 6l6 6-6 6',
  chevD: 'M6 9l6 6 6-6',
  chevU: 'M6 15l6-6 6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  pause: 'M9 5.5v13M15 5.5v13',
  play: 'M8 5.5v13l11-6.5z',
  music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  volume: 'M4 9.5v5h3.5L12 18V6L7.5 9.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  mute: 'M4 9.5v5h3.5L12 18V6L7.5 9.5H4zM16 9.5l5 5M21 9.5l-5 5',
  lock: 'M7.5 11V8a4.5 4.5 0 0 1 9 0v3M6 11h12v9H6z',
  credit: 'M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9zM12 8l3.5 4-3.5 4-3.5-4z',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.5l3 1.8',
  hp: 'M5 5h14v14H5zM12 8.5v7M8.5 12h7',
  shield: 'M12 3l7 3v5.5c0 4.4-3 7.6-7 9.5-4-1.9-7-5.1-7-9.5V6z',
  bolt: 'M13 3L5 13.5h5.5L10 21l8.5-11H13z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  sliders: 'M4 7h10M18 7h2M4 12h3M11 12h9M4 17h11M19 17h1M16 5v4M9 10v4M17 15v4',
  target: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 2v5M12 17v5M2 12h5M17 12h5',
  users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5M16 11a2.5 2.5 0 1 0 0-5M17 14c2 .5 3.3 2.2 3.6 4.5',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  warn: 'M12 4l9 16H3zM12 10v4.5M12 17.2v.3',
  info: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 11v5M12 7.8v.4',
  flag: 'M6 21V4M6 5h11l-2.5 3.5L17 12H6',
  aggressive: 'M12 4l5 6h-3.5v9h-3v-9H7z',
  hold: 'M6 6h12v12H6zM12 11.5v1',
  holdfire: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM6.5 6.5l11 11',
  deploy: 'M12 3v10M8 9l4 4 4-4M5 17h14v4H5z',
  unload: 'M12 13V3M8 7l4-4 4 4M5 17h14v4H5z',
  structures: 'M3 20h18M5 20V9h6v11M13 20V5h6v15M7.5 12.5h1M7.5 16h1M15.5 8.5h1M15.5 12h1M15.5 15.5h1',
  infantry: 'M5 14a7 7 0 0 1 14 0v2H5zM3.5 16h17M9 16v3h6v-3',
  vehicles: 'M3 14h18l-2 4H5zM7 14v-3h8v3M15 12h6',
  air: 'M12 3l2 7 7 5v2l-7-2-.8 4 2.3 1.5V22l-3.5-1-3.5 1v-1.5l2.3-1.5-.8-4-7 2v-2l7-5z',
  naval: 'M3 15h18l-3 5H6zM7 15v-4h7l3 4M10 11V7h3',
  grid: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
  globe: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z',
  crown: 'M4 17l-1-9 5 4 4-7 4 7 5-4-1 9z',
  send: 'M4 12l16-7-6 15-2.5-6z',
  keyboard: 'M3 7h18v10H3zM7 11h.5M11 11h.5M15 11h.5M7.5 14h9',
  exit: 'M12 4v8M7 6.5a7 7 0 1 0 10 0',
  restart: 'M5 12a7 7 0 1 1 2.5 5.4M5 18v-4.5h4.5',
  oil: 'M12 3.5c3 4 5.5 6.8 5.5 10a5.5 5.5 0 0 1-11 0c0-3.2 2.5-6 5.5-10z',
  warhead: 'M12 3c2.5 2.5 3.5 5.5 3.5 9v4h-7v-4c0-3.5 1-6.5 3.5-9zM8.5 16l-2.5 4h12l-2.5-4',
  speed: 'M5 7l5 5-5 5M12 7l5 5-5 5',
  range: 'M4 20L20 4M14 4h6v6M4 14v6h6',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  book: 'M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10',
  cap: 'M2.5 9.5L12 5l9.5 4.5L12 14zM6.5 11.8V16c1.5 1.4 3.4 2 5.5 2s4-.6 5.5-2v-4.2M21.5 9.5V15',
  heart: 'M12 20s-7-4.4-7-9.6A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.4C19 15.6 12 20 12 20z',
  spectate: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  zoom: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20',
  wifi: 'M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0M12 19.6v.3',
};
const FILLED = { play: 1, aggressive: 1, bolt: 1, send: 1, star: 1, crown: 1 };

export function iconSvg(name, cls) {
  const d = ICONS[name] || ICONS.info;
  const fill = FILLED[name] ? ' ico-fill' : '';
  return '<svg class="ico' + fill + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path d="' + d + '"/></svg>';
}

export function icon(name, cls) {
  const span = document.createElement('span');
  span.className = 'ico-wrap';
  span.innerHTML = iconSvg(name, cls);
  return span.firstChild;
}

// ---- formatting -----------------------------------------------------------------

export function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (v < 0 ? '-' : '') + out;
}

export function fmtClock(tick) {
  const s = Math.max(0, Math.floor(tick / 10));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? hh + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss;
}

export function fmtSecs(s) {
  const v = Math.max(0, Math.ceil(s));
  return v >= 60 ? Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0') : v + 's';
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// "saka_insertion" -> "Saka Insertion"
export function titleCase(id) {
  return String(id || '').replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// relative luminance of a #rrggbb colour (0..1)
export function luminance(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return 0.2;
  const lin = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
}

// mix a #rrggbb colour toward white (t>0) or black (t<0); returns rgb() string
export function shade(hex, t) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return hex;
  const mix = (v) => {
    const c = parseInt(v, 16);
    return Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t));
  };
  return 'rgb(' + mix(m[1]) + ',' + mix(m[2]) + ',' + mix(m[3]) + ')';
}

// A faction colour lifted until it is legible as text / line-work on ink.
export function legible(hex) {
  const l = luminance(hex);
  if (l >= 0.22) return hex;
  return shade(hex, Math.min(0.62, 0.3 + (0.22 - l) * 2.2));
}

// ---- storage ---------------------------------------------------------------------

export function lsGet(key, fallback) {
  try {
    const v = globalThis.localStorage ? globalThis.localStorage.getItem(key) : null;
    return v === null || v === undefined ? fallback : v;
  } catch (e) { return fallback; }
}

export function lsSet(key, value) {
  try { if (globalThis.localStorage) globalThis.localStorage.setItem(key, String(value)); } catch (e) { /* private mode */ }
}

export function lsGetJson(key, fallback) {
  try {
    const v = lsGet(key, null);
    return v ? JSON.parse(v) : fallback;
  } catch (e) { return fallback; }
}

// ---- keyboard roving focus for grids / lists -------------------------------------
// Arrow keys move focus between the focusable children of `container`.
// cols = 0 -> a vertical list (Up/Down only), else a grid of that many columns.
export function rovingFocus(container, selector, colsFn) {
  container.addEventListener('keydown', (e) => {
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const items = Array.from(container.querySelectorAll(selector))
      .filter((n) => !n.disabled && n.offsetParent !== null);
    if (!items.length) return;
    const cols = typeof colsFn === 'function' ? colsFn() : (colsFn || 0);
    let i = items.indexOf(document.activeElement);
    if (i < 0) i = 0;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = items.length - 1;
    else if (!cols) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') i = (i + 1) % items.length;
      else i = (i - 1 + items.length) % items.length;
    } else {
      if (e.key === 'ArrowRight') i = Math.min(items.length - 1, i + 1);
      if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
      if (e.key === 'ArrowDown') i = Math.min(items.length - 1, i + cols);
      if (e.key === 'ArrowUp') i = Math.max(0, i - cols);
    }
    items[i].focus();
    e.preventDefault();
    e.stopPropagation();
  });
}

// number of columns a CSS grid currently lays out (for rovingFocus)
export function gridCols(gridEl) {
  try {
    const t = getComputedStyle(gridEl).gridTemplateColumns;
    return t && t !== 'none' ? t.split(' ').length : 1;
  } catch (e) { return 1; }
}

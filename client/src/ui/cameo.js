// Cameo plates: the square unit / structure portrait used by the build grid,
// queue strip, selection panel, tooltips, faction rosters and the Arsenal.
//
// The renderer fills game.iconArt[defId] (data-URI portraits) asynchronously.
// Every cameo made here starts on a line-art fallback glyph and upgrades
// itself in place the moment its portrait arrives (or changes) — no caller
// has to re-render. A single low-frequency watcher drives that for every
// cameo currently in the document.
import { shapeForStructure, glyphKindFor, initialsFor } from '../game/sprites.js';

const WATCH_MS = 350;
const watched = new Set();
let timer = null;

function artUri(game, defId) {
  const art = game && game.iconArt;
  const uri = art ? art[defId] : null;
  return (typeof uri === 'string' && uri) ? uri : null;
}

function applyArt(rec) {
  const uri = artUri(rec.game, rec.defId);
  if (uri === rec.uri) return;
  rec.uri = uri;
  const el = rec.el;
  if (!uri) {
    if (rec.img && rec.img.parentNode) rec.img.parentNode.removeChild(rec.img);
    rec.img = null;
    el.classList.remove('has-art');
    return;
  }
  let img = rec.img;
  if (!img) {
    img = document.createElement('img');
    img.className = 'cameo-img';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'sync';
    img.addEventListener('error', () => {
      // undecodable portrait: fall back to the glyph and stop retrying this URI
      if (img.parentNode) img.parentNode.removeChild(img);
      if (rec.img === img) rec.img = null;
      el.classList.remove('has-art');
    });
    rec.img = img;
  }
  img.src = uri;
  if (!img.parentNode) el.appendChild(img);
  el.classList.add('has-art');
}

function pump() {
  for (const rec of watched) {
    if (!rec.el.isConnected) {
      // never attached within the grace window, or attached and since removed
      if (rec.seen || ++rec.misses > 20) watched.delete(rec);
      continue;
    }
    rec.seen = true;
    applyArt(rec);
  }
  if (!watched.size && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function watch(rec) {
  watched.add(rec);
  if (timer === null && typeof setInterval === 'function') timer = setInterval(pump, WATCH_MS);
}

// Force an immediate pass (renderers may call game.refreshIcons() after a
// batch of portraits lands; otherwise the watcher catches up within ~350ms).
export function refreshCameos() { pump(); }

export function hasIconArt(game, defId) { return !!artUri(game, defId); }

// ---- fallback glyphs (48px grid line-art) ------------------------------------------

const UNIT_GLYPH = {
  rifles: 'M10 10h28v28H10zM10 10l28 28M38 10L10 38',
  turret: 'M13 9h22v30H13zM24 19.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM24 19.5V4',
  wheeled: 'M14 10h20v28H14zM24 22a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM24 22v-9M10 15h4M10 24h4M10 33h4M34 15h4M34 24h4M34 33h4',
  missile: 'M24 5c4.2 4.2 6 9.5 6 15.5V32H18V20.5C18 14.5 19.8 9.2 24 5zM18 28l-6 9h24l-6-9M24 37v6',
  gear: 'M24 7l14.7 8.5v17L24 41 9.3 32.5v-17zM24 17.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z',
  rotor: 'M24 13c3 0 5 4 5 9.5S27 32 24 32s-5-4-5-9.5 2-9.5 5-9.5zM7 11l34 22M41 11L7 33M24 32v10M19.5 42h9',
  uav: 'M24 7v32M5 20h38M17 39h14M24 7l-2.5 6M24 7l2.5 6',
  dart: 'M24 4l4 14 14 10v4.5l-14-4.5-1.5 8.5 5 3.5v3L24 41l-7.5 2v-3l5-3.5L20 28 6 32.5V28l14-10z',
  anchor: 'M24 4c6 6 9 12.5 9 19.5V40H15V23.5C15 16.5 18 10 24 4zM19 24h10v9H19zM24 11v8',
};

const STRUCT_GLYPH = {
  hexagon: 'M24 5l16.5 9.5v19L24 43 7.5 33.5v-19zM24 15v18M15 24h18',
  circle: 'M24 7a17 17 0 1 0 0 34 17 17 0 0 0 0-34zM26.5 13l-9 12.5h6.5l-2 9.5 9-12.5h-6.5z',
  barrel: 'M14 9h20v30H14zM14 19h20M14 29h20M24 22.5c1.8 2.2 3 3.6 3 5.2a3 3 0 0 1-6 0c0-1.6 1.2-3 3-5.2z',
  tent: 'M5 39L24 9l19 30zM24 9v30M17.5 39L24 28l6.5 11',
  factory: 'M6 41V20l11.5 6.5V20L29 26.5V20l13 6.5V41zM13 41v-7h7v7M27 33h8',
  runway: 'M18.5 5h11L35 43H13zM24 11v5.5M24 21.5V27M24 32v5.5',
  dock: 'M24 12.5v26M16 20h16M9 29c2 7 7.5 9.5 15 9.5S37 36 39 29M24 5.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  diamond: 'M24 4l20 20-20 20L4 24zM16.5 25a7.5 7.5 0 0 1 15 0M24 25v6M24 17.5v0',
  spike: 'M11 41l5.5-17h15L37 41zM24 24V7M18.5 11.5h11',
  sam: 'M9 41h30M15 41l4-12h10l4 12M20 29L29 7M27 29l9-19',
  star: 'M24 4l5.5 14.5L44 24l-14.5 5.5L24 44l-5.5-14.5L4 24l14.5-5.5z',
  'star-sw': 'M24 3c4.8 4.8 7 10.5 7 17.5V30H17v-9.5C17 13.5 19.2 7.8 24 3zM17 30l-6.5 9.5h27L31 30M24 39.5V45M24 13.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  rect: 'M9 12h30v24H9zM9 20h30',
};

function unitGlyphKey(def) {
  if (!def) return 'rifles';
  if (def.cls === 'UAV') return 'uav';
  const k = glyphKindFor(def);
  if (k === 'turret') {
    switch (def.cls) {
      case 'APC': case 'IFV': case 'Light vehicle': case 'Mobile AA': return 'wheeled';
      default: return 'turret';
    }
  }
  return UNIT_GLYPH[k] ? k : 'rifles';
}

function structGlyphKey(def) {
  if (!def) return 'rect';
  switch (def.id) {
    case 'SH-04': return 'tent';
    case 'SH-05': return 'factory';
    case 'SH-06': return 'runway';
    case 'SH-07': return 'dock';
    default: break;
  }
  if (def.type === 'Def' && def.dmg && def.dmg.air >= 60) return 'sam';
  const s = shapeForStructure(def);
  return STRUCT_GLYPH[s] ? s : 'rect';
}

export function glyphSvg(def, kind) {
  const d = kind === 'struct' ? STRUCT_GLYPH[structGlyphKey(def)] : UNIT_GLYPH[unitGlyphKey(def)];
  return '<svg class="cameo-glyph" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
}

// ---- element ------------------------------------------------------------------------

// kind: 'unit' | 'struct'. opts.code=false hides the initials under the glyph.
export function makeCameo(game, def, kind, opts) {
  const el = document.createElement('span');
  el.className = 'cameo cameo-' + (kind === 'struct' ? 'struct' : 'unit')
    + (opts && opts.cls ? ' ' + opts.cls : '');
  const fb = document.createElement('span');
  fb.className = 'cameo-fb';
  fb.innerHTML = glyphSvg(def, kind);
  if (!opts || opts.code !== false) {
    const code = document.createElement('span');
    code.className = 'cameo-code';
    code.textContent = initialsFor(def && def.name ? def.name : '?');
    fb.appendChild(code);
  }
  el.appendChild(fb);
  if (def && def.id) {
    el.dataset.def = def.id;
    const rec = { el, game, defId: def.id, uri: null, img: null, seen: false, misses: 0 };
    applyArt(rec);
    watch(rec);
  }
  return el;
}

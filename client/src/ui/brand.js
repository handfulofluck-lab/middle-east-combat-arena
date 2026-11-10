// Brand marks: the MCA emblem + logotype lockup and one original crest per
// faction. Everything is inline SVG (crisp at any size, no assets).
//
// The crests are abstract geometric heraldry built from each faction's
// in-game doctrine line (game.json `identity`) and its sheet colour — they
// deliberately do not reference any flag, coat of arms or real insignia.
import { luminance, shade } from './dom.js';

let __uid = 0;
function uid(prefix) { __uid++; return prefix + __uid; }

// ---- emblem + logotype -------------------------------------------------------------

// Octagonal "arena" reticle around a dune-peak A with a guiding star.
export function emblemSvg(cls) {
  const g = uid('mcaE');
  return '<svg class="mca-emblem' + (cls ? ' ' + cls : '') + '" viewBox="0 0 64 64" role="img" aria-label="MCA emblem">'
    + '<defs><linearGradient id="' + g + '" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#ffe6b8"/><stop offset=".5" stop-color="#e9b872"/><stop offset="1" stop-color="#9a6b2e"/>'
    + '</linearGradient></defs>'
    + '<path d="M22 3.5H42L60.5 22V42L42 60.5H22L3.5 42V22Z" fill="rgba(8,11,16,.82)" stroke="url(#' + g + ')" stroke-width="2.4" stroke-linejoin="miter"/>'
    + '<path d="M24.6 9.5H39.4L54.5 24.6V39.4L39.4 54.5H24.6L9.5 39.4V24.6Z" fill="none" stroke="rgba(233,184,114,.28)" stroke-width="1"/>'
    + '<path d="M32 3.5v6M32 54.5v6M3.5 32h6M54.5 32h6" stroke="url(#' + g + ')" stroke-width="2" stroke-linecap="butt"/>'
    + '<path d="M17.5 45L32 17.5L46.5 45" fill="none" stroke="#f3f5f8" stroke-width="5.2" stroke-linejoin="miter" stroke-miterlimit="6" stroke-linecap="butt"/>'
    + '<path d="M32 31.5l5 6.25-5 6.25-5-6.25z" fill="url(#' + g + ')"/>'
    + '</svg>';
}

// Stencil-cut "MCA" letterforms; the A carries a brass dune under its peak.
export function logotypeSvg(cls) {
  const g = uid('mcaL');
  return '<svg class="mca-logotype' + (cls ? ' ' + cls : '') + '" viewBox="0 0 134 48" role="img" aria-label="MCA">'
    + '<defs><linearGradient id="' + g + '" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#ffe6b8"/><stop offset=".55" stop-color="#e9b872"/><stop offset="1" stop-color="#a9793a"/>'
    + '</linearGradient></defs>'
    + '<g fill="currentColor">'
    + '<path d="M0 44V4h9l11 20L31 4h9v40h-8V17L20 38 8 17v27z"/>'
    + '<path d="M58 4h26v8H61.3L58 15.3v17.4l3.3 3.3H84v8H58l-8-8V12z"/>'
    + '<path d="M94 44L110 4h8l16 40h-8.5L114 14l-11.5 30z"/>'
    + '</g>'
    + '<path d="M114 27.5l6.4 16.5h-12.8z" fill="url(#' + g + ')"/>'
    + '</svg>';
}

// Full lockup node: emblem + MCA + "MIDDLE EAST COMBAT ARENA".
export function brandLockup(size) {
  const root = document.createElement('div');
  root.className = 'brand brand-' + (size || 'lg');
  root.innerHTML = '<span class="brand-emblem">' + emblemSvg() + '</span>'
    + '<span class="brand-type">' + logotypeSvg()
    + '<span class="brand-sub">Middle East Combat Arena</span>'
    + '<span class="brand-rule" aria-hidden="true"></span></span>';
  return root;
}

// ---- faction crests ------------------------------------------------------------------
// frame: plate outline (64x64 box). motif(m): line-work drawn in colour m.
const S = (d, w, extra) => '<path d="' + d + '" fill="none" stroke="{m}" stroke-width="' + (w || 3.5)
  + '" stroke-linejoin="miter" stroke-linecap="butt"' + (extra || '') + '/>';
const F = (d) => '<path d="' + d + '" fill="{m}"/>';

const CRESTS = {
  // Depth / mix — three echelons stacked in depth
  Egypt: {
    frame: 'M32 3L57 17.5V46.5L32 61L7 46.5V17.5Z',
    motif: S('M19.5 27.5L32 17l12.5 10.5', 4) + S('M19.5 37.5L32 27l12.5 10.5', 4)
      + S('M19.5 47.5L32 37l12.5 10.5', 4),
  },
  // Altitude / quality — a delta climbing over twin horizon arcs
  Saudi: {
    frame: 'M9 6H55V33C55 46 45 55 32 61C19 55 9 46 9 33Z',
    motif: F('M32 11.5L42.5 38 32 33 21.5 38Z') + S('M17 45.5Q32 37 47 45.5', 3)
      + S('M22.5 51.5Q32 46.5 41.5 51.5', 2.5),
  },
  // Scalpel / precision — a needle through a ranging ring
  UAE: {
    frame: 'M32 2L59 32L32 62L5 32Z',
    motif: '<circle cx="32" cy="32" r="10.5" fill="none" stroke="{m}" stroke-width="2.6"/>'
      + F('M32 10.5L35.2 32 32 53.5 28.8 32Z') + S('M14.5 32h6M43.5 32h6', 2.6),
  },
  // Weight / bubble — a heavy block under concentric defence domes
  Algeria: {
    frame: 'M21 4H43L60 21V43L43 60H21L4 43V21Z',
    motif: F('M20 39h24v10H20z') + S('M21.5 35A10.5 10.5 0 0 1 42.5 35', 3.4)
      + S('M13.5 35A18.5 18.5 0 0 1 50.5 35', 2.6),
  },
  // Drone mesh — linked nodes around a loitering delta
  Turkey: {
    frame: 'M32 3A29 29 0 1 0 32 61A29 29 0 1 0 32 3Z',
    motif: S('M32 15.5L16.5 43H47.5ZM32 15.5V27M16.5 43L27 36.5M47.5 43L37 36.5', 2.2)
      + '<circle cx="32" cy="15.5" r="3.6" fill="{m}"/><circle cx="16.5" cy="43" r="3.6" fill="{m}"/>'
      + '<circle cx="47.5" cy="43" r="3.6" fill="{m}"/>' + F('M32 26.5L38.5 39 32 36 25.5 39Z'),
  },
  // Shield + knife — a blade laid over a ward line
  Israel: {
    frame: 'M11 5H53Q55 5 55 7V32Q55 50 32 61Q9 50 9 32V7Q9 5 11 5Z',
    motif: S('M19 15.5V31.5Q19 43.5 32 50Q45 43.5 45 31.5V15.5', 2.4)
      + F('M32 10.5L36 36.5H28Z') + S('M24.5 39.5h15', 3.2) + S('M32 41v8', 3.4),
  },
  // Scale + reach — massed ranks under a long, flat missile track
  India: {
    frame: 'M14 5H50L59 14V50L50 59H14L5 50V14Z',
    motif: F('M14.5 44h6.5v8h-6.5zM24 39.5h6.5V52H24zM33.5 35h6.5v17h-6.5zM43 30.5h6.5V52H43z')
      + S('M13.5 29.5L44 15.5', 2.8) + F('M51 12.2L42.2 13 46 20.4Z'),
  },
  // First strike — twin chevrons breaking a line
  Pakistan: {
    frame: 'M7 6H57V37L32 61L7 37Z',
    motif: S('M17.5 16.5L29 28.5 17.5 40.5', 4.2) + S('M29.5 16.5L41 28.5 29.5 40.5', 4.2)
      + S('M48 14.5V38', 3.4),
  },
  // Swarm + rain — a wedge of darts above falling fire
  Iran: {
    frame: 'M9 60V29C9 15 21 8 32 3C43 8 55 15 55 29V60Z',
    motif: F('M32 12.5l4.4 7.6-4.4-2.2-4.4 2.2zM22.5 20.5l4.4 7.6-4.4-2.2-4.4 2.2zM41.5 20.5l4.4 7.6-4.4-2.2-4.4 2.2z'
      + 'M32 25l4.4 7.6-4.4-2.2-4.4 2.2z')
      + S('M21 39.5L17.5 51M29.5 39.5L26 51M38 39.5L34.5 51M46.5 39.5L43 51', 2.8, ' stroke-linecap="round"'),
  },
};

const GENERIC_FRAME = 'M32 3L57 17.5V46.5L32 61L7 46.5V17.5Z';

export function crestSvg(faction, color, cls) {
  const def = CRESTS[faction];
  const col = color || '#8a8f98';
  const lum = luminance(col);
  const motifCol = lum > 0.3 ? '#16110a' : '#f5f7fa';
  const g = uid('crest');
  const frame = def ? def.frame : GENERIC_FRAME;
  let motif;
  if (def) motif = def.motif.split('{m}').join(motifCol);
  else {
    const ch = String(faction || '?').slice(0, 1).toUpperCase();
    motif = '<text x="32" y="42" text-anchor="middle" font-family="Rajdhani, sans-serif" font-weight="700" font-size="30" fill="'
      + motifCol + '">' + ch.replace(/[<&>]/g, '') + '</text>';
  }
  return '<svg class="crest' + (cls ? ' ' + cls : '') + '" viewBox="0 0 64 64" role="img" aria-label="'
    + String(faction || '').replace(/["<>&]/g, '') + ' crest">'
    + '<defs><linearGradient id="' + g + '" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="' + shade(col, 0.26) + '"/>'
    + '<stop offset=".55" stop-color="' + col + '"/>'
    + '<stop offset="1" stop-color="' + shade(col, -0.42) + '"/>'
    + '</linearGradient></defs>'
    + '<path d="' + frame + '" fill="url(#' + g + ')" stroke="rgba(5,7,10,.9)" stroke-width="3.2" stroke-linejoin="round" paint-order="stroke"/>'
    + '<path d="' + frame + '" fill="none" stroke="rgba(255,255,255,.38)" stroke-width="1.1" stroke-linejoin="round" transform="translate(32 32) scale(.9) translate(-32 -32)"/>'
    + motif + '</svg>';
}

// crest element; game data supplies the colour
export function crest(data, faction, cls) {
  const f = data && data.factions ? data.factions[faction] : null;
  const span = document.createElement('span');
  span.className = 'crest-wrap' + (cls ? ' ' + cls : '');
  span.innerHTML = crestSvg(faction, f ? f.color : null);
  return span;
}

export function factionColor(data, faction) {
  const f = data && data.factions ? data.factions[faction] : null;
  return f ? f.color : '#8a8f98';
}

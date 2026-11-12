// Interface scale. The whole DOM interface (menus, HUD, tooltips, store) is
// authored in rem with 1rem = 10 design px, so one number on <html> sizes all
// of it: font-size = 10px × scale. Nothing is CSS-zoomed or transformed, so
// every element still reports real viewport pixels — pointer maths in the
// minimap, tooltips, cursor label and the world canvases is unaffected, and
// #game / #ui-overlay (sized in px by main.js) do not scale at all.
//
// A scaled interface is laid out exactly like the unscaled design in a
// smaller window ("layout viewport" = real viewport ÷ scale). The stylesheets'
// compact-layout breakpoints therefore cannot be @media queries (those only
// see real pixels); they are classes on <html> — .vw-1560, .vh-880, … —
// which this module sets from the layout viewport.
//
//   auto   scale so the layout viewport is about 1480 × 720 design px:
//          1.00 on a 1366×768 laptop, ~1.30 on a maximised 1080p browser,
//          ~1.75 at 1440p, ~2.6 at 4K. Never below 1 (today's size).
//   fixed  Small 100 %, Medium 125 %, Large 150 %, Extra large 175 % — and on
//          big monitors Large / Extra large are at least 15 % / 30 % above
//          the automatic size, so they always mean "bigger than Auto".
//          Capped so the layout viewport never drops under 1200 × 600 (the
//          smallest size the compact layouts hold).
import { lsGet, lsSet } from './dom.js';

const K_SCALE = 'mca.ui.scale';

export const UI_SCALE_OPTIONS = [
  { id: 'auto', label: 'Auto', scale: 0 },
  { id: 'small', label: 'Small', scale: 1 },
  { id: 'medium', label: 'Medium', scale: 1.25 },
  { id: 'large', label: 'Large', scale: 1.5, rel: 1.15 },
  { id: 'xlarge', label: 'Extra large', scale: 1.75, rel: 1.3 },
];

const AUTO_W = 1480, AUTO_H = 720;   // layout viewport the automatic scale aims for
const MIN_W = 1200, MIN_H = 600;     // smallest layout viewport a fixed size may produce
const MAX_SCALE = 4;
const STEP = 0.05;
// breakpoints used by the stylesheets (base/menu/hud/overlays.css)
const BREAK_W = [1560, 1180, 820];
const BREAK_H = [880, 820, 700, 660];

const round = (v) => Math.round(v / STEP + 1e-6) * STEP;
const floor = (v) => Math.floor(v / STEP + 1e-6) * STEP;
const tidy = (v) => Math.round(v * 100) / 100;

export function autoUiScale(vw, vh) {
  const s = round(Math.min(vw / AUTO_W, vh / AUTO_H));
  return tidy(Math.max(1, Math.min(MAX_SCALE, s)));
}

// the largest scale this window can take without squeezing the layouts
export function maxUiScale(vw, vh) {
  const s = floor(Math.min(vw / MIN_W, vh / MIN_H));
  return tidy(Math.max(1, Math.min(MAX_SCALE, s)));
}

export function getUiScalePref() {
  const v = lsGet(K_SCALE, 'auto');
  return UI_SCALE_OPTIONS.some((o) => o.id === v) ? v : 'auto';
}

// what a fixed option asks for in this window, before the fit cap
function wantedUiScale(opt, vw, vh) {
  return tidy(Math.max(opt.scale, opt.rel ? round(autoUiScale(vw, vh) * opt.rel) : 0));
}

export function resolveUiScale(pref, vw, vh) {
  const opt = UI_SCALE_OPTIONS.find((o) => o.id === pref);
  if (!opt || !opt.scale) return autoUiScale(vw, vh);
  return tidy(Math.min(wantedUiScale(opt, vw, vh), maxUiScale(vw, vh)));
}

let __scale = 1;
export function getUiScale() { return __scale; }

function viewport() {
  const w = globalThis.innerWidth, h = globalThis.innerHeight;
  return { w: w > 0 ? w : 1280, h: h > 0 ? h : 720 };
}

// Apply the saved preference to the document. Safe to call at any time and
// from any environment (no-ops without a DOM).
export function applyUiScale() {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root || !root.style || !root.classList) return __scale;
  const vp = viewport();
  const s = resolveUiScale(getUiScalePref(), vp.w, vp.h);
  __scale = s;
  try {
    if (typeof root.style.setProperty === 'function') root.style.setProperty('--ui-scale', String(s));
    // layout viewport in design px (the epsilon absorbs float error in w / s)
    const lw = vp.w / s - 0.01, lh = vp.h / s - 0.01;
    for (const b of BREAK_W) root.classList.toggle('vw-' + b, lw <= b);
    for (const b of BREAK_H) root.classList.toggle('vh-' + b, lh <= b);
  } catch (e) { /* headless harness */ }
  return s;
}

export function setUiScalePref(id) {
  lsSet(K_SCALE, UI_SCALE_OPTIONS.some((o) => o.id === id) ? id : 'auto');
  return applyUiScale();
}

// One line for the settings screen: what the choice amounts to right now.
export function describeUiScale() {
  const vp = viewport();
  const pref = getUiScalePref();
  const opt = UI_SCALE_OPTIONS.find((o) => o.id === pref) || UI_SCALE_OPTIONS[0];
  const pct = Math.round(__scale * 100) + '%';
  if (!opt.scale) return 'Fitted to this window: ' + pct + '.';
  const want = wantedUiScale(opt, vp.w, vp.h);
  if (__scale + 1e-6 < want) {
    return pct + ' — the most this window can hold (' + Math.round(want * 100)
      + '% needs a larger window or full screen, F11).';
  }
  return pct + (opt.scale === 1 ? ' — the original compact size.' : '.');
}

// self-initialise: the scale must be in place before the first screen is built
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    applyUiScale();
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', applyUiScale);
  } catch (e) { /* headless harness */ }
}

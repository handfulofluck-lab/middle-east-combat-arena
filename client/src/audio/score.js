// The score, as data. Key of D throughout; the home mode is D Hijaz
// (Phrygian dominant: D Eb F# G A Bb C), with D Kurd (Phrygian, F natural)
// for tension and G Nahawand (G harmonic minor — the same pitch set as D
// Hijaz, heard from its fourth degree) for the lament. Everything is 12-TET.
//
// Melodic lines are written in a compact text notation:
//   NOTE:DUR   DUR in eighth notes (0.5 = a sixteenth);  r:DUR is a rest
//   suffixes   ~ slur into the next note   ^ accent   ' staccato
//              t tremolo (re-plucked)      g grace note from above
//   |          bar line (4/4: every bar adds up to 8)
// Drum patterns are 16-character strings, one character per sixteenth:
// upper case = accent, lower case = ghost, '.' = rest.

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function midiOf(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) return 60;
  return PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

// -> { bars, ev: [{ bar, step, m, d, slur, acc, stac, trem, grace }], at(bar, step) }
// step and d are in sixteenths; `at` returns the events starting on a step.
export function parseLine(src) {
  const ev = [];
  const index = new Map();
  let pos = 0, slurNext = false;
  for (const tok of src.split(/\s+/)) {
    if (!tok || tok === '|') continue;
    const m = /^([A-Gr][#b]?-?\d?):([\d.]+)([~^'tg]*)$/.exec(tok);
    if (!m) continue;
    const d = Math.max(1, Math.round(Number(m[2]) * 2));
    if (m[1] !== 'r') {
      const fl = m[3];
      const e = {
        bar: Math.floor(pos / 16), step: pos % 16, m: midiOf(m[1]), d,
        slur: slurNext, acc: fl.indexOf('^') >= 0, stac: fl.indexOf("'") >= 0,
        trem: fl.indexOf('t') >= 0, grace: fl.indexOf('g') >= 0,
      };
      slurNext = fl.indexOf('~') >= 0;
      ev.push(e);
      const k = e.bar * 16 + e.step;
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(e);
    } else {
      slurNext = false;
    }
    pos += d;
  }
  const bars = Math.max(1, Math.ceil(pos / 16));
  return { bars, steps: pos, ev, at: (bar, step) => index.get(bar * 16 + step) };
}

// ---- harmony --------------------------------------------------------------------------
// root: bass note; pad: mid-register voicing (D pedal kept low where it can
// be); high: upper voicing for tuttis; nb: the colour tone used by the
// pedal ostinato.
function chord(root, pad, high, nb) {
  return { root: midiOf(root), pad: pad.map(midiOf), high: high.map(midiOf), nb: midiOf(nb) };
}

export const CHORDS = {
  D: chord('D2', ['D3', 'A3', 'D4', 'F#4'], ['A4', 'D5', 'F#5'], 'Eb4'),
  D5: chord('D2', ['D3', 'A3', 'D4', 'A4'], ['A4', 'D5', 'A5'], 'Eb4'),
  Dsus: chord('D2', ['D3', 'G3', 'A3', 'D4'], ['G4', 'A4', 'D5'], 'G4'),
  Dm: chord('D2', ['D3', 'A3', 'D4', 'F4'], ['A4', 'D5', 'F5'], 'F4'),
  Eb: chord('Eb2', ['Eb3', 'Bb3', 'Eb4', 'G4'], ['G4', 'Bb4', 'Eb5'], 'G4'),
  Gm: chord('G2', ['D3', 'G3', 'Bb3', 'D4'], ['G4', 'Bb4', 'D5'], 'Bb4'),
  Cm: chord('C2', ['C3', 'G3', 'C4', 'Eb4'], ['G4', 'C5', 'Eb5'], 'Eb4'),
  Bb: chord('Bb1', ['D3', 'F3', 'Bb3', 'D4'], ['F4', 'Bb4', 'D5'], 'F4'),
};

// two chord slots per bar
const bars2 = (list) => list.reduce((a, c) => a.concat(Array.isArray(c) ? c : [c, c]), []);

// ---- the main theme ("The Arena") ------------------------------------------------------
// 8 bars. Head motif: a dotted rise of a fifth (D -> A), the Bb upper
// neighbour, then the Hijaz descent G F# Eb D with its augmented second.
// Bars 5-6 sequence the motif up a fourth and climb to the high tonic; bars
// 7-8 fall from Eb5 through the cadence bII -> I.
export const THEME = parseLine(
  'D4:3^ A4:1 A4:2 Bb4:1 A4:1 | G4:1 F#4:1 Eb4:2 D4:4 | '
  + 'D4:3^ A4:1 A4:2 C5:1 Bb4:1 | A4:2 G4:1 A4:1 F#4:4 | '
  + 'G4:3^ Bb4:1 Bb4:2 A4:1 G4:1 | F#4:1 G4:1 A4:2 D5:4^ | '
  + 'Eb5:3^ D5:1 C5:2 Bb4:1 A4:1 | G4:1 F#4:1 Eb4:2 D4:4');
export const THEME_CHORDS = bars2(['D', ['Eb', 'D'], 'D', ['Gm', 'D'], 'Gm', 'D',
  ['Eb', 'Cm'], ['Eb', 'D']]);

// the theme cut into its four 2-bar phrases (menu / calm fragments)
export const THEME_PARTS = [
  parseLine('D4:3^ A4:1 A4:2 Bb4:1 A4:1 | G4:1 F#4:1 Eb4:2 D4:4'),
  parseLine('D4:3^ A4:1 A4:2 C5:1 Bb4:1 | A4:2 G4:1 A4:1 F#4:4'),
  parseLine('G4:3^ Bb4:1 Bb4:2 A4:1 G4:1 | F#4:1 G4:1 A4:2 D5:4'),
  parseLine('Eb5:3^ D5:1 C5:2 Bb4:1 A4:1 | G4:1 F#4:1 Eb4:2 D4:4'),
];

// ---- title ---------------------------------------------------------------------------------
export const INTRO_NEY = parseLine(
  'D5:6~ A5:2~ | A5:4~ Bb5:1~ A5:3 | r:2 G5:2~ F#5:2~ Eb5:2~ | D5:8');
export const BRIDGE_NEY = parseLine(
  'D5:4~ G5:4 | G5:2~ Bb5:2~ A5:2~ G5:2 | Eb5:4~ G5:4 | F#5:6~ A5:2');
export const BRIDGE_CHORDS = bars2(['Gm', 'Eb', 'Cm', 'D']);
// counter-line under the last statement (violas, a sixth / third below)
export const THEME_COUNTER = parseLine(
  'F#3:8 | G3:4 F#3:4 | F#3:8 | G3:4 A3:4 | Bb3:8 | A3:4 F#3:4 | G3:4 Eb3:4 | Eb3:4 F#3:4');

// ---- phrase pools ----------------------------------------------------------------------------
// 2-bar oud phrases for the calm tracks. The first four are the theme itself.
export const MENU_PHRASES = THEME_PARTS.concat([
  parseLine('r:2 A3:1 D4:1 Eb4:2 D4:2 | r:8'),
  parseLine('D4:1 Eb4:1 F#4:2 G4:1 F#4:1 Eb4:2 | D4:6 r:2'),
  parseLine('A3:2 C4:1 Bb3:1 A3:4 | r:8'),
  parseLine('r:4 D5:1 C5:1 Bb4:1 A4:1 | G4:1 F#4:1 Eb4:2 D4:4'),
  parseLine('D3:4 r:2 A3:1 D4:1 | Eb4:3 D4:5'),
  parseLine('G4:1 A4:1 Bb4:2 A4:1 G4:1 F#4:2 | G4:2 A4:6'),
]);
export const NEY_PHRASES = [
  parseLine('D5:4~ A5:4~ | A5:2~ Bb5:1~ A5:1~ G5:4'), // the head motif, augmented
  parseLine('A5:6~ G5:1~ F#5:1~ | Eb5:2~ D5:6'),
  parseLine('D5:2~ Eb5:2~ F#5:4~ | G5:2~ F#5:1~ Eb5:1~ D5:4'),
  parseLine('C6:4~ Bb5:2~ A5:2~ | A5:8'),
  parseLine('r:4 A5:2~ Bb5:2~ | A5:3~ G5:1~ F#5:4'),
];
export const MENU_PROGS = [
  bars2(['D', 'D', 'Cm', 'D', 'Gm', 'Gm', 'Eb', 'D']),
  bars2(['D', 'Eb', 'D', 'Cm', 'Gm', 'Eb', 'Cm', 'D']),
  bars2(['D5', 'Gm', 'D', 'Eb', 'Gm', 'D', ['Eb', 'Cm'], 'D']),
];

// sparse low-register oud figures for quiet stretches of a match
export const COMBAT_PHRASES = [
  THEME_PARTS[0],
  parseLine('D3:2 r:2 D3:1 Eb3:1 D3:2 | r:8'),
  parseLine('r:2 A3:1 D4:1 Eb4:2 D4:2 | r:4 C4:1 Bb3:1 A3:2'),
  parseLine("D4:1' r:1 D4:1' Eb4:1 D4:2 r:2 | r:8"),
  parseLine('A3:3 Bb3:1 A3:2 G3:2 | F#3:2 Eb3:2 D3:4'),
  parseLine('r:4 D4:1 F4:1 Eb4:1 D4:1 | C4:2 D4:6'), // Kurd colour (F natural)
  parseLine('D4:2 A4:2 G4:1 F#4:1 Eb4:2 | D4:8'),
];
export const COMBAT_NEY = [
  parseLine('D5:8~ | A5:4~ Bb5:1~ A5:3'),
  parseLine('A5:6~ G5:1~ F#5:1~ | Eb5:2~ D5:6'),
  parseLine('r:4 D5:2~ Eb5:2~ | D5:8'),
];
export const COMBAT_A = bars2(['D5', 'D5', 'Eb', 'D5', 'D5', 'D5', 'Cm', 'D5']);
export const COMBAT_A2 = bars2(['D5', 'D5', 'Eb', 'D5', 'Gm', 'Gm', ['Eb', 'Cm'], 'D']);
export const COMBAT_B = bars2(['Gm', 'Gm', 'D', 'D', 'Eb', 'Cm', 'D', 'D']);
export const COMBAT_A3 = bars2(['D5', 'D5', 'Eb', 'D5', 'D5', 'Cm', 'Eb', 'D']);
// brass answers in the B section (long tones over Gm | D | Eb Cm | D)
export const COMBAT_B_BRASS = parseLine(
  'G3:8 | Bb3:6 A3:2 | A3:8 | F#3:6 r:2 | G3:8 | G3:4 Eb3:4 | F#3:8 | D3:6 r:2');

// ---- briefing (D Kurd) -------------------------------------------------------------------------
export const BRIEF_A = bars2(['D5', 'D5', 'Eb', 'D5', 'Cm', 'Cm', 'Eb', 'D5']);
export const BRIEF_B = bars2(['D5', 'D5', 'Gm', 'Gm', 'Eb', 'Eb', 'Cm', 'D5']);
export const BRIEF_LINE = parseLine(
  "D4:1' r:1 D4:1' Eb4:1 D4:2 r:2 | r:4 A3:1 C4:1 D4:2 | "
  + "G4:1' r:1 G4:1' A4:1 Bb4:2 A4:2 | G4:2 F4:2 Eb4:2 D4:2 | "
  + "Eb4:1' r:1 Eb4:1' F4:1 G4:2 r:2 | r:4 G4:1 F4:1 Eb4:2 | "
  + "C4:1' r:1 C4:1' D4:1 Eb4:2 D4:2 | D4:8");

// ---- victory / defeat ----------------------------------------------------------------------------
// fanfare: the head motif opened out to a rising fifth + octave, the theme's
// second half, and a final leap A -> D that resolves upward instead of falling
export const FANFARE = parseLine(
  'D4:2^ A4:2 D5:4^ | Bb4:3 A4:1 G4:2 Bb4:2 | Eb5:3^ D5:1 Bb4:2 G4:2 | A4:2 F#4:2 A4:4 | '
  + 'G4:3^ Bb4:1 Bb4:2 A4:1 G4:1 | F#4:1 G4:1 A4:2 D5:4^ | '
  + 'Eb5:3^ D5:1 C5:2 Bb4:1 A4:1 | D5:8^');
export const FANFARE_CHORDS = bars2(['D', 'Gm', 'Eb', 'D', 'Gm', 'D', ['Eb', 'Cm'], 'D', 'D', 'D']);
export const CALM_CHORDS = bars2(['D', 'D', 'Gm', 'D', 'Eb', 'D', ['Cm', 'Eb'], 'D']);
// lament: the theme's cadence (G F# Eb D) in augmentation, on duduk
export const LAMENT = parseLine(
  'D4:6~ Eb4:2~ | D4:2~ C4:2~ Bb3:4 | C4:2~ Eb4:2~ G4:2~ F#4:2~ | Eb4:3~ D4:5');
export const LAMENT_CHORDS = bars2(['Gm', 'Eb', 'Cm', 'D5', 'D5', 'D5']);

// ---- rhythm -----------------------------------------------------------------------------------
// darbuka: D dum, T tek, K ka, S slap
export const RHYTHM = {
  maqsum: 'D.T.k.T.D.k.T.k.',
  maqsum2: 'D.T.kkT.D.k.T.tk',
  baladi: 'D.D.k.T.D.k.T.k.',
  saidi: 'D.T.k.D.D.k.T.k.',
  malfuf: 'D.kT.kT.D.kT.kT.',
  ayoub: 'D..kD.T.D..kD.T.',
  fillA: 'D.T.k.T.DkTkDkTk',
  fillB: 'TkTkD.D.TkTkTkD.',
  ticks: '..k...k...k..Tk.',
  // frame drum: D low stroke, T rim
  frameSoft: 'D.......T.....t.',
  frameMaq: 'D...T...D.D.T...',
  heartbeat: 'D.d.............',
  // single-voice patterns: X accent, x ghost
  taiko1: 'X.....x...X.x...',
  taiko2: 'X..x..x.X..x..x.',
  taiko3: 'X.x.X..xX.x.X.xx',
  taikoFill: 'x.x.x.x.xxxxXXXX',
  taikoBuild1: 'X...X...X...X...',
  taikoBuild2: 'X.X.X.X.XxXxXXXX',
  taikoSlow: 'X.........x.....',
  snareBack: '....X.......X...',
  snareMarch: 'X..xx.X.x.x.X.xx',
  snareRoll: 'x.x.xxx.x.xxxxxx',
  riqOff: '..x...x...x...x.',
  riq8: 'x.X.x.X.x.X.x.X.',
  riq16: 'x.xXx.xXx.xXx.xX',
  tick8: 'X.x.x.x.X.x.x.x.',
  tick16: 'X.x.x.x.X.x.x.xx',
  pulse332: 'X.x.x.X.x.x.X.x.',
  pulse16: 'XxxxxxXxxxxxXxxx',
  bassA: 'X.....x.x.......',
  bassDrive: 'X..x..x.X..x..x.',
  bassHalf: 'X.......x.......',
  stab1: 'X..X..X.........',
  stab2: 'L...........X.X.',
  stab3: 'X.....X...X.....',
  timpA: 'X.............x.',
  timpEnd: 'X.....X...X.X.X.',
  boom1: 'X...............',
};

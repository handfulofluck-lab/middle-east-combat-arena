// Peace timer HUD: a countdown chip under the top bar while the opening
// ceasefire holds, an announcement when it starts and when it ends.
// The rule itself lives in the simulation (state.peaceUntil, isHostile).
import { peaceTicksLeft } from '../sim/index.js';
import { showHint } from './hud.js';
import * as Audio from './audio.js';

function fmt(ticks) {
  const s = Math.ceil(ticks / 10);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

function chipEl() {
  let chip = document.getElementById('peace-chip');
  if (chip) return chip;
  const host = document.getElementById('hud-topcenter');
  if (!host) return null;
  chip = document.createElement('div');
  chip.id = 'peace-chip';
  chip.className = 'hidden';
  chip.setAttribute('role', 'timer');
  const label = document.createElement('span');
  label.className = 'pc-label';
  label.textContent = 'Ceasefire';
  const time = document.createElement('span');
  time.className = 'pc-time num';
  const note = document.createElement('span');
  note.className = 'pc-note';
  note.textContent = 'no attacks yet';
  chip.appendChild(label);
  chip.appendChild(time);
  chip.appendChild(note);
  host.insertBefore(chip, host.firstChild);
  return chip;
}

function say(game, key) {
  try {
    const st = game.state;
    const p = st && st.players ? st.players[game.playerSlot | 0] : null;
    if (typeof Audio.playVoice === 'function') Audio.playVoice(game, p ? p.faction : '', key);
  } catch (e) { /* optional */ }
}

export function updatePeace(game) {
  if (typeof document === 'undefined' || !game) return;
  const st = game.state;
  const chip = chipEl();
  if (!chip) return;
  const P = game._peace || (game._peace = { st: null, active: false, seenPeace: false, text: '' });
  if (P.st !== st) { P.st = st; P.active = false; P.seenPeace = false; P.text = ''; }
  const left = st && !st.over ? peaceTicksLeft(st) : 0;
  if (left > 0) {
    // hold the announcement until the intro flyover has handed over the HUD
    // (the sim is held at tick 0 behind the loading veil and during the intro)
    const cine = !!(game.cinema && game.cinema.active) || !!game.worldPending || st.tick < 2;
    if (!P.active && !cine) {
      P.active = true;
      const min = Math.round(st.peaceUntil / 600);
      showHint(game, 'Ceasefire for ' + min + (min === 1 ? ' minute' : ' minutes')
        + ' — nobody can attack. Build your base and your army.');
      say(game, 'peaceStart');
    }
    const text = fmt(left);
    if (text !== P.text) {
      P.text = text;
      chip.querySelector('.pc-time').textContent = text;
      chip.classList.toggle('ending', left <= 300);
    }
    chip.classList.remove('hidden');
    P.seenPeace = true;
  } else {
    if (P.active || (st && st.peaceUntil > 0 && P.seenPeace)) {
      P.active = false; P.seenPeace = false;
      if (st && !st.over) {
        showHint(game, 'The ceasefire is over — weapons free.');
        say(game, 'peaceEnd');
      }
    }
    chip.classList.add('hidden');
  }
}

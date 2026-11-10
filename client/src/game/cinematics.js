// In-engine cinematics. Nothing here is pre-rendered: the title sequence and
// the menu backdrop are a live AI-vs-AI battle filmed by an automatic
// director, the match intro is a keyframed flyover of the real battlefield,
// and the outro orbits the final scene. All of it drives the one renderer.
import * as Sim from '../sim/index.js';
import { initGl, setWorld, updateCamera, wuToX, wuToZ } from '../gfx/engine.js';
import { CELL, S, clamp, lerp, damp, angleDelta, mulberry32 } from '../gfx/util.js';
import * as Audio from './audio.js';
import '../styles/cine.css';

const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const ease = (t) => { const x = clamp(t, 0, 1); return 1 - Math.pow(1 - x, 3); };
const audio = (fn, ...a) => { try { if (typeof Audio[fn] === 'function') return Audio[fn](...a); } catch (e) { /* audio is optional */ } return undefined; };

// ---------------------------------------------------------------------------
// overlay DOM
// ---------------------------------------------------------------------------
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function ensureDom(c) {
  if (c.dom) return c.dom;
  const root = el('div', 'cine hidden');
  root.id = 'cine';
  const title = el('div', 'cine-title', `
    <div class="cine-title-rule"></div>
    <div class="cine-logo" aria-label="MCA"><span>M</span><span>C</span><span>A</span></div>
    <div class="cine-logo-sub">MIDDLE EAST COMBAT ARENA</div>
    <div class="cine-title-rule"></div>
    <div class="cine-prompt">PRESS ANY KEY</div>`);
  const card = el('div', 'cine-card', `
    <div class="cine-kicker"></div>
    <div class="cine-h1"></div>
    <div class="cine-h2"></div>`);
  const verdict = el('div', 'cine-verdict', '<div class="cine-verdict-text"></div><div class="cine-verdict-sub"></div>');
  const skip = el('div', 'cine-skip', '<kbd>SPACE</kbd> SKIP');
  root.append(title, card, verdict, skip);
  document.body.appendChild(root);
  c.dom = { root, title, card, verdict, skip };
  return c.dom;
}

function show(node, on) { node.classList.toggle('on', !!on); }

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
export function initCinematics(game) {
  if (game.cinema && game.cinema._installed) return game.cinema;
  const c = game.cinema || {};
  Object.assign(c, {
    _installed: true, active: false, kind: null, t: 0, holdSim: false,
    menu: { active: false }, attract: null, director: null, onDone: null,
    letterbox: 0, fade: 0, fadeTarget: 0, letterTarget: 0,
  });
  game.cinema = c;
  if (typeof document !== 'undefined') {
    ensureDom(c);
    const skipNow = (e) => {
      if (!c.active) return;
      if (c.kind === 'title') { if (c.t > 1.2) finishTitle(game); return; }
      if (e && e.type === 'keydown' && !(e.code === 'Space' || e.code === 'Escape' || e.code === 'Enter')) return;
      skipCinematic(game);
    };
    window.addEventListener('keydown', skipNow, true);
    c.dom.root.addEventListener('pointerdown', skipNow);
  }
  return c;
}

export function isCinematicActive(game) {
  return !!(game && game.cinema && game.cinema.active);
}

// ---------------------------------------------------------------------------
// attract mode: a real match the menus sit on top of
// ---------------------------------------------------------------------------
const ATTRACT_PAIRS = [['Egypt', 'Israel'], ['Turkey', 'Iran'], ['Saudi', 'Algeria'], ['India', 'Pakistan'], ['UAE', 'Iran'], ['Israel', 'Turkey']];

function pickAttractMap(game, rnd) {
  const ids = Object.keys(game.maps);
  const good = ids.filter((id) => {
    const m = game.maps[id];
    return m && m.spawns && m.spawns.length >= 2 && m.spawns.length <= 4 && m.w <= 180;
  });
  const pool = good.length ? good : ids;
  return pool[Math.floor(rnd() * pool.length)];
}

function createAttract(game) {
  const c = game.cinema;
  const seed = ((c.attractSeed = (c.attractSeed || (Date.now() & 0xffff)) + 7919) >>> 0);
  const rnd = mulberry32(seed);
  const mapId = (game.attractMap && game.maps[game.attractMap]) ? game.attractMap : pickAttractMap(game, rnd);
  const map = game.maps[mapId];
  const pair = ATTRACT_PAIRS[Math.floor(rnd() * ATTRACT_PAIRS.length)];
  const n = Math.min(map.spawns.length, 2 + (rnd() < 0.35 && map.spawns.length >= 4 ? 2 : 0));
  const facs = Object.keys(game.data.factions);
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({
      slot: i, team: i % 2,
      faction: i < 2 ? pair[i] : facs[Math.floor(rnd() * facs.length)],
      ai: { personality: 'Front', difficulty: 'elite' },
    });
  }
  const state = Sim.createMatch({ data: game.data, map, players, seed });
  const ai = Sim.createAI(players, seed);
  return { state, ai, mapId, acc: 0, preroll: 2300, born: 0 };
}

export function startMenuCinematic(game) {
  const c = game.cinema || initCinematics(game);
  if (c.menu.active && c.attract) return true;
  if (!c.attract || c.attract.state.over) c.attract = createAttract(game);
  const a = c.attract;
  // pre-roll so the first frame already shows bases and armies
  if (a.preroll > 0) {
    const n = a.preroll;
    for (let i = 0; i < n && !a.state.over; i++) Sim.tick(a.state, Sim.aiCommands(a.state, a.ai));
    a.preroll = 0;
  }
  const gl = initGl(game, { state: a.state, reveal: true, localSlot: 0 });
  gl.attract = true;
  gl.camLock = true;
  gl.lookLift = 0;
  game.attract = a;
  c.menu.active = true;
  c.director = createDirector(game);
  c.fade = 1; c.fadeTarget = 0;
  if (gl.portraits && !c.portraitsQueued) { c.portraitsQueued = true; gl.portraits.requestAll(a.state, 0); }
  return true;
}

export function stopMenuCinematic(game) {
  const c = game.cinema;
  if (!c || !c.menu.active) return;
  c.menu.active = false;
  c.director = null;
  game.attract = null;
  const gl = game.gl;
  if (gl) { gl.attract = false; gl.camLock = false; gl.lookLift = 0; }
}

function tickAttract(game, dtMs) {
  const a = game.attract;
  if (!a) return;
  a.acc += dtMs;
  let steps = 0;
  while (a.acc >= 100 && steps < 3 && !a.state.over) {
    Sim.tick(a.state, Sim.aiCommands(a.state, a.ai));
    a.acc -= 100; steps++;
  }
  if (steps === 3) a.acc = 0;
  // a finished (or very long) battle is replaced by a fresh one
  if (a.state.over || a.state.tick > 9000) {
    const c = game.cinema;
    c.attract = createAttract(game);
    c.menu.active = false;
    startMenuCinematic(game);
  }
}

// ---------------------------------------------------------------------------
// the director: picks subjects and frames them
// ---------------------------------------------------------------------------
function createDirector(game) {
  const gl = game.gl;
  const rnd = mulberry32(((game.cinema.attractSeed || 1) * 31 + 17) >>> 0);
  const cam = { x: gl.focus.x, z: gl.focus.z, dist: 70, yaw: 0.6, pitch: 0.5, lift: 0 };
  let shot = null, shotN = 0;

  function unitsWhere(pred) {
    const out = [];
    for (const [id, rec] of gl.ents.units) {
      const u = gl.state.units[id];
      if (u && pred(u, rec)) out.push(rec);
    }
    return out;
  }

  function baseCentre(slot) {
    // straight from the sim, so it works before the first frame has synced
    let x = 0, z = 0, n = 0;
    const st = gl.state;
    for (const id in st.structures) {
      const s = st.structures[id];
      if (s.owner !== slot) continue;
      x += wuToX(gl, (s.cx + s.fp / 2) * CELL); z += wuToZ(gl, (s.cy + s.fp / 2) * CELL); n++;
    }
    return n ? { x: x / n, z: z / n, n } : null;
  }

  function nextShot() {
    shotN++;
    const fighting = unitsWhere((u) => u.order && (u.order.enemyId || u.order.type === 'attackTarget'));
    const movers = unitsWhere((u, r) => !r.inf && !r.air && r.speed > 2);
    const flyers = unitsWhere((u, r) => r.air && r.speed > 3);
    const options = [];
    if (fighting.length >= 3) options.push('battle', 'battle', 'battle');
    if (movers.length) options.push('follow', 'follow');
    if (flyers.length) options.push('air');
    options.push('base');
    if (shotN % 6 === 0) options.push('vista');
    let kind = options[Math.floor(rnd() * options.length)];
    if (shot && shot.kind === kind && options.length > 2) kind = options[Math.floor(rnd() * options.length)];
    // open on something with presence: a fight if there is one, else a base
    if (shotN === 1) kind = fighting.length >= 3 ? 'battle' : 'base';
    const s = { kind, t: 0, dur: 9 + rnd() * 5, dir: rnd() < 0.5 ? -1 : 1, yaw0: rnd() * 6.283 };
    if (kind === 'battle') {
      // densest knot of fighting
      const pick = fighting[Math.floor(rnd() * fighting.length)];
      let x = 0, z = 0, n = 0;
      for (const r of fighting) {
        const d = Math.hypot(r.root.position.x - pick.root.position.x, r.root.position.z - pick.root.position.z);
        if (d < 26) { x += r.root.position.x; z += r.root.position.z; n++; }
      }
      s.x = x / n; s.z = z / n; s.dist = 30 + Math.min(22, n * 1.6); s.pitch = 0.3 + rnd() * 0.16;
    } else if (kind === 'follow' || kind === 'air') {
      const list = kind === 'air' ? flyers : movers;
      s.rec = list[Math.floor(rnd() * list.length)];
      s.dist = kind === 'air' ? 20 : 15 + rnd() * 8; s.pitch = kind === 'air' ? 0.12 : 0.2 + rnd() * 0.14;
      s.side = (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.5);
      s.dur = 8 + rnd() * 4;
    } else if (kind === 'base') {
      const slots = gl.state.players.map((p) => p.slot);
      const b = baseCentre(slots[Math.floor(rnd() * slots.length)]) || baseCentre(0) || { x: 0, z: 0 };
      s.x = b.x; s.z = b.z; s.dist = 44 + rnd() * 16; s.pitch = 0.34 + rnd() * 0.16;
    } else {
      // a wide establishing shot over land (never open water)
      s.x = 0; s.z = 0;
      for (let k = 0; k < 12; k++) {
        const x = (rnd() - 0.5) * gl.halfX * 1.4, z = (rnd() - 0.5) * gl.halfZ * 1.4;
        if (gl.hf.waterDist(x, z) < -4) { s.x = x; s.z = z; break; }
      }
      s.dist = 100 + rnd() * 40; s.pitch = 0.32;
      s.dur = 10;
    }
    return s;
  }

  function goal(s, dt) {
    const g = { x: cam.x, z: cam.z, dist: s.dist, yaw: cam.yaw, pitch: s.pitch, lift: 0 };
    if (s.kind === 'follow' || s.kind === 'air') {
      const r = s.rec;
      if (!r || !gl.ents.units.has(r.id)) { s.t = s.dur; return g; }
      g.x = r.root.position.x; g.z = r.root.position.z;
      const hd = r.yaw + s.side * 0.9;
      g.yaw = Math.atan2(-Math.cos(hd), Math.sin(hd));
      g.lift = s.kind === 'air' ? r.root.position.y - gl.focus.y : 0.6;
    } else {
      g.x = s.x; g.z = s.z;
      g.yaw = s.yaw0 + s.dir * s.t * (s.kind === 'vista' ? 0.035 : 0.075);
      g.dist = s.dist * (1 - 0.1 * smooth(s.t / s.dur));
      g.lift = s.kind === 'battle' ? 1.2 : 0.8;
    }
    void dt;
    return g;
  }

  return {
    update(dt) {
      const c = game.cinema;
      if (!shot || shot.t >= shot.dur) {
        if (shot && c.fadeTarget === 0 && c.fade < 0.02) { c.fadeTarget = 1; return; }
        if (shot && c.fade < 0.97) return;      // wait for the dip to black
        shot = nextShot();
        const g = goal(shot, 0);
        Object.assign(cam, g);
        c.fadeTarget = 0;
      }
      shot.t += dt;
      const g = goal(shot, dt);
      const k = shot.kind === 'follow' || shot.kind === 'air' ? 2.2 : 3;
      cam.x = damp(cam.x, g.x, k * 2, dt); cam.z = damp(cam.z, g.z, k * 2, dt);
      cam.dist = damp(cam.dist, g.dist, k, dt);
      cam.yaw += angleDelta(cam.yaw, g.yaw) * (1 - Math.exp(-k * 0.6 * dt));
      cam.pitch = damp(cam.pitch, g.pitch, k, dt);
      cam.lift = damp(cam.lift, g.lift, 2, dt);
      gl.tFocus.x = cam.x; gl.tFocus.z = cam.z;
      gl.tDist = cam.dist; gl.tYaw = cam.yaw; gl.tPitch = cam.pitch;
      gl.lookLift = cam.lift;
    },
    cut() { if (shot) shot.t = shot.dur; },
  };
}

// ---------------------------------------------------------------------------
// title sequence (first boot)
// ---------------------------------------------------------------------------
export function playTitle(game, onDone) {
  const c = game.cinema || initCinematics(game);
  if (!game.gl || !c.menu.active) { if (onDone) onDone(); return; }
  c.active = true; c.kind = 'title'; c.t = 0; c.onDone = onDone;
  c.fade = 1; c.fadeTarget = 0; c.letterbox = 1; c.letterTarget = 1;
  const d = ensureDom(c);
  d.root.classList.remove('hidden');
  d.root.classList.add('title-mode');
  show(d.title, false); show(d.card, false); show(d.verdict, false); show(d.skip, false);
  audio('playMusicTrack', game, 'title');
  audio('playSfx', game, 'cinematic_riser');
  setTimeout(() => { if (c.kind === 'title') { show(d.title, true); audio('playSfx', game, 'cinematic_hit'); } }, 900);
}

function finishTitle(game) {
  const c = game.cinema;
  if (c.kind !== 'title') return;
  c.kind = 'title-out'; c.t = 0;
  c.letterTarget = 0;
  show(c.dom.title, false);
  audio('playSfx', game, 'ui_confirm');
}

// ---------------------------------------------------------------------------
// match intro
// ---------------------------------------------------------------------------
export function playIntro(game, info, onDone) {
  const c = game.cinema || initCinematics(game);
  const gl = game.gl;
  if (!gl || !gl.state) { if (onDone) onDone(); return; }
  const st = gl.state, map = st.map;
  const sp = map.spawns[(game.playerSlot || 0) % map.spawns.length];
  const bx = (sp.x + 0.5 - map.w / 2) * S, bz = (sp.y + 0.5 - map.h / 2) * S;
  // approach from the map centre side so the flyover crosses the battlefield
  const away = Math.atan2(bx, bz);
  const size = Math.max(map.w, map.h) * S;
  c.keys = [
    { t: 0.0, x: 0, z: 0, dist: Math.min(300, size * 0.62), yaw: away + 0.9, pitch: 0.95, lift: 0 },
    { t: 3.2, x: bx * 0.25, z: bz * 0.25, dist: Math.min(230, size * 0.46), yaw: away + 0.45, pitch: 0.7, lift: 0 },
    { t: 6.0, x: bx * 0.8, z: bz * 0.8, dist: 110, yaw: away + 0.12, pitch: 0.46, lift: 2 },
    { t: 8.6, x: bx, z: bz, dist: 50, yaw: 0.62, pitch: 0.78, lift: 0 },
  ];
  c.endCam = { x: bx, z: bz, dist: 50, yaw: 0.62, pitch: 0.78 };
  c.active = true; c.kind = 'intro'; c.t = 0; c.dur = 8.6; c.onDone = onDone || null;
  c.holdSim = true;
  c.fade = 1; c.fadeTarget = 0; c.letterbox = 1; c.letterTarget = 1;
  gl.camLock = true; gl.cineReveal = true;
  const d = ensureDom(c);
  d.root.classList.remove('hidden', 'title-mode');
  show(d.title, false); show(d.verdict, false);
  d.card.querySelector('.cine-kicker').textContent = (info && info.kicker) || 'OPERATION AREA';
  d.card.querySelector('.cine-h1').textContent = (info && info.mapName) || map.name || '';
  d.card.querySelector('.cine-h2').textContent = (info && info.vs) || '';
  show(d.card, false);
  setTimeout(() => { if (c.kind === 'intro') { show(d.card, true); show(d.skip, true); } }, 500);
  audio('playMusicTrack', game, 'briefing');
  audio('playSfx', game, 'cinematic_whoosh');
}

// ---------------------------------------------------------------------------
// outro
// ---------------------------------------------------------------------------
export function playOutro(game, info, onDone) {
  const c = game.cinema || initCinematics(game);
  const gl = game.gl;
  if (!gl) { if (onDone) onDone(); return; }
  c.active = true; c.kind = 'outro'; c.t = 0; c.dur = 6.2; c.onDone = onDone || null;
  c.orbit = { x: gl.focus.x, z: gl.focus.z, dist: clamp(gl.dist, 40, 80), yaw: gl.yaw, pitch: 0.42 };
  c.letterTarget = 1; c.fadeTarget = 0;
  gl.camLock = true; gl.cineReveal = true;
  const d = ensureDom(c);
  d.root.classList.remove('hidden', 'title-mode');
  show(d.title, false); show(d.card, false); show(d.skip, true);
  const won = !!(info && info.won);
  d.verdict.classList.toggle('won', won);
  d.verdict.classList.toggle('lost', !won);
  d.verdict.querySelector('.cine-verdict-text').textContent = won ? 'VICTORY' : 'DEFEAT';
  d.verdict.querySelector('.cine-verdict-sub').textContent = info && info.mapName ? info.mapName : '';
  setTimeout(() => { if (c.kind === 'outro') show(d.verdict, true); }, 350);
  audio('playMusicTrack', game, won ? 'victory' : 'defeat');
  audio('playSfx', game, 'cinematic_hit');
  if (gl.post) gl.post.final.material.uniforms.uFlash.value = won ? 0.5 : 0.15;
}

// ---------------------------------------------------------------------------
// control
// ---------------------------------------------------------------------------
function endCinematic(game, runDone) {
  const c = game.cinema;
  if (!c) return;
  const done = c.onDone;
  const kind = c.kind;
  c.active = false; c.kind = null; c.onDone = null; c.holdSim = false;
  c.letterTarget = 0; c.fadeTarget = 0;
  const gl = game.gl;
  if (gl) {
    gl.cineReveal = false;
    gl.lookLift = 0;
    if (!c.menu.active) gl.camLock = false;
    if (kind === 'intro' && c.endCam) {
      gl.tFocus.x = c.endCam.x; gl.tFocus.z = c.endCam.z;
      gl.tDist = c.endCam.dist; gl.tYaw = c.endCam.yaw; gl.tPitch = c.endCam.pitch;
      updateCamera(gl, 0);
      if (gl.proxy) gl.proxy.ready = false;
    }
  }
  if (c.dom) {
    show(c.dom.card, false); show(c.dom.skip, false); show(c.dom.title, false);
    if (kind !== 'outro') show(c.dom.verdict, false);
    setTimeout(() => { if (!c.active) { c.dom.root.classList.add('hidden'); show(c.dom.verdict, false); } }, kind === 'outro' ? 60 : 700);
  }
  if (kind === 'intro') {
    audio('playMusicTrack', game, 'ambient');
    audio('playStinger', game, 'match_start');
  }
  if (runDone && done) { try { done(); } catch (e) { if (typeof console !== 'undefined') console.error(e); } }
}

export function skipCinematic(game) {
  const c = game && game.cinema;
  if (!c || !c.active) return;
  if (c.kind === 'title') { finishTitle(game); return; }
  endCinematic(game, true);
}

export function cancelCinematics(game) {
  const c = game && game.cinema;
  if (!c) return;
  if (c.active) endCinematic(game, false);
  if (c.dom) { c.dom.root.classList.add('hidden'); show(c.dom.verdict, false); }
  c.letterbox = 0; c.letterTarget = 0;
}

function sampleKeys(keys, t) {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1];
  const k = smooth((t - a.t) / (b.t - a.t));
  return {
    x: lerp(a.x, b.x, k), z: lerp(a.z, b.z, k), dist: lerp(a.dist, b.dist, k),
    yaw: a.yaw + angleDelta(a.yaw, b.yaw) * k, pitch: lerp(a.pitch, b.pitch, k), lift: lerp(a.lift, b.lift, k),
  };
}

export function updateCinematics(game, dtMs) {
  const c = game && game.cinema;
  if (!c) return;
  const gl = game.gl;
  const dt = Math.max(0, Math.min(0.1, dtMs / 1000));
  if (c.menu.active) {
    tickAttract(game, dtMs);
    if (c.director) c.director.update(dt);
  }
  if (c.active) {
    c.t += dt;
    if (c.kind === 'title') {
      c.letterTarget = 1;
      if (c.t > 14 && !game.titleHold) finishTitle(game);
    } else if (c.kind === 'title-out') {
      if (c.t > 0.7) {
        c.dom.root.classList.remove('title-mode');
        endCinematic(game, true);
      }
    } else if (c.kind === 'intro' && gl) {
      const k = sampleKeys(c.keys, Math.min(c.t, c.dur));
      gl.tFocus.x = k.x; gl.tFocus.z = k.z; gl.tDist = k.dist; gl.tYaw = k.yaw; gl.tPitch = k.pitch;
      gl.lookLift = k.lift;
      if (c.t > c.dur - 1.6) { c.letterTarget = 0; show(c.dom.card, false); gl.cineReveal = false; }
      if (c.t >= c.dur) endCinematic(game, true);
    } else if (c.kind === 'outro' && gl) {
      const o = c.orbit;
      gl.tFocus.x = o.x; gl.tFocus.z = o.z;
      gl.tYaw = o.yaw + c.t * 0.11;
      gl.tDist = o.dist * (1 + 0.12 * smooth(c.t / c.dur));
      gl.tPitch = lerp(gl.pitch, o.pitch, ease(c.t / 2.2));
      gl.lookLift = 1.2;
      if (c.t >= c.dur) endCinematic(game, true);
    }
  }
  if (typeof document !== 'undefined' && document.body && document.body.classList) {
    const on = c.active && c.kind !== 'title' && c.kind !== 'title-out';
    if (c._bodyOn !== on) { c._bodyOn = on; document.body.classList.toggle('cine-on', on); }
  }
  // letterbox / fade live in the final post pass
  c.letterbox = damp(c.letterbox, c.letterTarget, 4.5, dt);
  c.fade = clamp(damp(c.fade, c.fadeTarget, c.fadeTarget > c.fade ? 9 : 3.2, dt), 0, 1);
  if (gl && gl.post) {
    const u = gl.post.final.material.uniforms;
    u.uLetterbox.value = c.letterbox < 0.004 ? 0 : c.letterbox;
    u.uFade.value = c.fade < 0.004 ? 0 : c.fade;
    u.uFlash.value *= Math.exp(-dt * 3.2);
    if (u.uFlash.value < 0.002) u.uFlash.value = 0;
  }
}

export { setWorld, wuToX, wuToZ, CELL };

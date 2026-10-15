import { sfx } from './audio.js';

// Render-only FX layer: muzzle flashes, impact sparks, explosions, smoke,
// command markers (move/attack), selection rings, screen shake.
// Purely observational — it diffs sim state per tick and never touches it,
// so determinism and the headless QA suites are unaffected.

const MAX_PARTS = 360;

export function initFx(game) {
  game.fx = {
    parts: [],        // {x,y,vx,vy,age,life,size,color,kind,fade}
    rings: [],        // {x,y,age,life,color,r0,r1}
    losses: { unitsLost: 0, structsLost: 0 },
    shake: 0, sx: 0, sy: 0,
    prevU: new Map(), // id -> {x,y}
    prevS: new Map(),
    prevP: new Map(), // id -> kind
    lastTick: -1,
  };
}

export function clearFx(game) {
  if (!game.fx) return;
  game.fx.parts.length = 0;
  game.fx.rings.length = 0;
  game.fx.prevU.clear();
  game.fx.prevS.clear();
  game.fx.prevP.clear();
  game.fx.lastTick = -1;
  game.fx.shake = 0;
}

// ---- spawning ----------------------------------------------------------------

function spawn(game, p) {
  const fx = game.fx;
  if (fx.parts.length >= MAX_PARTS) fx.parts.shift();
  fx.parts.push(p);
}

function burst(game, x, y, n, opts) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (opts.speed || 60) * (0.4 + Math.random() * 0.8);
    spawn(game, {
      x, y,
      vx: Math.cos(a) * sp + (opts.vx || 0),
      vy: Math.sin(a) * sp + (opts.vy || 0),
      age: 0, life: (opts.life || 450) * (0.7 + Math.random() * 0.6),
      size: (opts.size || 3) * (0.6 + Math.random() * 0.8),
      color: opts.colors ? opts.colors[(Math.random() * opts.colors.length) | 0] : (opts.color || '#ffb46a'),
      kind: opts.kind || 'spark',
    });
  }
}

export function fxExplosion(game, x, y, big) {
  // central flash: bright expanding disc, reads at any zoom
  spawn(game, {
    x, y, vx: 0, vy: 0, age: 0, life: big ? 260 : 180,
    size: big ? 46 : 26, color: '#fff3c4', kind: 'flash',
  });
  burst(game, x, y, big ? 30 : 16, {
    speed: big ? 170 : 120, life: 600, size: big ? 8 : 5,
    colors: ['#ffe9a0', '#ffb46a', '#ff7a45', '#e53935'], kind: 'spark',
  });
  burst(game, x, y, big ? 12 : 6, {
    speed: 30, life: 1600, size: big ? 16 : 10, color: 'rgba(70,70,70,0.5)', kind: 'smoke',
  });
}

export function fxRing(game, x, y, kind) {
  const colors = { move: '#7fd48a', attack: '#e56a5a', deploy: '#ffd76a', ability: '#7fd4ff' };
  game.fx.rings.push({
    x, y, age: 0, life: 550,
    color: colors[kind] || '#fff', r0: 6, r1: kind === 'deploy' ? 46 : 30,
  });
}

export function fxShake(game, amount) {
  if (game.settings && game.settings.screenShake === false) return;
  game.fx.shake = Math.min(14, game.fx.shake + amount);
}

// ---- per-tick observation ------------------------------------------------------

function entPos(st, id) {
  const e = st.units[id] || st.structures[id];
  if (!e) return null;
  if (e.cx !== undefined) {
    const fp = e.fp || 1;
    return { x: (e.cx + fp / 2) * 64, y: (e.cy + fp / 2) * 64 };
  }
  return { x: e.x, y: e.y };
}

// called once per sim tick from main.js; diffs state to spawn combat FX
export function fxObserveTick(game) {
  const st = game.state;
  const fx = game.fx;
  if (!st || !fx || fx.lastTick === st.tick) return;
  fx.lastTick = st.tick;
  // headless QA harnesses (MiniRacer) have no DOM image API — skip FX there
  if (typeof document === 'undefined' || typeof Image === 'undefined') return;

  const visible = (x, y) => {
    const cx = Math.floor(x / 64), cy = Math.floor(y / 64);
    if (cx < 0 || cy < 0 || cx >= st.map.w || cy >= st.map.h) return false;
    return st.fog[game.playerSlot].visible[cy * st.map.w + cx] === 1;
  };

  // units: muzzle flashes + hits + deaths
  for (const id in st.units) {
    const u = st.units[id];
    const def = st.unitDefs[u.defId];
    const seen = visible(u.x, u.y);
    if (seen && def.cooldownTicks > 0 && u.cooldown === def.cooldownTicks) {
      const tpos = (u.order && (u.order.targetId || u.order.enemyId))
        ? entPos(st, u.order.targetId || u.order.enemyId) : null;
      const dx = tpos ? tpos.x - u.x : 0, dy = tpos ? tpos.y - u.y : 0;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      burst(game, u.x + dx / d * 14, u.y + dy / d * 14, 4, {
        vx: dx / d * 90, vy: dy / d * 90, speed: 40, life: 240,
        size: 5, colors: ['#ffe9a0', '#ffd76a'], kind: 'spark',
      });
      spawn(game, {
        x: u.x + dx / d * 14, y: u.y + dy / d * 14,
        vx: 0, vy: 0, age: 0, life: 110, size: 14, color: '#fff3c4', kind: 'flash',
      });
      sfx('shot');
    }
    if (seen && u.lastHitTick === st.tick) {
      burst(game, u.x, u.y, 4, {
        speed: 70, life: 320, size: 4, colors: ['#ff8a65', '#ffd54f'], kind: 'spark',
      });
      sfx('hit');
    }
  }
  for (const [id, pos] of fx.prevU) {
    if (st.units[id]) continue;
    fx.prevU.delete(id);
    if (visible(pos.x, pos.y)) {
      fxExplosion(game, pos.x, pos.y, false);
      sfx('explosion');
      if (pos.own) { fxShake(game, 3); fx.losses.unitsLost++; }
    }
  }
  // re-store with owner for death shake
  for (const id in st.units) {
    const u = st.units[id];
    fx.prevU.set(id, { x: u.x, y: u.y, own: u.owner === game.playerSlot });
  }

  // structures: hits + deaths (big)
  for (const id in st.structures) {
    const s = st.structures[id];
    const c = entPos(st, id);
    const seen = visible(c.x, c.y);
    if (seen && s.lastHitTick === st.tick) {
      burst(game, c.x, c.y, 6, {
        speed: 80, life: 380, size: 5, colors: ['#ff8a65', '#ffd54f', '#fff'], kind: 'spark',
      });
      if (s.owner === game.playerSlot) sfx('alarm');
    }
    fx.prevS.set(id, { x: c.x, y: c.y, own: s.owner === game.playerSlot });
  }
  for (const [id, pos] of fx.prevS) {
    if (st.structures[id]) continue;
    fx.prevS.delete(id);
    if (visible(pos.x, pos.y)) {
      fxExplosion(game, pos.x, pos.y, true);
      sfx('bigExplosion');
      if (pos.own) { fxShake(game, 7); fx.losses.structsLost++; }
    }
  }

  // projectiles: SW / ability impacts
  for (const id in st.projectiles) {
    fx.prevP.set(id, st.projectiles[id].kind);
  }
  for (const [id, kind] of fx.prevP) {
    if (st.projectiles[id]) continue;
    fx.prevP.delete(id);
    if (kind !== 'tracer' && kind !== 'telegraph') {
      // impact point unknown once gone; the telegraph/tracer line tells the eye
      fxShake(game, 5);
    }
  }
}

// ---- per-frame update + draw ----------------------------------------------------

export function updateFx(game, dtMs) {
  const fx = game.fx;
  if (!fx) return;
  for (let i = fx.parts.length - 1; i >= 0; i--) {
    const p = fx.parts[i];
    p.age += dtMs;
    if (p.age >= p.life) { fx.parts.splice(i, 1); continue; }
    p.x += p.vx * dtMs / 1000;
    p.y += p.vy * dtMs / 1000;
    if (p.kind === 'spark') p.vy += 30 * dtMs / 1000; // slight gravity
    else { p.vx *= 0.98; p.vy *= 0.98; }
  }
  for (let i = fx.rings.length - 1; i >= 0; i--) {
    const r = fx.rings[i];
    r.age += dtMs;
    if (r.age >= r.life) fx.rings.splice(i, 1);
  }
  if (fx.shake > 0.1) {
    fx.shake *= Math.pow(0.001, dtMs / 1000); // fast decay
    fx.sx = (Math.random() * 2 - 1) * fx.shake;
    fx.sy = (Math.random() * 2 - 1) * fx.shake;
  } else { fx.shake = 0; fx.sx = 0; fx.sy = 0; }
}

// world-space draw; called from renderFrame after entities, before fog
export function drawFx(game, ctx) {
  const fx = game.fx;
  if (!fx) return;
  for (const r of fx.rings) {
    const t = r.age / r.life;
    const rad = r.r0 + (r.r1 - r.r0) * t;
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 2.5 - 1.5 * t;
    ctx.beginPath();
    ctx.arc(r.x, r.y, rad, 0, 7);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const p of fx.parts) {
    const t = p.age / p.life;
    ctx.fillStyle = p.color;
    if (p.kind === 'flash') {
      ctx.globalAlpha = (1 - t) * 0.9;
      const r = p.size * (0.4 + t * 0.9);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 7);
      ctx.fill();
    } else if (p.kind === 'smoke') {
      ctx.globalAlpha = (1 - t) * 0.45;
      const r = p.size * (1 + t * 1.8);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 7);
      ctx.fill();
    } else {
      ctx.globalAlpha = 1 - t;
      const s = p.size * (1 - t * 0.5);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
  }
  ctx.globalAlpha = 1;
}

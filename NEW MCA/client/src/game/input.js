// Input: selection, context orders, hotkeys, control groups, camera pan.
// All gameplay actions go into game.pendingCmds (sim command queue) — the UI
// never mutates sim state directly.
import { CELL, cellOf, isHostile, entityPos, structCenter } from '../sim/index.js';
import { screenToWorld, panCameraBy, zoomCameraAt, clampCameraToMap, centerCameraOn } from './camera.js';
import { resolvePlacement, placementBlockReason } from './placement.js';
import { rallyCommand } from './rally.js';
import { flashAtCursor } from './hud.js';
import { fxRing } from './fx.js';
import { sfx } from './audio.js';

const EDGE_PX = 14;
const PAN_SPEED = 700;   // screen px / s
const DRAG_MIN = 6;      // px before a drag becomes a box-select
// build-grid hotkeys (A/S/D stay reserved for orders)
const GRID_KEYS = {
  KeyQ: 'Q', KeyW: 'W', KeyE: 'E', KeyR: 'R', KeyT: 'T', KeyF: 'F', KeyG: 'G',
};

export function initInput(game, canvas) {
  const on = (target, type, fn) => target.addEventListener(type, fn);

  on(canvas, 'contextmenu', (e) => e.preventDefault());

  on(canvas, 'mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    game.mouse.sx = e.clientX - r.left;
    game.mouse.sy = e.clientY - r.top;
    game.mouse.inside = true;
    if (game.drag) { game.drag.x1 = game.mouse.sx; game.drag.y1 = game.mouse.sy; }
    if (game.midDrag) {
      panCameraBy(game.camera, game.midDrag.lx - game.mouse.sx, game.midDrag.ly - game.mouse.sy);
      game.midDrag.lx = game.mouse.sx; game.midDrag.ly = game.mouse.sy;
    }
  });
  on(canvas, 'mouseleave', () => { game.mouse.inside = false; });

  on(canvas, 'mousedown', (e) => {
    if (e.button === 1) {
      game.midDrag = { lx: game.mouse.sx, ly: game.mouse.sy };
      e.preventDefault();
    } else if (e.button === 0) {
      game.drag = { x0: game.mouse.sx, y0: game.mouse.sy, x1: game.mouse.sx, y1: game.mouse.sy };
    }
  });

  on(canvas, 'mouseup', (e) => {
    if (e.button === 1) { game.midDrag = null; return; }
    if (!game.state || game.state.over) { game.drag = null; return; }
    if (e.button === 0) handleLeftUp(game, e);
    else if (e.button === 2) handleRightClick(game);
    game.drag = null;
  });

  on(canvas, 'wheel', (e) => {
    e.preventDefault();
    zoomCameraAt(game.camera, e.deltaY < 0 ? 1.15 : 1 / 1.15, game.mouse.sx, game.mouse.sy);
    if (game.state) {
      clampCameraToMap(game.camera, game.state.map.w * CELL, game.state.map.h * CELL);
    }
  }, { passive: false });

  // double-click: deploy an MCV, otherwise select all of the same type on screen
  on(canvas, 'dblclick', () => {
    if (!game.state || game.state.over || game.placement) return;
    const w = screenToWorld(game.camera, game.mouse.sx, game.mouse.sy);
    const ent = pickOwnAt(game, w.x, w.y);
    if (!ent) return;
    if (ent.defId === 'MCV') {
      pushCmd(game, { type: 'deployMCV', unitId: ent.id });
      fxRing(game, ent.x, ent.y, 'deploy');
      sfx('deploy');
      return;
    }
    if (ent.cx !== undefined) return; // structures: no mass-select
    const cam = game.camera;
    const a = screenToWorld(cam, 0, 0);
    const b = screenToWorld(cam, cam.viewW, cam.viewH);
    const sel = [];
    for (const id in game.state.units) {
      const u = game.state.units[id];
      if (u.owner === game.playerSlot && u.defId === ent.defId
        && u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y) sel.push(u.id);
    }
    if (sel.length) game.selection = sel;
  });

  on(window, 'keydown', (e) => handleKey(game, e, true));
  on(window, 'keyup', (e) => handleKey(game, e, false));
}

// ---- per-frame pan (arrows + screen edge) -----------------------------------

export function handleInputFrame(game, dtMs) {
  if (!game.camera || !game.state) return;
  const dt = dtMs / 1000;
  let dx = 0, dy = 0;
  const k = game.keys;
  if (k.has('ArrowLeft')) dx -= 1;
  if (k.has('ArrowRight')) dx += 1;
  if (k.has('ArrowUp')) dy -= 1;
  if (k.has('ArrowDown')) dy += 1;
  if (game.mouse.inside && !game.midDrag) {
    if (game.mouse.sx < EDGE_PX) dx -= 1;
    if (game.mouse.sx > game.camera.viewW - EDGE_PX) dx += 1;
    if (game.mouse.sy < EDGE_PX) dy -= 1;
    if (game.mouse.sy > game.camera.viewH - EDGE_PX) dy += 1;
  }
  if (dx || dy) {
    panCameraBy(game.camera, dx * PAN_SPEED * dt, dy * PAN_SPEED * dt);
    clampCameraToMap(game.camera, game.state.map.w * CELL, game.state.map.h * CELL);
  }
}

// ---- mouse actions ------------------------------------------------------------

function selectedUnitIds(game) {
  const out = [];
  for (const id of game.selection) {
    const u = game.state.units[id];
    if (u && u.owner === game.playerSlot) out.push(id);
  }
  return out;
}

function handleLeftUp(game, e) {
  const cam = game.camera;
  const w = screenToWorld(cam, game.mouse.sx, game.mouse.sy);

  // structure placement mode: forgiving snap + Shift to chain
  if (game.placement) {
    const def = game.state.structDefs[game.placement.structId];
    const cx = Math.floor(w.x / CELL) - (def.fp >> 1);
    const cy = Math.floor(w.y / CELL) - (def.fp >> 1);
    const spot = resolvePlacement(game.state, game.playerSlot, def, cx, cy);
    if (spot) {
      pushCmd(game, { type: 'placeStructure', structId: def.id, cx: spot.cx, cy: spot.cy });
      if (!e.shiftKey) game.placement = null; // Shift held: stay in placement mode
    } else {
      flashAtCursor(game,
        placementBlockReason(game.state, game.playerSlot, def, cx, cy) || 'Blocked');
    }
    return; // no legal spot: stay in placement mode (right-click/Esc cancels)
  }
  // superweapon / faction ability targeting
  if (game.targeting) {
    pushCmd(game, {
      type: game.targeting.kind === 'sw' ? 'useSuperweapon' : 'useFactionAbility',
      x: Math.round(w.x), y: Math.round(w.y),
    });
    if (game.targeting.kind === 'ability') fxRing(game, w.x, w.y, 'ability');
    game.targeting = null;
    return;
  }
  // attack-move
  if (game.attackMoveArmed) {
    const ids = selectedUnitIds(game);
    if (ids.length) {
      pushCmd(game, { type: 'attackMove', unitIds: ids, x: Math.round(w.x), y: Math.round(w.y) });
      fxRing(game, w.x, w.y, 'attack');
      sfx('ack');
    }
    game.attackMoveArmed = false;
    return;
  }

  // selection
  const d = game.drag;
  const dragDist = Math.max(Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  if (!e.shiftKey) { game.selection = []; game.inspectId = 0; }
  if (dragDist < DRAG_MIN) {
    const ent = pickOwnAt(game, w.x, w.y);
    if (ent) {
      if (e.shiftKey) {
        // v0.3.2: shift+click adds to the selection (matches shift+box-select)
        if (!game.selection.includes(ent.id)) game.selection.push(ent.id);
      } else {
        game.selection = [ent.id];
      }
    } else {
      // fog-visible hostile: inspect without stealing the selection
      const foe = pickHostileAt(game, w.x, w.y);
      if (foe) game.inspectId = foe.id;
    }
  } else {
    const a = screenToWorld(cam, Math.min(d.x0, d.x1), Math.min(d.y0, d.y1));
    const b = screenToWorld(cam, Math.max(d.x0, d.x1), Math.max(d.y0, d.y1));
    for (const id in game.state.units) {
      const u = game.state.units[id];
      if (u.owner !== game.playerSlot) continue;
      if (u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y) {
        if (!game.selection.includes(u.id)) game.selection.push(u.id);
      }
    }
  }
  game.hudDirty = true;
}

function handleRightClick(game) {
  // right-click while placing / targeting only cancels — never issues orders
  if (game.placement) { game.placement = null; return; }
  if (game.targeting) { game.targeting = null; return; }
  if (game.attackMoveArmed) { game.attackMoveArmed = false; return; }
  const w = screenToWorld(game.camera, game.mouse.sx, game.mouse.sy);
  const ids = selectedUnitIds(game);
  if (!ids.length) {
    // production structure selected: set its rally point (sim command)
    const rc = rallyCommand(game.state, game.playerSlot, game.selection, w.x, w.y);
    if (rc) pushCmd(game, rc);
    return;
  }
  const foe = pickHostileAt(game, w.x, w.y);
  if (foe) {
    pushCmd(game, { type: 'attackTarget', unitIds: ids, targetId: foe.id });
    fxRing(game, w.x, w.y, 'attack');
  } else {
    pushCmd(game, { type: 'move', unitIds: ids, x: Math.round(w.x), y: Math.round(w.y) });
    fxRing(game, w.x, w.y, 'move');
  }
  sfx('ack');
}

// ---- picking -------------------------------------------------------------------

function fogVisibleAt(game, wx, wy) {
  const st = game.state;
  const cx = cellOf(wx), cy = cellOf(wy);
  if (cx < 0 || cy < 0 || cx >= st.map.w || cy >= st.map.h) return false;
  return st.fog[game.playerSlot].visible[cy * st.map.w + cx] === 1;
}

export function pickOwnAt(game, wx, wy) {
  // generous unit pick radius (~0.6 cell) so small units are clickable
  let best = null, bestD = Math.round(0.6 * CELL) ** 2;
  for (const id in game.state.units) {
    const u = game.state.units[id];
    if (u.owner !== game.playerSlot) continue;
    const dx = u.x - wx, dy = u.y - wy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = u; }
  }
  if (best) return best;
  for (const id in game.state.structures) {
    const s = game.state.structures[id];
    if (s.owner !== game.playerSlot) continue;
    if (wx >= s.cx * CELL && wx < (s.cx + s.fp) * CELL
      && wy >= s.cy * CELL && wy < (s.cy + s.fp) * CELL) return s;
  }
  return null;
}

function pickHostileAt(game, wx, wy) {
  if (!fogVisibleAt(game, wx, wy)) return null;
  let best = null, bestD = 26 * 26;
  for (const id in game.state.units) {
    const u = game.state.units[id];
    if (!isHostile(game.state, game.playerSlot, u)) continue;
    const dx = u.x - wx, dy = u.y - wy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = u; }
  }
  if (best) return best;
  for (const id in game.state.structures) {
    const s = game.state.structures[id];
    if (!isHostile(game.state, game.playerSlot, s)) continue;
    if (wx >= s.cx * CELL && wx < (s.cx + s.fp) * CELL
      && wy >= s.cy * CELL && wy < (s.cy + s.fp) * CELL) return s;
  }
  return null;
}

// ---- keyboard ---------------------------------------------------------------------

export function handleKey(game, e, down) {
  if (down) game.keys.add(e.code); else game.keys.delete(e.code);
  if (!down) return;
  // Esc works even without a live match (setup screen / pause overlay)
  if (e.code === 'Escape') { handleEscape(game); return; }
  if (!game.state || game.state.over) return;
  if (game.overlay) return; // overlays swallow gameplay hotkeys
  // build-grid hotkeys (Q W E R T F G) — before order hotkeys, no modifiers
  if (!e.ctrlKey && !e.altKey && GRID_KEYS[e.code]) {
    if (game.hudKeyPress && game.hudKeyPress(GRID_KEYS[e.code])) return;
  }
  const ids = selectedUnitIds(game);
  switch (e.code) {
    case 'KeyA':
      if (ids.length) game.attackMoveArmed = true;
      break;
    case 'KeyS':
      if (ids.length) pushCmd(game, { type: 'stop', unitIds: ids });
      break;
    case 'KeyD': {
      const mcv = ids.map((id) => game.state.units[id]).find((u) => u && u.defId === 'MCV');
      if (mcv) { pushCmd(game, { type: 'deployMCV', unitId: mcv.id }); sfx('deploy'); }
      break;
    }
    case 'KeyB':
      if (game.hudFocusBuild) game.hudFocusBuild();
      break;
    case 'Tab':
      if (game.hudNextPage) game.hudNextPage();
      e.preventDefault();
      break;
    case 'Space': {
      // center on the selection centroid; nothing selected -> jump home
      const sel = game.selection
        .map((id) => game.state.units[id] || game.state.structures[id])
        .filter((x) => x);
      if (sel.length) {
        let sx = 0, sy = 0;
        for (const ent of sel) {
          const pp = entityPos(game.state, ent);
          sx += pp.x; sy += pp.y;
        }
        centerCameraOn(game.camera, sx / sel.length, sy / sel.length);
        clampCameraToMap(game.camera, game.state.map.w * CELL, game.state.map.h * CELL);
      } else {
        jumpHome(game);
      }
      e.preventDefault();
      break;
    }
    case 'Home':
      jumpHome(game);
      e.preventDefault();
      break;
    default:
      if (e.code.startsWith('Digit')) handleDigit(game, e, Number(e.code.slice(5)));
      break;
  }
}

// Esc priority: cancel an in-match mode first, then close whatever overlay
// is up (pause overlay = Resume, setup screen = Back)
function handleEscape(game) {
  if (game.placement || game.targeting || game.attackMoveArmed) {
    game.placement = null;
    game.targeting = null;
    game.attackMoveArmed = false;
    return;
  }
  if (game.overlay === 'pause') {
    if (game.resumePause) game.resumePause();
    return;
  }
  if (game.overlay === 'setup') {
    if (game.menuBack) game.menuBack();
    return;
  }
  // nothing to cancel and no overlay up: open the pause menu mid-match
  if (game.state && !game.state.over && game.openMenu) game.openMenu();
}

function jumpHome(game) {
  const st = game.state;
  let target = null;
  for (const id in st.structures) {
    const s = st.structures[id];
    if (s.owner === game.playerSlot && s.defId === 'SH-01') { target = structCenter(s); break; }
  }
  if (!target) {
    for (const id in st.units) {
      const u = st.units[id];
      if (u.owner === game.playerSlot && u.defId === 'MCV') { target = { x: u.x, y: u.y }; break; }
    }
  }
  if (!target) return;
  centerCameraOn(game.camera, target.x, target.y);
  clampCameraToMap(game.camera, st.map.w * CELL, st.map.h * CELL);
}

function handleDigit(game, e, digit) {
  if (e.ctrlKey) {
    game.groups[digit] = selectedUnitIds(game);
    e.preventDefault();
    return;
  }
  if (e.shiftKey) {
    // add current selection to the group (union) and select the whole group
    const cur = game.groups[digit] || [];
    const merged = cur.slice();
    for (const id of selectedUnitIds(game)) {
      if (!merged.includes(id)) merged.push(id);
    }
    game.groups[digit] = merged;
    game.selection = merged.filter((id) => game.state.units[id]);
    game.hudDirty = true;
    e.preventDefault();
    return;
  }
  const grp = (game.groups[digit] || []).filter((id) => game.state.units[id]);
  if (!grp.length) return;
  game.selection = grp.slice();
  game.hudDirty = true;
  // double-tap centers the camera on the group
  const now = performance.now();
  if (game._lastDigit === digit && now - game._lastDigitT < 400) {
    let sx = 0, sy = 0;
    for (const id of grp) { sx += game.state.units[id].x; sy += game.state.units[id].y; }
    centerCameraOn(game.camera, sx / grp.length, sy / grp.length);
    clampCameraToMap(game.camera, game.state.map.w * CELL, game.state.map.h * CELL);
  }
  game._lastDigit = digit;
  game._lastDigitT = now;
}

function pushCmd(game, cmd) {
  cmd.player = game.playerSlot;
  game.pendingCmds.push(cmd);
}

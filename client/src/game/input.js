// Input: selection, context orders, hotkeys, control groups, camera pan.
// All gameplay actions go into game.pendingCmds (sim command queue) — the UI
// never mutates sim state directly.
import { CELL, cellOf, isHostile, entityPos, structCenter, teamOf, isInfantryCls, formationOffsetsAir } from '../sim/index.js';
import { screenToWorld, panCameraBy, zoomCameraAt, clampCameraToMap, centerCameraOn } from './camera.js';
import { resolvePlacement, placementBlockReason } from './placement.js';
import { rallyCommand } from './rally.js';
import { flashAtCursor, skipTutorial } from './hud.js';
import { unitRadius } from './sprites.js';
import { playSfx, setMuted, isMuted } from './audio.js';

const EDGE_PX = 12;      // screen-edge pan margin
const PAN_SPEED = 600;   // screen px / s (at 1x zoom; panCameraBy scales by zoom)
const DRAG_MIN = 6;      // px before a drag becomes a box-select / drag-move
const WHEEL_PAN_PX = 120; // v0.6.0: wheel = map pan, CSS px per notch

// audio.js ships concurrently (v0.3.7); headless harnesses strip the import,
// so every call site is guarded — audio is always best-effort
function sfx(game, name) {
  try { if (typeof playSfx === 'function') playSfx(game, name); } catch (e) { /* no-op */ }
}

// v0.3.7 formation offsets (DeepSeek T5): diamond grid in reading order (row
// widths 1,2,3,4,2 = 12 slots; further units stack on the clicked point)
// v0.9.0: all-air groups fly role-based formations (fighters screen ahead,
// strike aircraft trail) instead of the ground diamond.
function orderOffsets(state, ids, x, y) {
  if (ids.length > 1 && ids.every((id) =>
      state.units[id] && state.unitDefs[state.units[id].defId].domain === 'Air')) {
    return formationOffsetsAir(state, ids, x, y);
  }
  return formationOffsets(state, ids, x, y);
}

const FORM_ROWS = [1, 2, 3, 4, 2];
export const FORM_SPACING = Math.round(CELL * 0.6); // 38 wu

// One int offset per unitId, aligned by index to unitIds (the sim applies
// offsets[ii] to unitIds[ii]). Slots are dealt farthest-unit-first (ties by
// numeric id ascending) so the longest walk gets the shortest detour.
// Returns null for single-unit orders (no offsets field attached).
export function formationOffsets(state, unitIds, destX, destY) {
  if (!unitIds || unitIds.length < 2) return null;
  const sorted = unitIds.slice().sort((a, b) => {
    const ua = state.units[a], ub = state.units[b];
    const da = ua ? (ua.x - destX) * (ua.x - destX) + (ua.y - destY) * (ua.y - destY) : 0;
    const db = ub ? (ub.x - destX) * (ub.x - destX) + (ub.y - destY) * (ub.y - destY) : 0;
    if (db !== da) return db - da; // farthest from the destination first
    return a - b;                  // ties: numeric id ascending
  });
  const slotOf = {};
  let i = 0;
  for (let r = 0; r < FORM_ROWS.length && i < sorted.length; r++) {
    const w = FORM_ROWS[r];
    for (let c = 0; c < w && i < sorted.length; c++, i++) {
      slotOf[sorted[i]] = {
        x: Math.round((c - (w - 1) / 2) * FORM_SPACING),
        y: r * FORM_SPACING,
      };
    }
  }
  return unitIds.map((id) => slotOf[id] || { x: 0, y: 0 });
}
// build-grid hotkeys (A/S/D stay reserved for orders; G is the stance key —
// v0.3.6)
const GRID_KEYS = {
  KeyQ: 'Q', KeyW: 'W', KeyE: 'E', KeyR: 'R', KeyT: 'T', KeyF: 'F',
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
    if (game.dragMove) { game.dragMove.x1 = game.mouse.sx; game.dragMove.y1 = game.mouse.sy; }
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
      // v0.6.0 drag-move: a press on an ALREADY-SELECTED own unit arms a
      // move-drag instead of a box-select (release past DRAG_MIN issues the
      // move; a short press falls through as a normal click). Empty terrain
      // and unselected entities keep the box-select. Shift+press keeps the
      // box-select too (shift = add-to-selection).
      if (!e.shiftKey && game.state && !game.state.over && !game.paused
        && !game.placement && !game.targeting && !game.attackMoveArmed) {
        const w = screenToWorld(game.camera, game.mouse.sx, game.mouse.sy);
        const ent = pickOwnAt(game, w.x, w.y);
        if (ent && ent.cx === undefined && game.selection.includes(ent.id)) {
          game.dragMove = {
            x0: game.mouse.sx, y0: game.mouse.sy,
            x1: game.mouse.sx, y1: game.mouse.sy,
            ux: ent.x, uy: ent.y,
          };
          return;
        }
      }
      // box-select stays the default (v0.5.1: the v0.4.4 LMB-pan experiment
      // is reverted). Camera panning stays on the wheel (v0.6.0), middle-drag,
      // screen edges and arrow keys.
      game.drag = { x0: game.mouse.sx, y0: game.mouse.sy, x1: game.mouse.sx, y1: game.mouse.sy };
    }
  });

  // middle-click also fires auxclick: suppress the browser autoscroll there too
  on(canvas, 'auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

  on(canvas, 'mouseup', (e) => {
    if (e.button === 1) { game.midDrag = null; return; }
    // v0.6.0 drag-move release: past DRAG_MIN -> move order to the release
    // point (selection kept); a short press falls through as a normal click
    if (e.button === 0 && game.dragMove) {
      const dm = game.dragMove;
      game.dragMove = null;
      const dmDist = Math.max(Math.abs(dm.x1 - dm.x0), Math.abs(dm.y1 - dm.y0));
      if (dmDist >= DRAG_MIN) {
        if (game.state && !game.state.over && !game.paused) {
          const ids = selectedUnitIds(game);
          if (ids.length) {
            const w = screenToWorld(game.camera, game.mouse.sx, game.mouse.sy);
            const cmd = { type: 'move', unitIds: ids, x: Math.round(w.x), y: Math.round(w.y) };
            const offs = orderOffsets(game.state, ids, cmd.x, cmd.y);
            if (offs) cmd.offsets = offs;
            pushCmd(game, cmd);
            sfx(game, 'move');
          }
        }
        game.hudDirty = true;
        return;
      }
      // short press on a selected unit: fall through as a normal click
      game.drag = { x0: dm.x0, y0: dm.y0, x1: dm.x1, y1: dm.y1 };
    }
    // v0.9.1: while paused the pause menu owns the UI — mouse orders are
    // dropped (the top-bar buttons are DOM and stay live)
    if (!game.state || game.state.over || game.paused) { game.drag = null; return; }
    if (e.button === 0) handleLeftUp(game, e);
    else if (e.button === 2) handleRightClick(game, e);
    game.drag = null;
  });

  on(canvas, 'wheel', (e) => {
    e.preventDefault();
    const cam = game.camera;
    if (!cam) return;
    if (e.ctrlKey) {
      // pinch path: touchpad pinch arrives as ctrl+wheel — zoom stays here,
      // anchored at the cursor
      zoomCameraAt(cam, e.deltaY < 0 ? 1.15 : 1 / 1.15, game.mouse.sx, game.mouse.sy);
    } else {
      // v0.6.0: the wheel PANS the map (natural: wheel up = view moves
      // north); Shift+wheel pans horizontally
      const mag = e.deltaMode === 1 ? 400 : WHEEL_PAN_PX; // deltaMode 1 = lines
      const d = (e.deltaY > 0 ? 1 : -1) * mag;
      if (e.shiftKey) panCameraBy(cam, d, 0);
      else panCameraBy(cam, 0, d);
    }
    if (game.state) {
      clampCameraToMap(cam, game.state.map.w * CELL, game.state.map.h * CELL);
    }
  }, { passive: false });

  // double-click: deploy an MCV, otherwise select all of the same type on screen
  on(canvas, 'dblclick', () => {
    if (!game.state || game.state.over || game.placement || game.paused) return;
    const w = screenToWorld(game.camera, game.mouse.sx, game.mouse.sy);
    const ent = pickOwnAt(game, w.x, w.y);
    if (!ent) return;
    if (ent.defId === 'MCV') {
      pushCmd(game, { type: 'deployMCV', unitId: ent.id });
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
  // v0.9.1: alt-tab while an arrow key is held leaves it stuck in game.keys
  // (the keyup lands in the other window) — clear the set on window blur so
  // camera panning can't run away in the background
  on(window, 'blur', () => { if (game.keys) game.keys.clear(); });
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
  // edge pan: live match only — never while paused or under an overlay, and
  // not while the pointer is outside the window (mouseleave clears .inside)
  if (game.mouse.inside && !game.midDrag && !game.paused && !game.overlay) {
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
      sfx(game, 'error');
    }
    return; // no legal spot: stay in placement mode (right-click/Esc cancels)
  }
  // superweapon / faction ability targeting
  if (game.targeting) {
    pushCmd(game, {
      type: game.targeting.kind === 'sw' ? 'useSuperweapon' : 'useFactionAbility',
      x: Math.round(w.x), y: Math.round(w.y),
    });
    game.targeting = null;
    return;
  }
  // attack-move
  if (game.attackMoveArmed) {
    const ids = selectedUnitIds(game);
    if (ids.length) {
      const cmd = { type: 'attackMove', unitIds: ids, x: Math.round(w.x), y: Math.round(w.y) };
      const offs = orderOffsets(game.state, ids, cmd.x, cmd.y);
      if (offs) cmd.offsets = offs;
      pushCmd(game, cmd);
      sfx(game, 'attack');
    }
    game.attackMoveArmed = false;
    return;
  }

  // selection / v0.6.0 left-click orders
  const d = game.drag;
  const dragDist = d ? Math.max(Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)) : 0;
  if (d && dragDist >= DRAG_MIN) {
    // box-select (unchanged semantics): non-shift replaces, shift adds; an
    // empty box clears the selection (v0.6.0 deselect path)
    if (!e.shiftKey) { game.selection = []; game.inspectId = 0; }
    const a = screenToWorld(cam, Math.min(d.x0, d.x1), Math.min(d.y0, d.y1));
    const b = screenToWorld(cam, Math.max(d.x0, d.x1), Math.max(d.y0, d.y1));
    for (const id in game.state.units) {
      const u = game.state.units[id];
      if (u.owner !== game.playerSlot) continue;
      if (u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y) {
        if (!game.selection.includes(u.id)) game.selection.push(u.id);
      }
    }
    game.hudDirty = true;
    return;
  }

  // plain click (no drag) — v0.6.0 left-click orders
  const ids = selectedUnitIds(game); // computed BEFORE any selection change
  const ent = pickOwnAt(game, w.x, w.y);
  if (ent) {
    // own unit/structure: select (v0.3.2: shift+click adds, matching the
    // shift+box-select)
    if (e.shiftKey) {
      if (!game.selection.includes(ent.id)) game.selection.push(ent.id);
    } else {
      game.selection = [ent.id];
    }
    game.inspectId = 0;
    sfx(game, 'select');
  } else if (ids.length) {
    // units selected: left-click on an ENEMY attacks, on open map MOVES —
    // the selection is kept either way (deselect is Esc / box-empty / click
    // a different own entity)
    const foe = pickHostileAt(game, w.x, w.y);
    if (foe) {
      pushCmd(game, { type: 'attackTarget', unitIds: ids, targetId: foe.id });
      sfx(game, 'attack');
    } else {
      const cmd = { type: 'move', unitIds: ids, x: Math.round(w.x), y: Math.round(w.y) };
      const offs = orderOffsets(game.state, ids, cmd.x, cmd.y);
      if (offs) cmd.offsets = offs;
      if (e.shiftKey) cmd.queue = true; // mirrors shift+right-click waypoint
      pushCmd(game, cmd);
      sfx(game, 'move');
    }
    if (!e.shiftKey) game.inspectId = 0;
  } else {
    // no units selected: producer rally (left-click now mirrors right-click),
    // hostile inspect, or deselect
    const rc = rallyCommand(game.state, game.playerSlot, game.selection, w.x, w.y);
    if (rc) {
      pushCmd(game, rc);
    } else {
      const foe = pickHostileAt(game, w.x, w.y);
      if (foe) {
        game.inspectId = foe.id;
      } else if (!e.shiftKey) {
        game.selection = [];
        game.inspectId = 0;
      }
    }
  }
  game.hudDirty = true;
}

function handleRightClick(game, e) {
  // right-click while placing / targeting only cancels — never issues orders
  if (game.placement) { game.placement = null; return; }
  if (game.targeting) { game.targeting = null; return; }
  if (game.attackMoveArmed) { game.attackMoveArmed = false; return; }
  const w = screenToWorld(game.camera, game.mouse.sx, game.mouse.sy);
  const ids = selectedUnitIds(game);
  // patrol mode (P): right-click sets the far end of the patrol loop
  if (game.patrolArmed) {
    game.patrolArmed = false;
    if (ids.length) {
      pushCmd(game, { type: 'patrol', unitIds: ids, x: Math.round(w.x), y: Math.round(w.y) });
    }
    return;
  }
  // shift+right-click queues a waypoint behind the current order (v0.3.6)
  if (e && e.shiftKey && ids.length) {
    const cmd = { type: 'move', unitIds: ids, x: Math.round(w.x), y: Math.round(w.y), queue: true };
    const offs = orderOffsets(game.state, ids, cmd.x, cmd.y);
    if (offs) cmd.offsets = offs;
    pushCmd(game, cmd);
    sfx(game, 'move');
    return;
  }
  // v0.9.0 transports (must precede the deselect block so mixed selections
  // still load): infantry selected + right-click on an own APC/IFV -> load
  // (non-infantry in the selection are ignored by the sim); only a carrier
  // selected + it has cargo + right-click on it -> unload.
  const ownSel = pickOwnAt(game, w.x, w.y);
  if (ownSel && ownSel.cx === undefined && ownSel.owner === game.playerSlot) {
    const hitDef = game.state.unitDefs[ownSel.defId];
    if (hitDef.cls === 'APC' || hitDef.cls === 'IFV') {
      const inf = ids.filter((id) =>
        isInfantryCls(game.state.unitDefs[game.state.units[id].defId].cls));
      if (inf.length) {
        pushCmd(game, { type: 'load', unitIds: inf, carrierId: ownSel.id });
        sfx(game, 'move');
        return;
      }
      if (ids.length === 1 && ids[0] === ownSel.id
          && ownSel.cargo && ownSel.cargo.length) {
        pushCmd(game, { type: 'unload', carrierId: ownSel.id });
        sfx(game, 'move');
        return;
      }
    }
  }
  // v0.9.0 right-click deselect: an own unit already IN the selection is
  // removed from it and no order is issued; emptying the selection this way
  // also clears the inspected hostile. Right-click anywhere else keeps every
  // classic order path below.
  if (ownSel && ownSel.cx === undefined && ids.includes(ownSel.id)) {
    game.selection = ids.filter((id) => id !== ownSel.id);
    if (!game.selection.length) game.inspectId = 0;
    game.hudDirty = true;
    return;
  }
  if (!ids.length) {
    // production structure selected: set its rally point (sim command)
    const rc = rallyCommand(game.state, game.playerSlot, game.selection, w.x, w.y);
    if (rc) pushCmd(game, rc);
    return;
  }
  // repair order (v0.4.3, DeepSeek UX-1): with an engineer selected,
  // right-clicking a damaged allied structure repairs it instead of moving
  if (ids.some((id) => game.state.unitDefs[game.state.units[id].defId].cls === 'Engineer')) {
    const rt = repairTargetAt(game.state, game.playerSlot, w.x, w.y);
    if (rt) {
      pushCmd(game, { type: 'repair', unitIds: ids, targetId: rt.id });
      sfx(game, 'move');
      return;
    }
  }
  const foe = pickHostileAt(game, w.x, w.y);
  if (foe) {
    pushCmd(game, { type: 'attackTarget', unitIds: ids, targetId: foe.id });
    sfx(game, 'attack');
  } else {
    const cmd = { type: 'move', unitIds: ids, x: Math.round(w.x), y: Math.round(w.y) };
    const offs = orderOffsets(game.state, ids, cmd.x, cmd.y);
    if (offs) cmd.offsets = offs;
    pushCmd(game, cmd);
    sfx(game, 'move');
  }
}

// ---- picking -------------------------------------------------------------------

function fogVisibleAt(game, wx, wy) {
  const st = game.state;
  const cx = cellOf(wx), cy = cellOf(wy);
  if (cx < 0 || cy < 0 || cx >= st.map.w || cy >= st.map.h) return false;
  return st.fog[game.playerSlot].visible[cy * st.map.w + cx] === 1;
}

export function pickOwnAt(game, wx, wy) {
  // generous own-unit pick radius (~0.6 cell, scaled up for the big v0.4.1
  // silhouettes so clicking the visible body works)
  let best = null, bestD = Infinity;
  for (const id in game.state.units) {
    const u = game.state.units[id];
    if (u.owner !== game.playerSlot) continue;
    const dx = u.x - wx, dy = u.y - wy;
    const d = dx * dx + dy * dy;
    const rad = Math.max(Math.round(0.6 * CELL),
      unitRadius(game.state.unitDefs[u.defId]) + 4);
    if (d < rad * rad && d < bestD) { bestD = d; best = u; }
  }
  // the own structure whose footprint contains the click point
  let structHit = null;
  for (const id in game.state.structures) {
    const s = game.state.structures[id];
    if (s.owner !== game.playerSlot) continue;
    if (wx >= s.cx * CELL && wx < (s.cx + s.fp) * CELL
      && wy >= s.cy * CELL && wy < (s.cy + s.fp) * CELL) { structHit = s; break; }
  }
  // both candidates: a unit parked on a building (harvester at the depot)
  // only steals the click when it is precisely on the unit — otherwise the
  // structure wins (v0.4.1)
  if (best && structHit) {
    const pr = Math.round(0.35 * CELL); // 22 wu
    return bestD < pr * pr ? best : structHit;
  }
  return best || structHit;
}

// damaged allied structure under a world point (repair-order pick), else null
export function repairTargetAt(state, slot, wx, wy) {
  for (const id in state.structures) {
    const s = state.structures[id];
    if (s.owner < 0 || teamOf(state, s.owner) !== teamOf(state, slot)) continue;
    if (s.hp >= s.maxHp) continue; // sim rejects 'not-damaged' — don't offer it
    if (wx >= s.cx * CELL && wx < (s.cx + s.fp) * CELL
      && wy >= s.cy * CELL && wy < (s.cy + s.fp) * CELL) return s;
  }
  return null;
}

function pickHostileAt(game, wx, wy) {
  if (!fogVisibleAt(game, wx, wy)) return null;
  // pick radius tracks the rendered silhouette (+8 wu slack) so clicking the
  // visible body of a big tank connects (v0.4.1)
  let best = null, bestD = Infinity;
  for (const id in game.state.units) {
    const u = game.state.units[id];
    if (!isHostile(game.state, game.playerSlot, u)) continue;
    const dx = u.x - wx, dy = u.y - wy;
    const d = dx * dx + dy * dy;
    const rad = unitRadius(game.state.unitDefs[u.defId]) + 8;
    if (d < rad * rad && d < bestD) { bestD = d; best = u; }
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

// v0.6.0: +/- zoom at the screen middle (the wheel now pans the map)
function zoomAtCenter(game, factor) {
  const cam = game.camera;
  if (!cam) return;
  zoomCameraAt(cam, factor, cam.viewW / 2, cam.viewH / 2);
  if (game.state) {
    clampCameraToMap(cam, game.state.map.w * CELL, game.state.map.h * CELL);
  }
}

export function handleKey(game, e, down) {
  if (down) game.keys.add(e.code); else game.keys.delete(e.code);
  if (!down) return;
  // v0.10.0: while the MP chat input is open it owns the keyboard — gameplay
  // hotkeys must not fire, Esc closes (the input's own Enter/Esc handlers
  // live in main.js and run before this via focus + stopPropagation)
  if (game.chatOpen) {
    if (e.code === 'Escape' && game.closeChat) game.closeChat();
    return;
  }
  // Esc works even without a live match (setup screen / pause overlay)
  if (e.code === 'Escape') { handleEscape(game); return; }
  if (!game.state || game.state.over) return;
  // v0.9.1: while paused the pause menu owns the UI — gameplay hotkeys are
  // inert (only Esc above gets through; the top-bar buttons are DOM)
  if (game.paused) return;
  if (game.overlay) return; // overlays swallow gameplay hotkeys
  if (e.code === 'Enter') {
    // v0.10.0: in-match chat
    if (game.net && game.net.active && game.openChat) {
      game.openChat();
      if (e.preventDefault) e.preventDefault();
    }
    return;
  }
  // direct stance hotkeys (v0.3.7, DeepSeek T2): Ctrl+Alt+A/D/S/F set the
  // stance outright (plain G still cycles); the build-grid keys below ignore
  // modifiers, so these must be handled first
  if (e.ctrlKey && e.altKey) {
    const direct = { KeyA: 0, KeyD: 1, KeyS: 2, KeyF: 3 }[e.code];
    if (direct !== undefined) {
      const selIds = selectedUnitIds(game);
      if (selIds.length) pushCmd(game, { type: 'setStance', unitIds: selIds, stance: direct });
      if (e.preventDefault) e.preventDefault();
      return;
    }
  }
  // build-grid hotkeys (Q W E R T F) — before order hotkeys, no modifiers
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
      if (mcv) pushCmd(game, { type: 'deployMCV', unitId: mcv.id });
      break;
    }
    case 'KeyG': {
      // cycle unit stance: aggressive -> defensive -> hold ground -> hold fire
      const us = ids.map((id) => game.state.units[id]).filter((u) => u);
      if (us.length) {
        pushCmd(game, { type: 'setStance', unitIds: ids, stance: ((us[0].stance | 0) + 1) % 4 });
      }
      break;
    }
    case 'KeyZ': case 'KeyX': case 'KeyC': case 'KeyV': {
      // direct stances without modifiers (v0.4.3): AltGr-friendly alternates
      // to Ctrl+Alt+A/D/S/F — Z/X/C/V = aggressive/defensive/hold/hold-fire
      if (ids.length) {
        pushCmd(game, { type: 'setStance', unitIds: ids,
          stance: { KeyZ: 0, KeyX: 1, KeyC: 2, KeyV: 3 }[e.code] });
      }
      break;
    }
    case 'KeyP':
      // patrol mode: the next right-click sets the far end of the loop
      if (ids.length) game.patrolArmed = true;
      break;
    case 'KeyM':
      // mute toggle (v0.3.7): silences sfx + voice; music has its own toggle
      try {
        if (typeof setMuted === 'function' && typeof isMuted === 'function') {
          setMuted(game, !isMuted(game));
        }
      } catch (eM) { /* audio is best-effort */ }
      break;
    case 'Period':
      jumpToIdleWorker(game);
      e.preventDefault();
      break;
    case 'KeyB':
      if (game.hudFocusBuild) game.hudFocusBuild();
      break;
    case 'Equal': case 'NumpadAdd':
      // v0.6.0: zoom in at the screen middle (the wheel now pans the map)
      zoomAtCenter(game, 1.15);
      e.preventDefault();
      break;
    case 'Minus': case 'NumpadSubtract':
      zoomAtCenter(game, 1 / 1.15);
      e.preventDefault();
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
  if (game.placement || game.targeting || game.attackMoveArmed || game.patrolArmed) {
    game.placement = null;
    game.targeting = null;
    game.attackMoveArmed = false;
    game.patrolArmed = false;
    return;
  }
  // tutorial overlay up: Esc = Skip tutorial (before any overlay handling)
  if (game.tutor) { skipTutorial(game); return; }
  if (game.overlay === 'pause') {
    if (game.resumePause) game.resumePause();
    return;
  }
  if (game.overlay === 'setup' || game.overlay === 'lobby') {
    if (game.menuBack) game.menuBack();
    return;
  }
  // end-of-match banner up: Esc takes the same path as the top-bar Menu
  // button (openMenu -> exit to the main menu) instead of being a no-op;
  // hide the banner first so it can't linger over the menu
  if (game.state && game.state.over) {
    const b = typeof document !== 'undefined' && document.getElementById
      ? document.getElementById('banner') : null;
    if (b && b.classList) b.classList.add('hidden');
    if (game.openMenu) game.openMenu();
    return;
  }
  // v0.6.0: with a live selection, Esc clears it instead of opening the
  // pause menu (left-click on open map now issues orders, so deselect lives
  // here — the overlays above keep their Esc priority)
  if (game.state && !game.state.over
    && (game.selection.length || game.inspectId)) {
    game.selection = [];
    game.inspectId = 0;
    game.hudDirty = true;
    return;
  }
  // nothing to cancel and no overlay up: open the pause menu mid-match
  if (game.state && game.openMenu) game.openMenu();
}

// '.' jumps the camera to the next idle harvester/engineer, cycling (v0.3.6)
function jumpToIdleWorker(game) {
  const st = game.state;
  const idle = [];
  for (const id in st.units) {
    const u = st.units[id];
    if (u.owner !== game.playerSlot || u.order.type !== 'idle') continue;
    const def = st.unitDefs[u.defId];
    if (u.defId === 'HARV' || def.cls === 'Engineer') idle.push(u);
  }
  idle.sort((a, b) => a.id - b.id);
  if (!idle.length) return;
  game._idleIdx = ((game._idleIdx || 0) + 1) % idle.length;
  const u = idle[game._idleIdx];
  game.selection = [u.id];
  game.hudDirty = true;
  centerCameraOn(game.camera, u.x, u.y);
  clampCameraToMap(game.camera, st.map.w * CELL, st.map.h * CELL);
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

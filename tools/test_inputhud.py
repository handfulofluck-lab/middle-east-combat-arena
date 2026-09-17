# v0.3.7 wave-2 HUD tests: formation offsets (input.js), research-kit buttons,
# stance buttons, alert-stack cap, and EVA voice bookkeeping (hud.js).
# Harness pattern copied from run_smoke.py: py_mini_racer + DOM stub, game
# modules inlined with imports stripped. audio.js is NOT inlined — the
# recorders below stand in for its exports (hud.js calls them via guarded
# wrappers, exactly like the headless smoke run).
# Usage: .venv/Scripts/python test_inputhud.py
import json
import sys
from pathlib import Path

from py_mini_racer import MiniRacer

from run_smoke import CLIENT, STUB_JS, inline

MODULES = [
    "src/sim/rng.js",
    "src/sim/state.js",
    "src/sim/orders.js",
    "src/sim/path.js",
    "src/sim/combat.js",
    "src/sim/economy.js",
    "src/sim/engine.js",
    "src/sim/ai.js",
    "src/game/sprites.js",
    "src/game/camera.js",
    "src/game/placement.js",
    "src/game/rally.js",
    "src/game/input.js",
    "src/game/hud.js",
    "src/game/minimap.js",
]

# audio.js stand-ins: record every call the HUD makes through its wrappers
AUDIO_STUB_JS = r"""
var __voices = [], __tracks = [], __sfxCalls = [];
function playVoice(game, faction, key, detail) {
  __voices.push(faction + ':' + key + (detail && detail.id ? ':' + detail.id : ''));
}
function playMusicTrack(game, track) { __tracks.push(String(track)); }
function playSfx(game, name) { __sfxCalls.push(name); }
"""

DRIVER = r"""
(function () {
  var __t = { errors: [], checks: [] };
  function __check(name, cond, detail) {
    __t.checks.push({ name: name, pass: !!cond, detail: String(detail || '') });
  }
  function walkAll(el, fn) {
    fn(el);
    for (var ci = 0; ci < (el.children || []).length; ci++) walkAll(el.children[ci], fn);
  }
  function mkGame(st) {
    var g = {
      state: st, playerSlot: 0, selection: [], pendingCmds: [],
      camera: null, placement: null, targeting: null, attackMoveArmed: false,
      patrolArmed: false, mouse: { sx: 0, sy: 0, inside: false },
      keys: new Set(), groups: {}, musicOn: false, minimap: null, dpr: 1,
      inspectId: 0, speed: 1, paused: false,
    };
    initHud(g);
    return g;
  }
  function mkMatch(seed) {
    return createMatch({ data: DATA, map: DUEL,
      players: [{ slot: 0, faction: 'Egypt' }, { slot: 1, faction: 'Algeria' }],
      seed: seed });
  }
  try {
    var DATA = JSON.parse(__jsonGame);
    var DUEL = JSON.parse(__jsonMaps.duel);

    // (a) formationOffsets: 5 units one target -> 5 distinct int slots on the
    // 38-wu spacing grid; single-unit order gets null (no offsets field)
    var fst = { units: {} };
    for (var i = 1; i <= 5; i++) fst.units[i] = { x: i * 100, y: 0 };
    var offs = formationOffsets(fst, [1, 2, 3, 4, 5], 500, 0);
    var seen = {}, distinct = true, ints = true;
    if (offs) {
      for (var oi = 0; oi < offs.length; oi++) {
        var k = offs[oi].x + ',' + offs[oi].y;
        if (seen[k]) distinct = false;
        seen[k] = 1;
        if (offs[oi].x !== Math.round(offs[oi].x) || offs[oi].y !== Math.round(offs[oi].y)) ints = false;
      }
    }
    __check('formation-offsets-5-distinct',
      FORM_SPACING === 38 && !!offs && offs.length === 5 && distinct && ints
        && formationOffsets(fst, [1], 500, 0) === null,
      'spacing=' + FORM_SPACING + ' offs='
        + (offs ? offs.map(function (o) { return o.x + ',' + o.y; }).join(' ') : 'null'));

    // (b) researchKitsFor: Egypt + SH-06 offers the F-16V Block 70 kit (2200cr)
    // and the owned flag tracks player.upgrades
    var pB = { faction: 'Egypt', credits: 10000, upgrades: {} };
    var kitsB = researchKitsFor({ data: DATA }, pB, 'SH-06');
    var kitB = kitsB.length === 1 ? kitsB[0] : null;
    var ownedBefore = kitB && kitB.owned === false;
    pB.upgrades['EG-F16-70'] = true;
    var kitsB2 = researchKitsFor({ data: DATA }, pB, 'SH-06');
    __check('research-kits-egypt-sh06',
      !!kitB && kitB.id === 'EG-F16-70' && kitB.cost === 2200 && ownedBefore
        && kitsB2[0].owned === true,
      JSON.stringify(kitB) + ' ownedAfter=' + (kitsB2[0] && kitsB2[0].owned));

    // (c) stance buttons: own units selected -> AGG/DEF/HLD/HF in .bb-actions,
    // clicking DEF pushes a setStance command
    var stC = mkMatch(7);
    var gC = mkGame(stC);
    var c1 = addUnit(stC, 'EG-01', 0, 10 * 64 + 32, 10 * 64 + 32);
    var c2 = addUnit(stC, 'EG-01', 0, 12 * 64 + 32, 10 * 64 + 32);
    gC.selection = [c1.id, c2.id];
    updateHud(gC);
    var stanceBtns = {};
    walkAll(gC.hud.actions, function (el) {
      if (el.tagName === 'button' && /^(AGG|DEF|HLD|HF)$/.test(el.textContent || '')) {
        stanceBtns[el.textContent] = el;
      }
    });
    var nCmds = gC.pendingCmds.length;
    if (stanceBtns.DEF) stanceBtns.DEF.click();
    var cmdC = null;
    for (var ci2 = 0; ci2 < gC.pendingCmds.length; ci2++) {
      if (gC.pendingCmds[ci2].type === 'setStance') cmdC = gC.pendingCmds[ci2];
    }
    __check('stance-buttons-push-setStance',
      !!(stanceBtns.AGG && stanceBtns.DEF && stanceBtns.HLD && stanceBtns.HF)
        && gC.pendingCmds.length === nCmds + 1 && !!cmdC && cmdC.stance === 1
        && cmdC.player === 0 && cmdC.unitIds.length === 2
        && cmdC.unitIds.indexOf(c1.id) >= 0 && cmdC.unitIds.indexOf(c2.id) >= 0
        // FakeEl: className is a plain property, classList tracks only
        // add/remove/toggle — match the class token in the string instead
        && (' ' + stanceBtns.AGG.className + ' ').indexOf(' on ') >= 0,
      'btns=' + Object.keys(stanceBtns).join(',') + ' cmd=' + JSON.stringify(cmdC));

    // (d) research kit button: one owned SH-06 selected -> kit button with
    // label + cost; click pushes researchUpgrade; owned -> OWNED + disabled;
    // broke -> disabled and inert
    var stD = mkMatch(11);
    var gD = mkGame(stD);
    var af = addStructure(stD, 'SH-06', 0, 20, 20);
    stD.players[0].credits = 10000;
    gD.selection = [af.id];
    updateHud(gD);
    var kitBtn = null;
    walkAll(gD.hud.actions, function (el) {
      if (el.tagName === 'button' && (el.textContent || '').indexOf('F-16V Block 70') === 0) kitBtn = el;
    });
    var labelOk = !!kitBtn && kitBtn.textContent === 'F-16V Block 70 · 2200cr'
      && (kitBtn.className || '').indexOf('disabled') < 0;
    if (kitBtn) kitBtn.click();
    var cmdD = null;
    for (var di = 0; di < gD.pendingCmds.length; di++) {
      if (gD.pendingCmds[di].type === 'researchUpgrade') cmdD = gD.pendingCmds[di];
    }
    var pushOk = !!cmdD && cmdD.upgradeId === 'EG-F16-70' && cmdD.player === 0;
    // owned state: disabled OWNED button, no click listener attached
    stD.players[0].upgrades['EG-F16-70'] = true;
    updateHud(gD);
    var ownedBtn = null;
    walkAll(gD.hud.actions, function (el) {
      if (el.tagName === 'button' && el.textContent === 'OWNED') ownedBtn = el;
    });
    var ownedOk = !!ownedBtn && (ownedBtn.className || '').indexOf('disabled') >= 0;
    // unaffordable state: dimmed and inert
    delete stD.players[0].upgrades['EG-F16-70'];
    stD.players[0].credits = 0;
    updateHud(gD);
    var brokeBtn = null;
    walkAll(gD.hud.actions, function (el) {
      if (el.tagName === 'button' && (el.textContent || '').indexOf('F-16V Block 70') === 0) brokeBtn = el;
    });
    var nD = gD.pendingCmds.length;
    if (brokeBtn) brokeBtn.click();
    var brokeOk = !!brokeBtn && (brokeBtn.className || '').indexOf('disabled') >= 0
      && gD.pendingCmds.length === nD;
    __check('kit-button-research-upgrade', labelOk && pushOk && ownedOk && brokeOk,
      'label=' + (kitBtn && kitBtn.textContent) + ' cmd=' + JSON.stringify(cmdD)
        + ' owned=' + ownedOk + ' broke=' + brokeOk);

    // (d2) build-queue SFX: activating a build tile pushes the command and
    // plays 'build' through the guarded wrapper
    var stQ = mkMatch(13);
    addStructure(stQ, 'SH-01', 0, 8, 8);
    stQ.players[0].credits = 100000;
    var gQ = mkGame(stQ);
    updateHud(gQ);
    __sfxCalls.length = 0;
    var keyOk = gQ.hudKeyPress('Q');
    var cmdQ = gQ.pendingCmds.filter(function (c) { return c.type === 'buildStructure'; })[0];
    __check('build-sfx-on-queue',
      keyOk && !!cmdQ && __sfxCalls.indexOf('build') >= 0,
      'keyOk=' + keyOk + ' cmd=' + JSON.stringify(cmdQ) + ' sfx=' + __sfxCalls.join(','));

    // (e) alert stack: 5 rapid alerts -> capped at 4 cards
    var alertsRoot = document.getElementById('alerts');
    alertsRoot.innerHTML = '';
    for (var ai = 0; ai < 5; ai++) pushAlert(gC, 'Alert ' + ai, 100 + ai, 200);
    __check('alert-stack-cap-4', alertsRoot.children.length === 4,
      'children=' + alertsRoot.children.length);
    alertsRoot.innerHTML = '';

    // (f) voice bookkeeping: match-start seeds the snapshots silently (only
    // the 'online' line + ambient track fire); a newly added owned unit then
    // fires exactly one 'unit' voice
    __voices.length = 0; __tracks.length = 0;
    var stF = mkMatch(17);
    var gF = mkGame(stF);
    updateHud(gF); // stateRef reset: seed + online/ambient, nothing else
    var seedOk = __voices.join(',') === 'Egypt:online'
      && __tracks.length === 1 && __tracks[0] === 'ambient';
    __voices.length = 0;
    var fu = addUnit(stF, 'EG-01', 0, 15 * 64 + 32, 15 * 64 + 32);
    updateHud(gF);
    var unitOk = __voices.join(',') === 'Egypt:unit';
    __check('voice-seed-then-unit', seedOk && unitOk,
      'seed=[' + seedOk + '] after-add=' + __voices.join(','));

    // (f2) loss cues: the unit dying fires 'lost'; a structure appearing fires
    // 'built' (with the defId passed through for per-building lines), losing
    // it fires 'structLost'
    __voices.length = 0;
    delete stF.units[fu.id];
    var fs = addStructure(stF, 'SH-02', 0, 30, 30);
    updateHud(gF);
    var lossMix = __voices.join(',');
    __voices.length = 0;
    delete stF.structures[fs.id];
    updateHud(gF);
    __check('voice-loss-cues',
      lossMix.indexOf('Egypt:lost') >= 0 && lossMix.indexOf('Egypt:built:SH-02') >= 0
        && __voices.join(',') === 'Egypt:structLost',
      'mix=' + lossMix + ' after-struct-gone=' + __voices.join(','));

    // (h) pickOwnAt v0.4.1: unit vs structure under the same click — the unit
    // wins only inside the precise radius (22 wu); further out the structure
    // footprint wins. Unit-only / structure-only behave as before.
    var stP = mkMatch(29);
    for (var idP in stP.units) { if (stP.units[idP].owner === 0) delete stP.units[idP]; }
    var gP = { state: stP, playerSlot: 0 };
    var sh = addStructure(stP, 'SH-04', 0, 10, 10);
    var cwx = (sh.cx + sh.fp / 2) * CELL, cwy = (sh.cy + sh.fp / 2) * CELL;
    var pu = addUnit(stP, 'EG-01', 0, cwx + 15, cwy); // inside precise radius
    var hitPrecise = pickOwnAt(gP, cwx, cwy);
    stP.units[pu.id].x = cwx + 30; // 30 wu: inside pick radius (38), outside precise
    var hitLoose = pickOwnAt(gP, cwx, cwy);
    stP.units[pu.id].x = cwx + 500; // far away: structure-only
    var hitStructOnly = pickOwnAt(gP, cwx, cwy);
    var hitUnitOnly = pickOwnAt(gP, cwx + 500, cwy);
    __check('pick-own-precise-vs-footprint',
      hitPrecise && hitPrecise.id === pu.id
        && hitLoose && hitLoose.id === sh.id
        && hitStructOnly && hitStructOnly.id === sh.id
        && hitUnitOnly && hitUnitOnly.id === pu.id,
      'precise=' + (hitPrecise && hitPrecise.defId) + ' loose=' + (hitLoose && hitLoose.defId)
        + ' structOnly=' + (hitStructOnly && hitStructOnly.defId)
        + ' unitOnly=' + (hitUnitOnly && hitUnitOnly.defId));

    // (h2) pickHostileAt v0.4.1: radius = unitRadius + 8 — clicking the
    // visible body of an MBT (r 46 -> 54) connects; old flat 26 missed
    var foe = addUnit(stP, 'DZ-07', 1, 3000, 3000); // T-90, cls MBT
    // fog gate applies to the CLICK cell: reveal the foe's neighborhood
    for (var fdy = -1; fdy <= 1; fdy++) {
      for (var fdx = -1; fdx <= 2; fdx++) {
        var fqx = Math.floor(3000 / CELL) + fdx, fqy = Math.floor(3000 / CELL) + fdy;
        stP.fog[0].visible[fqy * stP.map.w + fqx] = 1;
      }
    }
    var foeHit = pickHostileAt(gP, 3000 + 46, 3000);
    var foeMiss = pickHostileAt(gP, 3000 + 70, 3000);
    var foeStruct = addStructure(stP, 'SH-02', 1, 40, 40);
    stP.fog[0].visible[40 * stP.map.w + 40] = 1;
    var foeStructHit = pickHostileAt(gP, 40 * CELL + 10, 40 * CELL + 10);
    __check('pick-hostile-radius-by-silhouette',
      foeHit && foeHit.id === foe.id && foeMiss === null
        && foeStructHit && foeStructHit.id === foeStruct.id,
      'hit=' + (foeHit && foeHit.defId) + ' miss=' + foeMiss
        + ' struct=' + (foeStructHit && foeStructHit.defId));

    // (f3) under-attack path: 'attack' voice + battle music through the wrappers
    __voices.length = 0; __tracks.length = 0;
    var fa = addUnit(stF, 'EG-01', 0, 20 * 64 + 32, 20 * 64 + 32);
    updateHud(gF); // register fa in the snapshot without a hit
    __voices.length = 0;
    dealDamage(stF, fa, 10, null);
    updateHud(gF);
    __check('under-attack-voice-and-battle',
      __voices.indexOf('Egypt:attack') >= 0 && __tracks.indexOf('battle') >= 0,
      'voices=' + __voices.join(',') + ' tracks=' + __tracks.join(','));

    // (f4) v0.9.1 battle-music timer: the 30s battle->ambient timeout carries a
    // per-match token — a stale timer from an abandoned match must NOT clobber
    // the new match's music when it finally fires
    var __timers = [];
    globalThis.setTimeout = function (fn, ms) { __timers.push(fn); return __timers.length; };
    globalThis.clearTimeout = function (id) { /* worst case: the stale fn survives */ };
    var stM1 = mkMatch(31);
    var gM = mkGame(stM1);
    var uM1 = addUnit(stM1, 'EG-01', 0, 20 * 64 + 32, 20 * 64 + 32);
    updateHud(gM); // match A: stateRef set, snapshots seeded
    __tracks.length = 0;
    dealDamage(stM1, uM1, 10, null);
    updateHud(gM); // battle music + the 30s timer captured (matchRef = stM1)
    // pushAlert's showHint books fade/drop timers first — the battle timer is
    // always the LAST one scheduled by the alert
    var timerScheduled = __timers.length >= 1;
    var battleFnA = __timers[__timers.length - 1];
    // positive control: same match -> firing the timer returns to ambient
    __tracks.length = 0;
    battleFnA();
    var sameMatchOk = __tracks.join(',') === 'ambient' && gM.hud.battleTimer === null;
    // match B replaces match A on the SAME hud: the reset plays its own
    // ambient; when the stale match-A timer fires afterwards it must no-op
    var stM2 = mkMatch(37);
    gM.state = stM2;
    updateHud(gM);
    // the match-A closure survives the reset (clearTimeout is a no-op stub —
    // the worst case the token guard protects against)
    var staleFn = battleFnA;
    __timers.length = 0;
    __tracks.length = 0; // drop the reset's ambient track
    staleFn(); // the stale match-A timer fires 30s "later"
    var staleOk = __tracks.length === 0;
    // and a fresh alert in match B still gets its own working timer
    var uM2 = addUnit(stM2, 'EG-01', 0, 20 * 64 + 32, 20 * 64 + 32);
    updateHud(gM);
    __timers.length = 0;
    dealDamage(stM2, uM2, 10, null);
    updateHud(gM);
    var battleFnB = __timers[__timers.length - 1];
    var freshScheduled = __timers.length >= 1 && battleFnB !== battleFnA;
    __tracks.length = 0;
    battleFnB();
    var freshOk = __tracks.join(',') === 'ambient';
    delete globalThis.setTimeout;
    delete globalThis.clearTimeout;
    __check('battle-music-timer-match-token',
      timerScheduled && sameMatchOk && staleOk && freshScheduled && freshOk,
      'scheduled=' + timerScheduled + ' same=' + sameMatchOk
        + ' stale=' + staleOk + ' fresh=' + freshScheduled + '/' + freshOk);

    // (g) end-of-match stingers: wiping player 1 -> 'victory' (once); wiping
    // the local player -> 'defeat'
    var stW = mkMatch(19);
    var gW = mkGame(stW);
    updateHud(gW);
    for (var idW in stW.units) if (stW.units[idW].owner === 1) delete stW.units[idW];
    for (var idW2 in stW.structures) {
      if (stW.structures[idW2].owner === 1) delete stW.structures[idW2];
    }
    stW.players[1].credits = 0;
    for (var tW = 0; tW < 5 && !stW.over; tW++) tick(stW);
    __sfxCalls.length = 0;
    updateHud(gW);
    updateHud(gW); // must not repeat the stinger
    var victoryOk = stW.over && __sfxCalls.join(',') === 'victory';
    var stL = mkMatch(23);
    var gL = mkGame(stL);
    updateHud(gL);
    for (var idL in stL.units) if (stL.units[idL].owner === 0) delete stL.units[idL];
    for (var idL2 in stL.structures) {
      if (stL.structures[idL2].owner === 0) delete stL.structures[idL2];
    }
    stL.players[0].credits = 0;
    for (var tL = 0; tL < 5 && !stL.players[0].eliminated; tL++) tick(stL);
    __sfxCalls.length = 0;
    updateHud(gL);
    __check('end-stingers',
      victoryOk && stL.players[0].eliminated && __sfxCalls.join(',') === 'defeat',
      'victory=' + victoryOk + ' over=' + stW.over + ' elim=' + stL.players[0].eliminated
        + ' sfx=' + __sfxCalls.join(','));
  } catch (e) {
    __t.errors.push('driver: ' + (e && e.stack || e));
  }
  return __t;
})()
"""


def main() -> int:
    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    ctx = MiniRacer()
    payload = (CLIENT / "data/game.json").read_text(encoding="utf-8")
    ctx.eval(f"var __jsonGame = {json.dumps(payload)};")
    maps = {"duel": (CLIENT / "maps/duel.json").read_text(encoding="utf-8")}
    ctx.eval(f"var __jsonMaps = {json.dumps(maps)};")
    ctx.eval(STUB_JS)
    ctx.eval(AUDIO_STUB_JS)
    ctx.eval(bundle)
    result = json.loads(ctx.eval("JSON.stringify(" + DRIVER + ")"))
    passed = 0
    for c in result["checks"]:
        print(f"{'PASS' if c['pass'] else 'FAIL'}  {c['name']}  --  {c.get('detail', '')}")
        passed += 1 if c["pass"] else 0
    for e in result["errors"]:
        print("ERROR:", e)
    print(f"{passed}/{len(result['checks'])} passed")
    return 0 if passed == len(result["checks"]) and not result["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())

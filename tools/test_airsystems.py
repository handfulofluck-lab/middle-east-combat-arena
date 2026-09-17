# v0.9.0 air systems: CAP idle circling (orbit around the anchor, returns
# each cycle, still acquires/fire), air ammo -> auto rearm at the NEAREST
# airfield -> 50-tick park -> resume, no-airfield fallback, checksum
# determinism with ammo/rearm/circling in play, and role-based formation
# offsets (fighters lead toward the destination, strike air trails).
# v0.9.1 hostile internal audit: rearm aborts when the airfield is captured
# (mid-park AND mid-flight, frame stays dry), and the CAP circle's Math.cos/
# sin was replaced by integer LUTs — the tests here prove the LUT targets and
# live positions stay byte-identical to the pre-fix transcendental path.
# Usage: tools/.venv/Scripts/python tools/test_airsystems.py
import json
import re
import sys
from pathlib import Path

from py_mini_racer import MiniRacer

CLIENT = Path(__file__).resolve().parent.parent / "client"
MODULES = [
    "src/sim/rng.js",
    "src/sim/state.js",
    "src/sim/orders.js",
    "src/sim/path.js",
    "src/sim/combat.js",
    "src/sim/economy.js",
    "src/sim/engine.js",
    "src/sim/ai.js",
]


def inline(path: Path) -> str:
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"import\s+[\s\S]*?\sfrom\s*'[^']*';", "", src)
    src = re.sub(r"export\s*\{[\s\S]*?\}\s*from\s*'[^']*';", "", src)
    src = re.sub(r"^export\s+(async function|function|const|let)", r"\1", src, flags=re.M)
    src = re.sub(r"^export\s*\{[\s\S]*?\};", "", src, flags=re.M)
    return src


TEST_JS = r"""
function runAirTests(data, duel) {
  const out = [];
  const push = (name, pass, detail) => out.push({ name, pass: !!pass,
    detail: String(detail || '') });
  const mk = (players, seed) => createMatch({
    data, map: JSON.parse(JSON.stringify(duel)), players, seed: seed || 7 });
  const infId = data.units
    .filter((u) => u.faction === 'Algeria' && u.cls === 'Infantry')
    .sort((a, b) => a.cost - b.cost)[0].id;

  // (a) CAP circling: an idle jet orbits its anchor (2-cell radius), leaves
  // the anchor, and comes back near its starting point every 30-tick cycle
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const jet = addUnit(st, 'EG-10', 0, 50 * 64 + 32, 50 * 64 + 32);
    const ax = jet.x, ay = jet.y;
    const step = st.unitDefs['EG-10'].step;
    let minD = Infinity, maxD = 0, moved = false;
    let cycRef = null, cycErr = Infinity;
    for (let t = 0; t < 70; t++) {
      tick(st);
      const d = Math.sqrt(dist2(jet.x, jet.y, ax, ay));
      if (t < 60) { minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
      if (d > 0) moved = true;
      if (t === 19) cycRef = { x: jet.x, y: jet.y };
      if (t === 49 && cycRef) { // one full 360deg cycle later (30 ticks)
        cycErr = Math.sqrt(dist2(jet.x, jet.y, cycRef.x, cycRef.y));
      }
    }
    const anchorKept = jet.guardX === ax && jet.guardY === ay;
    push('CAP: idle jet circles anchor, returns each cycle',
      moved && minD >= 32 && maxD <= 224 && cycErr <= 2 * step && anchorKept,
      JSON.stringify({ moved, minD: Math.round(minD), maxD: Math.round(maxD),
        cycErr: Math.round(cycErr), step }));
  }

  // (b) ammo -> rearm at nearest airfield -> 50-tick park -> refill ->
  //     resume the prior attackTarget and fight again
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const near = addStructure(st, 'SH-06', 0, 28, 50);
    const far = addStructure(st, 'SH-06', 0, 90, 50);
    const fx = 40 * 64 + 32, fy = 50 * 64 + 32;
    const jet = addUnit(st, 'EG-10', 0, fx, fy);
    const dummy = addUnit(st, infId, 1, fx + 5 * 64, fy);
    dummy.hp = 100000; dummy.maxHp = 100000;
    applyCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [jet.id], targetId: dummy.id });
    let sawRearm = false, rearmTarget = 0, sawPark = false, refillAmmo = -1;
    let resumedOrder = '', resumedFire = false, hpAtRefill = 0;
    for (let t = 0; t < 1500; t++) {
      tick(st);
      const u = st.units[jet.id];
      if (!u) break;
      if (u.order.type === 'rearm') {
        sawRearm = true;
        rearmTarget = u.order.targetId;
      }
      if (u.rearming > 0) sawPark = true;
      if (refillAmmo < 0 && sawPark && u.rearming === 0) {
        refillAmmo = u.ammo;          // park just ended -> ammo restored
        hpAtRefill = dummy.hp;
        resumedOrder = u.order.type;    // prior attackTarget should be back
      }
      if (refillAmmo >= 0 && dummy.hp < hpAtRefill) { resumedFire = true; break; }
    }
    const nc = structCenter(near);
    push('ammo dry -> rearm nearest airfield -> park 50 -> resume',
      sawRearm && rearmTarget === near.id && sawPark && refillAmmo === 6
        && resumedOrder === 'attackTarget' && resumedFire,
      JSON.stringify({ sawRearm, rearmTarget, wantTarget: near.id, sawPark,
        refillAmmo, resumedOrder, resumedFire }));
  }

  // (c) no airfield: dry frame fires its last rounds, then just idles and
  //     holds fire (no crash, no negative ammo, no further damage)
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const jet = addUnit(st, 'EG-10', 0, 40 * 64 + 32, 50 * 64 + 32);
    const dummy = addUnit(st, infId, 1, 45 * 64 + 32, 50 * 64 + 32);
    dummy.hp = 100000; dummy.maxHp = 100000;
    const hp0 = dummy.hp;
    let wentIdle = false, idleHp = 0;
    for (let t = 0; t < 900; t++) {
      tick(st);
      const u = st.units[jet.id];
      if (u && u.ammo === 0 && u.order.type === 'idle' && !wentIdle) {
        wentIdle = true;
        idleHp = dummy.hp;
      }
    }
    const jetOk = st.units[jet.id] && st.units[jet.id].ammo === 0;
    const dmg = hp0 - dummy.hp;
    push('no airfield: dry frame idles, holds fire',
      wentIdle && jetOk && dmg > 0 && dmg <= 6 * 8 && dummy.hp === idleHp,
      JSON.stringify({ wentIdle, ammo: st.units[jet.id] && st.units[jet.id].ammo,
        dmg, afterIdle: idleHp - dummy.hp }));
  }

  // (d) determinism: identical scripted run twice -> identical checksum
  //     stream while circling + rearm + refill are all in play
  {
    const sums = [];
    for (let run = 0; run < 2; run++) {
      const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 33);
      addStructure(st, 'SH-06', 0, 28, 50);
      const jet = addUnit(st, 'EG-10', 0, 40 * 64 + 32, 50 * 64 + 32);
      const dummy = addUnit(st, infId, 1, 45 * 64 + 32, 50 * 64 + 32);
      dummy.hp = 100000; dummy.maxHp = 100000;
      const runSums = [];
      for (let t = 0; t < 900; t++) {
        tick(st);
        if ((t + 1) % 25 === 0) runSums.push(checksum(st));
      }
      sums.push(runSums.join('/'));
    }
    push('checksum determinism with air systems', sums[0] === sums[1],
      sums[0].slice(0, 60) + (sums[0] === sums[1] ? ' (identical x2)' : ' vs ' + sums[1]));
  }

  // (e) formationOffsetsAir: fighters lead toward the destination, strike
  //     air trails rear-center; single unit -> null; sim accepts the offsets
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const f1 = addUnit(st, 'DZ-16', 0, 20 * 64 + 32, 20 * 64 + 32); // Fighter
    const f2 = addUnit(st, 'DZ-16', 0, 21 * 64 + 32, 20 * 64 + 32);
    const s1 = addUnit(st, 'DZ-17', 0, 20 * 64 + 32, 21 * 64 + 32); // Strike jet
    const s2 = addUnit(st, 'DZ-17', 0, 21 * 64 + 32, 21 * 64 + 32);
    const ids = [f1.id, f2.id, s1.id, s2.id];
    const dest = { x: 40 * 64, y: 40 * 64 };
    const offs = formationOffsetsAir(st, ids, dest.x, dest.y);
    // heading as computed by the helper: centroid -> dest
    const cx = Math.round((f1.x + f2.x + s1.x + s2.x) / 4);
    const cy = Math.round((f1.y + s2.y + f2.y + s1.y) / 4);
    let hx = dest.x - cx, hy = dest.y - cy;
    const len = Math.sqrt(hx * hx + hy * hy);
    hx /= len; hy /= len;
    const dot = (o) => Math.round(o.x * hx + o.y * hy);
    const lead = [dot(offs[0]), dot(offs[1])];
    const trail = [dot(offs[2]), dot(offs[3])];
    const aligned = offs.length === 4
      && offs.every((o) => Number.isInteger(o.x) && Number.isInteger(o.y));
    const single = formationOffsetsAir(st, [f1.id], dest.x, dest.y);
    const allFighters = formationOffsetsAir(st, [f1.id, f2.id], dest.x, dest.y);
    const fighterOnlyLeads = allFighters.every((o) => dot(o) > 0);
    // the sim's offset validation accepts them on a real move command
    const mv = validateCommand(st, { player: 0, type: 'move',
      unitIds: ids, x: dest.x, y: dest.y, offsets: offs });
    push('formationOffsetsAir roles: fighters front, strike rear',
      aligned && lead.every((d) => d > 0) && trail.every((d) => d < 0)
        && single === null && fighterOnlyLeads && mv.ok,
      JSON.stringify({ lead, trail, single, fighterOnlyLeads, mv: mv.ok }));
  }

  // (f) circling does not break acquisition: an idle jet with an enemy in
  //     sight acquires and fires (volleys land on the dummy)
  {
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const jet = addUnit(st, 'EG-10', 0, 50 * 64 + 32, 50 * 64 + 32);
    const dummy = addUnit(st, infId, 1, 56 * 64 + 32, 50 * 64 + 32);
    dummy.hp = 100000; dummy.maxHp = 100000;
    let fired = false;
    for (let t = 0; t < 200 && !fired; t++) {
      tick(st);
      if (dummy.hp < 100000) fired = true;
    }
    push('circling jet still acquires + fires', fired,
      JSON.stringify({ fired, dummyHp: dummy.hp }));
  }

  // (g) rearm aborts when the airfield is CAPTURED (v0.9.1 hostile audit P2):
  //     mid-park or mid-flight, an owner flip cuts the rearm short — the
  //     frame drops to idle and STAYS DRY (pre-fix a full rearm completed at
  //     an enemy-captured field).
  {
    // mid-park capture
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const af = addStructure(st, 'SH-06', 0, 28, 50);
    const fx = 40 * 64 + 32, fy = 50 * 64 + 32;
    const jet = addUnit(st, 'EG-10', 0, fx, fy);
    const dummy = addUnit(st, infId, 1, fx + 5 * 64, fy);
    dummy.hp = 100000; dummy.maxHp = 100000;
    applyCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [jet.id], targetId: dummy.id });
    let flipped = false, sawPark = false, hpAtFlip = 0;
    let orderAfter = '', ammoAfter = -1;
    for (let t = 0; t < 1500; t++) {
      tick(st);
      const u = st.units[jet.id];
      if (!u) break;
      if (u.rearming > 0) {
        sawPark = true;
        if (!flipped) {
          af.owner = 1; // engineer-style capture while parked on the pad
          hpAtFlip = dummy.hp;
          flipped = true;
        }
      }
      if (flipped && u.order.type !== 'rearm') {
        orderAfter = u.order.type;
        ammoAfter = u.ammo;
        break;
      }
    }
    // never refilled, never resumed firing at the dummy
    let stayedDry = false;
    if (flipped) {
      stayedDry = true;
      for (let t = 0; t < 200 && stayedDry; t++) {
        tick(st);
        const u = st.units[jet.id];
        if (!u) break;
        if (u.ammo !== 0 || dummy.hp !== hpAtFlip) stayedDry = false;
      }
    }
    push('rearm aborts on captured airfield (mid-park, stays dry)',
      flipped && sawPark && orderAfter === 'idle' && ammoAfter === 0 && stayedDry,
      JSON.stringify({ flipped, sawPark, orderAfter, ammoAfter, stayedDry }));
  }
  {
    // mid-flight capture: the field flips while the frame is still en route
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }]);
    const af = addStructure(st, 'SH-06', 0, 28, 50);
    const jet = addUnit(st, 'EG-10', 0, 40 * 64 + 32, 50 * 64 + 32);
    const dummy = addUnit(st, infId, 1, 45 * 64 + 32, 50 * 64 + 32);
    dummy.hp = 100000; dummy.maxHp = 100000;
    applyCommand(st, { player: 0, type: 'attackTarget',
      unitIds: [jet.id], targetId: dummy.id });
    let flipped = false, orderAfter = '', ammoAfter = -1;
    for (let t = 0; t < 1500; t++) {
      tick(st);
      const u = st.units[jet.id];
      if (!u) break;
      if (!flipped && u.order.type === 'rearm') {
        af.owner = 1; // captured while still flying in
        flipped = true;
      } else if (flipped && u.order.type !== 'rearm') {
        orderAfter = u.order.type;
        ammoAfter = u.ammo;
        break;
      }
    }
    push('rearm aborts on captured airfield (mid-flight, stays dry)',
      flipped && orderAfter === 'idle' && ammoAfter === 0,
      JSON.stringify({ flipped, orderAfter, ammoAfter }));
  }

  // (h) CAP LUT determinism (v0.9.1): the integer LUTs must reproduce the
  //     pre-fix Math.cos/sin targets EXACTLY — all 360 phase residues, and
  //     end-to-end positions over a live circling scenario.
  {
    // ids 0..11 cover every mod-12 phase-offset class (id*37 mod 360), and
    // 30 ticks cover every 12-degree step of the holding circle
    let bad = null;
    for (let id = 0; id < 12 && !bad; id++) {
      for (let k = 0; k < 30 && !bad; k++) {
        const phase = (((id * 37) % 360) + 360) % 360 + k * 12;
        const got = capTarget({ id, guardX: 0, guardY: 0, capTick: 0 }, k);
        const wx = Math.round(2 * 64 * Math.cos(phase * Math.PI / 180));
        const wy = Math.round(2 * 64 * Math.sin(phase * Math.PI / 180));
        if (got.x !== wx || got.y !== wy) bad = { id, k, phase, got, want: [wx, wy] };
      }
    }
    push('CAP LUT == cos/sin formula for all 360 phases', !bad,
      JSON.stringify(bad || { phases: 360, ok: true }));
  }
  {
    // end-to-end: the live engine's circling positions must equal an
    // independent replication of the pre-fix engine math (old phase formula
    // + verbatim moveTowards step; the jet circles alone in open desert, so
    // every candidate cell is passable and the replica is exact)
    const st = mk([{ faction: 'Egypt', slot: 0 }, { faction: 'Algeria', slot: 1 }], 33);
    const jet = addUnit(st, 'EG-10', 0, 50 * 64 + 32, 50 * 64 + 32);
    const step = st.unitDefs['EG-10'].step;
    let ex = jet.x, ey = jet.y, capTick = -1, gx = 0, gy = 0, maxPhase = 0;
    let mismatch = null;
    for (let t = 0; t < 700 && !mismatch; t++) {
      tick(st);
      const u = st.units[jet.id];
      if (!u) break;
      if (capTick < 0) { capTick = t; gx = ex; gy = ey; }
      const phase = (((u.id * 37) % 360) + 360) % 360 + (t - capTick) * 12;
      maxPhase = Math.max(maxPhase, phase);
      const rad = phase * Math.PI / 180; // pre-fix engine math, verbatim
      const tx = gx + Math.round(2 * 64 * Math.cos(rad));
      const ty = gy + Math.round(2 * 64 * Math.sin(rad));
      const dx = tx - ex, dy = ty - ey; // moveTowards replica
      if (dx * dx + dy * dy > 0) {
        let mx = Math.max(-step, Math.min(step, dx));
        let my = Math.max(-step, Math.min(step, dy));
        if (Math.abs(mx) + Math.abs(my) > step) {
          my = Math.max(-(step - Math.abs(mx)), Math.min(step - Math.abs(mx), dy));
        }
        ex += mx; ey += my;
      }
      if (u.x !== ex || u.y !== ey) mismatch = { t, exp: [ex, ey], got: [u.x, u.y] };
    }
    push('CAP positions byte-identical to pre-fix cos/sin path (700 ticks)',
      !mismatch, JSON.stringify(mismatch || { ticks: 700, maxPhase }));
  }
  return out;
}
"""


def main() -> int:
    bundle = "\n;\n".join(inline(CLIENT / m) for m in MODULES)
    ctx = MiniRacer()
    for name, rel in (("__data", "data/game.json"), ("__duel", "maps/duel.json")):
        payload = (CLIENT / rel).read_text(encoding="utf-8")
        ctx.eval(f"var {name} = {json.dumps(payload)};")
    ctx.eval(bundle)
    ctx.eval(TEST_JS)
    results = json.loads(ctx.eval(
        "JSON.stringify(runAirTests(JSON.parse(__data), JSON.parse(__duel)))"
    ))
    passed = 0
    for r in results:
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}  --  {r.get('detail', '')}")
        passed += 1 if r["pass"] else 0
    print(f"{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Generate dist/MCA_Reference.html — a self-contained units & structures
field manual for MCA, built from client/data/game.json.

One tab per faction + a shared-structures tab. No external assets; plain
HTML/CSS/JS so it works from file:// (double-click).
"""
import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "client", "data", "game.json")
OUT = os.path.join(ROOT, "dist", "MCA_Reference.html")

DOMAIN_ORDER = ["Land", "Air", "Sea"]
CLASS_ORDER = ["Infantry", "AT inf", "AA inf", "SF", "IFV", "MBT", "SPG/MLRS",
               "Support", "Helo", "Fighter", "UAV", "SAM", "Naval"]

PERK_TEXT = {
    "cheap_cy_rebuild": lambda p: f"Construction Yard rebuild is {int(p['value']*100)}% cheaper (once)",
    "oil_income_mult": lambda p: f"Oil income +{int(round((p['value']-1)*100))}%",
    "early_build_speed": lambda p: f"+{int(p['value']*100)}% build speed for the first {int(p['until_s']/60)} minutes",
    "war_factory_discount": lambda p: f"War Factory costs {int(p['value']*100)}% less",
    "unit_build_speed": lambda p: f"{p['unit_name']} builds {int(p['value']*100)}% faster",
}

ABILITY_TEXT = {
    "saka_insertion": "Sa'ka Insertion — heli-drop 4 rifle squads at any visible point (90s cooldown)",
    "rsaf_tasking": "RSAF Tasking — call an off-map airstrike (90s cooldown)",
    "edge_network": "EDGE Network — all units gain +2 sight (passive)",
    "integrated_sky": "Integrated Sky — your AA deals +20% damage vs aircraft (passive)",
    "siha_mesh": "SiHA Mesh — +20% engagement range vs aircraft (passive)",
    "iron_layer": "Iron Layer — Iron Dome intercepts rockets/cruise missiles; Merkava/Namer Trophy APS eats one ATGM volley every 20s (passive)",
    "brahmos_lane": "BrahMos Lane — fire a heavy missile down a drawn corridor (90s cooldown)",
    "babur_window": "Babur Window — launch 2 cruise missiles at a target (90s cooldown)",
    "shahed_rain": "Shahed Rain — launch 5 one-way drones at an area (90s cooldown)",
}

STRUCT_TYPE_TEXT = {
    "Core": "Core", "Eco": "Economy", "Prod": "Production", "Tech": "Tech",
    "Def": "Defense", "Unique": "Unique", "SW": "Superweapon",
}


def esc(s):
    return html.escape(str(s if s is not None else ""))


def fmt(v):
    if v is None or v == "":
        return "-"
    f = float(v)
    return str(int(f)) if f == int(f) else f"{f:g}"


def dps(dmg, rof):
    return (float(dmg) / float(rof)) if rof else 0.0


def unit_row(u):
    d = u["dmg"]
    rof = u["rof_s"] or 1.0
    cells = [
        f"<td class=name>{esc(u['name'])}</td>",
        f"<td>{esc(u['cls'])}</td>",
        f"<td>{esc(u['role'])}</td>",
        f"<td class=num>{fmt(u['cost'])}</td>",
        f"<td class=num>{fmt(u['build_s'])}s</td>",
        f"<td class=num>{fmt(u['hp'])}</td>",
        f"<td>{esc(u['armor'])}</td>",
        f"<td class=num>{fmt(u['speed'])}</td>",
        f"<td class=num>{fmt(u['range'])}</td>",
        f"<td class=num>{fmt(u['rof_s'])}s</td>",
        f"<td class=num>{fmt(dps(d['inf'], rof))}</td>",
        f"<td class=num>{fmt(dps(d['armor'], rof))}</td>",
        f"<td class=num>{fmt(dps(d['air'], rof))}</td>",
        f"<td class=num>{fmt(dps(d['bldg'], rof))}</td>",
    ]
    detail = []
    if u.get("ability"):
        detail.append(f"<b>Ability:</b> {esc(u['ability'])}")
    if u.get("softCounter"):
        detail.append(f"<b>Threatened by (soft):</b> {esc(u['softCounter'])}")
    if u.get("hardCounter"):
        detail.append(f"<b>Beaten by (hard):</b> {esc(u['hardCounter'])}")
    extra = f"<tr class=detail><td colspan=14>{' &nbsp;|&nbsp; '.join(detail)}</td></tr>" if detail else ""
    return "<tr>" + "".join(cells) + "</tr>" + extra


UNIT_TABLE_HEAD = (
    "<tr><th>Unit</th><th>Class</th><th>Role</th><th>Cost</th><th>Build</th>"
    "<th>HP</th><th>Armor</th><th>Speed</th><th>Range</th><th>ROF</th>"
    "<th>DPS vs Inf</th><th>DPS vs Armor</th><th>DPS vs Air</th><th>DPS vs Bldg</th></tr>"
)


def struct_row(s, knobs):
    power = ""
    if s["power_out"]:
        power = f"+{fmt(s['power_out'])}"
    elif s["power_use"]:
        power = f"-{fmt(s['power_use'])}"
    # armed structures (Def towers, v0.3) carry range/rof/dmg on the sheet
    rof = s.get("rof_s") or 0
    dmg = s.get("dmg") or {}
    dps_txt = "-"
    if rof and dmg:
        best_col, best_dmg = max(dmg.items(), key=lambda kv: float(kv[1]))
        if float(best_dmg) > 0:
            dps_txt = f"{fmt(float(best_dmg) / rof)} vs {best_col.capitalize()}"
    cells = [
        f"<td class=name>{esc(s['name'])}</td>",
        f"<td>{esc(STRUCT_TYPE_TEXT.get(s['type'], s['type']))}</td>",
        f"<td class=num>{fmt(s['cost'])}</td>",
        f"<td class=num>{fmt(s['build_s'])}s</td>",
        f"<td class=num>{fmt(s['hp'])}</td>",
        f"<td class=num>{fmt(s.get('range') or None)}</td>",
        f"<td class=num>{dps_txt}</td>",
        f"<td class=num>{power or '-'}</td>",
        f"<td>{esc(s['unlocks'])}</td>",
    ]
    return "<tr>" + "".join(cells) + "</tr>"


STRUCT_TABLE_HEAD = (
    "<tr><th>Structure</th><th>Type</th><th>Cost</th><th>Build</th>"
    "<th>HP</th><th>Range</th><th>DPS</th><th>Power</th><th>Unlocks / Function</th></tr>"
)


def faction_tab(name, meta, units, structures, knobs, intercept_factions):
    color = meta["color"]
    parts = [f"<div class=tab id=tab-{esc(name.replace(' ', ''))}>"]
    parts.append(f"<h2 style='border-color:{color}'>{esc(name)} "
                 f"<span class=identity>{esc(meta['identity'])}</span></h2>")
    facts = []
    if meta.get("econPerk"):
        facts.append(f"<b>Economy perk:</b> {esc(PERK_TEXT[meta['econPerk']['type']](meta['econPerk']))}")
    if meta.get("ability") in ABILITY_TEXT:
        facts.append(f"<b>Faction ability:</b> {esc(ABILITY_TEXT[meta['ability']])}")
    ik = meta.get("superweaponIntercept")
    if ik and ik in knobs:
        users = ", ".join(intercept_factions.get(ik, []))
        facts.append(f"<b>Superweapon shield:</b> {esc(ik.replace('Intercept', ''))} — "
                     f"{int(knobs[ik]*100)}% intercept chance per incoming projectile ({esc(users)})")
    if facts:
        parts.append("<div class=facts>" + "<br>".join(facts) + "</div>")

    by_domain = {d: [] for d in DOMAIN_ORDER}
    for u in units:
        by_domain.setdefault(u["domain"] if u["domain"] in DOMAIN_ORDER else "Land", []).append(u)
    for dom in DOMAIN_ORDER:
        group = by_domain.get(dom) or []
        if not group:
            continue
        group.sort(key=lambda u: (CLASS_ORDER.index(u["cls"]) if u["cls"] in CLASS_ORDER else 99,
                                  u["cost"]))
        parts.append(f"<h3>{esc(dom)} units ({len(group)})</h3>")
        parts.append("<table>" + UNIT_TABLE_HEAD +
                     "".join(unit_row(u) for u in group) + "</table>")

    own = [s for s in structures if s["faction"] == name]
    if own:
        parts.append(f"<h3>{esc(name)}-specific structures ({len(own)})</h3>")
        parts.append("<table>" + STRUCT_TABLE_HEAD +
                     "".join(struct_row(s, knobs) for s in own) + "</table>")
    parts.append("</div>")
    return "\n".join(parts)


def shared_tab(structures, knobs):
    shared = [s for s in structures if s["faction"] == "All"]
    order = {"Core": 0, "Eco": 1, "Prod": 2, "Tech": 3, "Def": 4, "Unique": 5, "SW": 6}
    shared.sort(key=lambda s: (order.get(s["type"], 9), s["cost"]))
    return (f"<div class=tab id=tab-Shared><h2>Shared structures "
            f"<span class=identity>available to all factions</span></h2>"
            "<table>" + STRUCT_TABLE_HEAD +
            "".join(struct_row(s, knobs) for s in shared) + "</table></div>")


def main():
    g = json.load(open(DATA, encoding="utf-8"))
    knobs = g["knobs"]
    factions = g["factions"]
    units = g["units"]
    structures = g["structures"]
    intercept_factions = g.get("interceptFactions", {})

    nav = []
    tabs = []
    for name, meta in factions.items():
        fid = name.replace(" ", "")
        nav.append(f"<button data-tab=tab-{fid} style='--fc:{meta['color']}'>{esc(name)}</button>")
        funits = [u for u in units if u["faction"] == name]
        tabs.append(faction_tab(name, meta, funits, structures, knobs, intercept_factions))
    nav.append("<button data-tab=tab-Shared style='--fc:#888'>Shared Structures</button>")
    tabs.append(shared_tab(structures, knobs))

    econ = (f"Start credits {fmt(knobs.get('StartCredits'))} &nbsp;·&nbsp; "
            f"Oil field {fmt(knobs.get('OilIncomePerField'))} cr/s &nbsp;·&nbsp; "
            f"Power plant +{fmt(knobs.get('PowerPlantOutput'))} &nbsp;·&nbsp; "
            f"Low power = {int(knobs.get('LowPowerPenalty', 0.4)*100)}% slower production")

    page = TEMPLATE.replace("__NAV__", "\n".join(nav)) \
                   .replace("__TABS__", "\n".join(tabs)) \
                   .replace("__ECON__", econ) \
                   .replace("__VERSION__", esc(g.get("version", "")))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(page)
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes), "
          f"{len(factions)} faction tabs + shared, {len(units)} units, {len(structures)} structures")


TEMPLATE = """<!DOCTYPE html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>MCA — Units & Structures Reference</title>
<style>
:root{--bg:#0c0e12;--panel:#14171d;--line:#2a2f3a;--text:#dfe3ea;--dim:#8b93a3}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
header{padding:18px 24px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:20px;letter-spacing:2px}
.subtitle{color:var(--dim);margin-top:4px;font-size:12px;letter-spacing:1px;text-transform:uppercase}
nav{display:flex;flex-wrap:wrap;gap:6px;padding:12px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
nav button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-bottom:2px solid var(--fc,#888);padding:7px 14px;border-radius:5px;cursor:pointer;font:inherit;font-size:12px;letter-spacing:1px;text-transform:uppercase}
nav button:hover{background:#1c212a}
nav button.active{background:#232935;border-color:var(--fc,#888)}
main{padding:8px 24px 60px}
.tab{display:none}
.tab.active{display:block}
h2{font-size:17px;letter-spacing:1px;border-left:4px solid #888;padding-left:10px;margin:26px 0 4px}
h2 .identity{color:var(--dim);font-size:12px;font-weight:400;letter-spacing:2px;text-transform:uppercase;margin-left:8px}
h3{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);margin:22px 0 6px}
.facts{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 14px;margin:10px 0;font-size:13px}
table{border-collapse:collapse;width:100%;margin:6px 0 10px;font-size:12.5px}
th{background:var(--panel);color:var(--dim);text-transform:uppercase;letter-spacing:1px;font-size:10.5px;text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);position:sticky;top:49px}
td{padding:5px 8px;border-bottom:1px solid #1d222b;vertical-align:top}
td.name{font-weight:600;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.detail td{color:var(--dim);font-size:11.5px;padding-top:0;border-bottom:1px solid var(--line)}
tr:hover td{background:#161a22}
footer{padding:16px 24px;border-top:1px solid var(--line);color:var(--dim);font-size:11px;letter-spacing:1px}
</style>
</head>
<body>
<header>
<h1>MIDDLE EAST COMBAT ARENA — UNITS &amp; STRUCTURES</h1>
<div class=subtitle>Field manual · generated from ASH-SHARQ stat sheet v__VERSION__ · __ECON__</div>
</header>
<nav>
__NAV__
</nav>
<main>
__TABS__
</main>
<footer>MCA — Middle East Combat Arena · Balance data: ASH-SHARQ Nine-Faction Stat Sheet · DPS = damage per volley ÷ rate of fire, before armor multipliers</footer>
<script>
const btns=document.querySelectorAll('nav button'),tabs=document.querySelectorAll('.tab');
function show(id){tabs.forEach(t=>t.classList.toggle('active',t.id===id));btns.forEach(b=>b.classList.toggle('active',b.dataset.tab===id));}
btns.forEach(b=>b.onclick=()=>show(b.dataset.tab));
if(btns.length)show(btns[0].dataset.tab);
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()

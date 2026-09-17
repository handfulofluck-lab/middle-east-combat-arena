#!/usr/bin/env python3
"""Export ASH-SHARQ stat sheet (xlsx) -> client/data/game.json for MCA.

Reads:  attachments/stat_sheet.xlsx
Writes: client/data/game.json

Damage model note: the sim uses the per-armor-class damage columns
(Dmg_Inf/Light/Armor/Air/Bldg) multiplied by the incoming armor-class
multiplier knobs (LightArmorMult/MedArmorMult/HeavyArmorMult).
The 04_COUNTERS class-vs-class matrix is exported for reference but is NOT
applied on top (the sheet says it is a design reminder, not auto-applied).
"""
import json
import os
import sys

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
XLSX = os.path.join(ROOT, "attachments", "stat_sheet.xlsx")
OUT = os.path.join(ROOT, "client", "data", "game.json")

ARMOR_INCOMING = {"Soft": 1.0, "Air": 1.0, "Naval": 1.0}  # Light/Medium/Heavy come from knobs

# Faction metadata from GDD v0.1 + v0.2 (not in the sheet).
FACTIONS = {
    "Egypt": {
        "color": "#c8a23a", "identity": "Depth / mix",
        "econPerk": {"type": "cheap_cy_rebuild", "value": 0.20},
        "ability": "saka_insertion",
        "superweaponIntercept": None,
    },
    "Saudi": {
        "color": "#2e7d32", "identity": "Altitude / quality",
        "econPerk": {"type": "oil_income_mult", "value": 1.15},
        "ability": "rsaf_tasking",
        "superweaponIntercept": "InterceptPatriot",
    },
    "UAE": {
        "color": "#b03a2e", "identity": "Scalpel / precision",
        "econPerk": {"type": "early_build_speed", "value": 0.10, "until_s": 480},
        "ability": "edge_network",
        "superweaponIntercept": None,
    },
    "Algeria": {
        "color": "#616161", "identity": "Weight / bubble",
        "econPerk": {"type": "war_factory_discount", "value": 0.08},
        "ability": "integrated_sky",
        "superweaponIntercept": "InterceptS400",
    },
    "Turkey": {
        "color": "#d32f2f", "identity": "Drone mesh",
        "econPerk": None,
        "ability": "siha_mesh",
        "superweaponIntercept": "InterceptSiper",
    },
    "Israel": {
        "color": "#1565c0", "identity": "Shield + knife",
        "econPerk": None,
        "ability": "iron_layer",
        "superweaponIntercept": "InterceptDome",
    },
    "India": {
        "color": "#ef6c00", "identity": "Scale + BrahMos",
        "econPerk": None,
        "ability": "brahmos_lane",
        "superweaponIntercept": "InterceptS400",
    },
    "Pakistan": {
        "color": "#00695c", "identity": "First strike",
        "econPerk": {"type": "unit_build_speed", "value": 0.15, "unit_name": "JF-17"},
        "ability": "babur_window",
        "superweaponIntercept": None,
    },
    "Iran": {
        "color": "#6a1b9a", "identity": "Swarm + rain",
        "econPerk": None,
        "ability": "shahed_rain",
        "superweaponIntercept": "InterceptBavar",
    },
}

# Sheet gap: subs have all damage columns = 0 (torpedoes live only in Notes).
# Patched here per GDD intent: torpedo = heavy anti-ship volley (maps to the
# 'armor' damage column; the sim uses that column vs Naval targets).
DAMAGE_PATCHES = {
    "EG-20": {"armor": 160},  # Type-209 flavour
    "DZ-18": {"armor": 180},  # Kilo 636 flavour
    "IN-18": {"armor": 160},  # Kalvari flavour
    "PK-19": {"armor": 180},  # Hangor-class
    "IR-19": {"armor": 120},  # Ghadir mini-sub
}

# v0.3.2 balance patch (Grok playtest): UAE's tech-0 roster had a hole —
# only 6 cheap units, no AA and no gun tank. Two additions in sheet scale
# (rifle 150cr/120HP, AA inf 300-400cr, MBT ~1500cr/1100HP): a wheeled AA
# mirroring the Saudi Avenger (SA-03) with UAE pricing, and a surplus gun
# tank mirroring the Saudi M60A3 (SA-07). Easily removable: delete this table.
BALANCE_ADDITIONS = [
    {
        "id": "AE-16", "faction": "UAE", "wave": "WAVE1",
        "name": "Avenger AA", "cls": "Mobile AA", "role": "AA humvee",
        "domain": "Land", "cost": 650, "build_s": 12.0, "hp": 220,
        "armor": "Light", "speed": 85.0, "sight": 10.0,
        "dmg": {"inf": 2.0, "light": 4.0, "armor": 2.0, "air": 50.0, "bldg": 6.0},
        "range": 8.0, "rof_s": 2.5, "ability": "Stinger rack",
        "softCounter": "Tanks", "hardCounter": "Helo / drone",
    },
    {
        "id": "AE-17", "faction": "UAE", "wave": "WAVE1",
        "name": "M60A3 (reserve)", "cls": "Light tank", "role": "Reserve gun tank",
        "domain": "Land", "cost": 1050, "build_s": 14.0, "hp": 720,
        "armor": "Heavy", "speed": 60.0, "sight": 8.0,
        "dmg": {"inf": 18.0, "light": 28.0, "armor": 55.0, "air": 4.0, "bldg": 16.0},
        "range": 7.0, "rof_s": 2.2, "ability": "",
        "softCounter": "Modern AT", "hardCounter": "Infantry",
    },
]

# Units legitimately unarmed (utility). Suppresses the no-damage warning.
UNARMED_ROLES = {"Support"}
UNARMED_NAMES = {"Engineer"}

INTERCEPT_FACTIONS = {
    "InterceptDome": ["Israel"],
    "InterceptS400": ["Algeria", "India"],
    "InterceptPatriot": ["Saudi", "UAE"],
    "InterceptSiper": ["Turkey"],
    "InterceptBavar": ["Iran"],
}

# v0.3 "It fights back": defensive structures get compact combat stats.
# The xlsx 03_STRUCTURES sheet has no weapon columns, so these are design
# values patched in here (same style as DAMAGE_PATCHES). Range in cells,
# ROF in seconds, dmg columns match the unit schema.
STRUCT_COMBAT = {
    "SH-09": {"range": 7.0, "rof_s": 1.0,   # HMG nest: shreds infantry
              "dmg": {"inf": 25.0, "light": 10.0, "armor": 3.0, "air": 0.0, "bldg": 2.0}},
    "SH-10": {"range": 11.0, "rof_s": 4.0,  # ATGM tower: tank killer
              "dmg": {"inf": 3.0, "light": 20.0, "armor": 85.0, "air": 0.0, "bldg": 8.0}},
    "SH-11": {"range": 10.0, "rof_s": 1.5,  # AA gun: helo / drone
              "dmg": {"inf": 5.0, "light": 6.0, "armor": 2.0, "air": 60.0, "bldg": 2.0}},
    # faction SAM / ABM batteries: long range, heavy vs air, poor vs armor
    "SH-14": {"range": 14.0, "rof_s": 3.0,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 90.0, "bldg": 2.0}},
    "SH-16": {"range": 15.0, "rof_s": 3.0,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 95.0, "bldg": 2.0}},
    "SH-18": {"range": 16.0, "rof_s": 3.0,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 110.0, "bldg": 2.0}},
    "SH-20": {"range": 13.0, "rof_s": 2.5,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 75.0, "bldg": 2.0}},
    "SH-21": {"range": 15.0, "rof_s": 3.0,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 95.0, "bldg": 2.0}},
    "SH-23": {"range": 12.0, "rof_s": 2.0,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 70.0, "bldg": 2.0}},
    "SH-24": {"range": 14.0, "rof_s": 2.5,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 85.0, "bldg": 2.0}},
    "SH-25": {"range": 16.0, "rof_s": 3.5,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 100.0, "bldg": 2.0}},
    "SH-27": {"range": 13.0, "rof_s": 2.5,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 75.0, "bldg": 2.0}},
    "SH-28": {"range": 16.0, "rof_s": 3.0,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 110.0, "bldg": 2.0}},
    "SH-31": {"range": 14.0, "rof_s": 2.5,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 85.0, "bldg": 2.0}},
    "SH-34": {"range": 15.0, "rof_s": 3.0,
              "dmg": {"inf": 4.0, "light": 8.0, "armor": 5.0, "air": 95.0, "bldg": 2.0}},
}


def rows(ws):
    return [[c for c in r] for r in ws.iter_rows(values_only=True)]


def num(v, default=0.0):
    if v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def export_knobs(wb):
    ws = wb["01_ASSUMPTIONS"]
    knobs = {}
    for r in rows(ws)[2:]:
        if r[0] and isinstance(r[0], str) and r[1] is not None and r[0] == r[0].strip():
            try:
                knobs[r[0]] = float(r[1])
            except (TypeError, ValueError):
                pass
    return knobs


def export_units(wb):
    ws = wb["02_UNITS"]
    data = rows(ws)
    header = [str(h).strip() if h else "" for h in data[1]]
    idx = {h: i for i, h in enumerate(header)}
    units = []
    warnings = []
    for r in data[2:]:
        uid = r[idx["ID"]]
        if not uid or not str(uid).strip():
            continue
        u = {
            "id": str(uid).strip(),
            "faction": str(r[idx["Faction"]]).strip(),
            "wave": str(r[idx["Wave"]]).strip(),
            "name": str(r[idx["Name"]]).strip(),
            "cls": str(r[idx["Class"]]).strip(),
            "role": str(r[idx["Role"]]).strip(),
            "domain": str(r[idx["Domain"]]).strip(),
            "cost": int(num(r[idx["Cost_cr"]])),
            "build_s": num(r[idx["Build_s"]]),
            "hp": int(num(r[idx["HP"]])),
            "armor": str(r[idx["ArmorClass"]]).strip(),
            "speed": num(r[idx["Speed"]]),
            "sight": num(r[idx["Sight"]]),
            "dmg": {
                "inf": num(r[idx["Dmg_Inf"]]),
                "light": num(r[idx["Dmg_Light"]]),
                "armor": num(r[idx["Dmg_Armor"]]),
                "air": num(r[idx["Dmg_Air"]]),
                "bldg": num(r[idx["Dmg_Bldg"]]),
            },
            "range": num(r[idx["Range"]]),
            "rof_s": num(r[idx["ROF_s"]], 1.0),
            "ability": (str(r[idx["Ability"]]).strip() if r[idx["Ability"]] else ""),
            "softCounter": (str(r[idx["SoftCounter"]]).strip() if r[idx["SoftCounter"]] else ""),
            "hardCounter": (str(r[idx["HardCounter"]]).strip() if r[idx["HardCounter"]] else ""),
        }
        # tech gate (needs a standing SH-08): derived from cost, NOT the sheet's
        # Wave column — Wave is a ship-batch label (all of Saudi/UAE is WAVE1,
        # Turkey/Iran WAVE2, Israel/India/Pakistan WAVE3) and gating on it left
        # 7 of 9 factions with nothing trainable (v0.3.1)
        u["tech"] = 1 if u["cost"] >= 1400 else 0
        if u["id"] in DAMAGE_PATCHES:
            for k, v in DAMAGE_PATCHES[u["id"]].items():
                u["dmg"][k] = float(v)
        if u["cost"] <= 0 or u["hp"] <= 0:
            warnings.append(f"{u['id']} ({u['name']}): non-positive cost/hp")
        if (max(u["dmg"].values()) <= 0
                and u["role"] not in UNARMED_ROLES
                and u["name"] not in UNARMED_NAMES):
            warnings.append(f"{u['id']} ({u['name']}): no damage in any class")
        units.append(u)
    # v0.3.2 balance additions (see BALANCE_ADDITIONS): appended after the
    # sheet rows so the tech derivation below applies to them too
    for u in BALANCE_ADDITIONS:
        u = dict(u)
        u["dmg"] = dict(u["dmg"])
        u["tech"] = 1 if u["cost"] >= 1400 else 0
        units.append(u)
    return units, warnings


def export_structures(wb):
    ws = wb["03_STRUCTURES"]
    data = rows(ws)
    header = [str(h).strip() if h else "" for h in data[1]]
    idx = {h: i for i, h in enumerate(header)}
    out = []
    for r in data[2:]:
        sid = r[idx["ID"]]
        if not sid or not str(sid).strip():
            continue
        out.append({
            "id": str(sid).strip(),
            "faction": str(r[idx["Faction"]]).strip(),
            "name": str(r[idx["Name"]]).strip(),
            "type": str(r[idx["Type"]]).strip(),
            "cost": int(num(r[idx["Cost_cr"]])),
            "build_s": num(r[idx["Build_s"]]),
            "hp": int(num(r[idx["HP"]])),
            "power_use": num(r[idx["Power_use"]]),
            "power_out": num(r[idx["Power_out"]]),
            "unlocks": (str(r[idx["Unlocks"]]).strip() if r[idx["Unlocks"]] else ""),
            # v0.3: weapon stats for Def structures (absent = inert)
            **STRUCT_COMBAT.get(str(sid).strip(), {}),
        })
    return out


def export_counters(wb):
    ws = wb["04_COUNTERS"]
    data = rows(ws)
    header = [str(h).strip() if h else "" for h in data[1]][1:]
    matrix = {}
    for r in data[2:]:
        if not r[0] or str(r[0]).strip() in ("Linked knobs (reference only)",):
            break
        attacker = str(r[0]).strip()
        matrix[attacker] = {}
        for i, target in enumerate(header):
            matrix[attacker][target] = num(r[i + 1], 1.0)
    return {"classes": header, "matrix": matrix}


def main():
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    knobs = export_knobs(wb)
    units, warnings = export_units(wb)
    structures = export_structures(wb)
    counters = export_counters(wb)

    armor_incoming = dict(ARMOR_INCOMING)
    armor_incoming["Light"] = knobs.get("LightArmorMult", 0.85)
    armor_incoming["Medium"] = knobs.get("MedArmorMult", 1.0)
    armor_incoming["Heavy"] = knobs.get("HeavyArmorMult", 1.15)

    factions = {}
    for name, meta in FACTIONS.items():
        f = dict(meta)
        f["unitCount"] = sum(1 for u in units if u["faction"] == name)
        if f["unitCount"] == 0:
            warnings.append(f"faction {name}: no units in roster")
        factions[name] = f

    game = {
        "version": "0.3.4",
        "knobs": knobs,
        "armorIncoming": armor_incoming,
        "factions": factions,
        "interceptFactions": INTERCEPT_FACTIONS,
        "units": units,
        "structures": structures,
        "counterMatrix": counters,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(game, f, indent=1)

    print(f"wrote {OUT}")
    print(f"  knobs: {len(knobs)}, factions: {len(factions)}, units: {len(units)}, structures: {len(structures)}")
    for fn, f in factions.items():
        print(f"    {fn}: {f['unitCount']} units")
    if warnings:
        print("WARNINGS:")
        for w in warnings:
            print(f"  - {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

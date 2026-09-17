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

# NOTE (design intent, from the stat sheet): HeavyArmorMult = 1.15 means Heavy
# armor takes +15% INCOMING damage — heavy units survive on raw HP, not damage
# reduction (Light 0.85 pays for speed with smaller HP pools). This is the
# sheet's original design, not a bug; keep in sync with knobs only.

# v0.6.1: sheet ability cells that contain designer notes, not player text
ABILITY_TEXT_OVERRIDES = {
    "EG-13": "—",                # was "Do not spam"
    "SA-08": "Blow-out panel",   # was "Blow-out panel (1 pen = crit not death)"
}

# v0.6.1: one-per-match units (engine-enforced via orders.js trainUnit)
UNIQUE_UNITS = {"IN-19"}  # INS Vikrant carrier

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
        # DeepSeek robustness: match by explicit unit id (PK-13 = JF-17
        # Block II, verified in the sheet) instead of a name substring.
        # unit_name kept purely as the menu display label.
        "econPerk": {"type": "unit_build_speed", "value": 0.15,
                     "unit_ids": ["PK-13"], "unit_name": "JF-17"},
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

# v0.3.6 balance pass (KIMI AI playtest review of v0.3.5, report §1.1/1.3).
# The counterMatrix in game.json is reference-only — no sim code reads it — so
# the review's matrix fixes land on the REAL damage model knobs instead:
#   - "AT inf -> MBT 1.8 -> 1.45" == ATGMVsArmor 1.8 -> 1.45 (combat.js applies
#     this knob to ATGM-class fire vs Medium/Heavy armor)
#   - economy (§1.3): effective field income measured at the full 35 cr/s
#     (harvester pays while parked — no travel time), so the review's
#     ">= 25 cr/s -> halve" branch fires. But the reviewer's 16 cr/s overshoots
#     their own 60-90s-per-tier-2-unit target (1500cr = 94s), so 18 cr/s
#     (1500cr ~= 83s, inside the target) + StartCredits 6000.
KNOB_OVERRIDES = {
    "ATGMVsArmor": 1.45,
    "OilIncomePerField": 18.0,
    "StartCredits": 6000.0,
    # DeepSeek review balance: artillery (SPG/MLRS vs structures) was
    # over-tuned at 2.2 — turtling melted too fast. 2.2 -> 1.6.
    "ArtyVsBuilding": 1.6,
}

# "MBT -> Infantry 1.3 -> 1.45" (report §1.4): the sim has no class matrix, so
# scale the dmg.inf column of every MBT by the same factor (rounded to 0.1).
# EG-07's 'Canister switch' flavor gets the review's explicit 20 -> 26, applied
# AFTER the scaling so it lands exactly on 26.
MBT_INF_SCALE = 1.45 / 1.3
MBT_INF_EXPLICIT = {"EG-07": 26.0}

# v0.3.7 research upgrade kits (Grok review, slice 3): one purchasable kit per
# faction per domain — infantry (producer SH-04 barracks), MBT (SH-05 war
# factory), air (SH-06 airfield). Researching a kit buffs living owned units
# of appliesTo ids once (hp x hpMul rounded, dmg x dmgMul) and every future
# train via addUnit. Names are the plausible real-world upgrade package.
UPGRADES = [
    # Egypt
    {"id": "EG-INF-KIT", "faction": "Egypt", "producer": "SH-04",
     "appliesTo": ["EG-01"], "cost": 1200, "label": "Misr rifle refit",
     "hpMul": 1.2, "dmgMul": 1.2},
    {"id": "EG-MBT-SEP", "faction": "Egypt", "producer": "SH-05",
     "appliesTo": ["EG-07", "EG-13"], "cost": 1800, "label": "Abrams SEP kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    {"id": "EG-F16-70", "faction": "Egypt", "producer": "SH-06",
     "appliesTo": ["EG-10"], "cost": 2200, "label": "F-16V Block 70",
     "hpMul": 1.2, "dmgMul": 1.25},
    # Saudi
    {"id": "SA-INF-KIT", "faction": "Saudi", "producer": "SH-04",
     "appliesTo": ["SA-01"], "cost": 1200, "label": "SANG fireteam kit",
     "hpMul": 1.2, "dmgMul": 1.2},
    {"id": "SA-M1-SEP3", "faction": "Saudi", "producer": "SH-05",
     "appliesTo": ["SA-08"], "cost": 1800, "label": "M1A2S SEPv3 kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    {"id": "SA-F15-EX", "faction": "Saudi", "producer": "SH-06",
     "appliesTo": ["SA-13"], "cost": 2400, "label": "F-15SA EPAWSS refit",
     "hpMul": 1.2, "dmgMul": 1.25},
    # UAE
    {"id": "AE-INF-KIT", "faction": "UAE", "producer": "SH-04",
     "appliesTo": ["AE-01"], "cost": 1200, "label": "Presidential Guard SOF kit",
     "hpMul": 1.2, "dmgMul": 1.2},
    {"id": "AE-LRC-XLR", "faction": "UAE", "producer": "SH-05",
     "appliesTo": ["AE-07"], "cost": 1800, "label": "Leclerc XLR kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    {"id": "AE-F16-61", "faction": "UAE", "producer": "SH-06",
     "appliesTo": ["AE-12"], "cost": 2400, "label": "F-16E Block 61",
     "hpMul": 1.2, "dmgMul": 1.25},
    # Algeria
    {"id": "DZ-INF-KIT", "faction": "Algeria", "producer": "SH-04",
     "appliesTo": ["DZ-01"], "cost": 1200, "label": "ANP field kit",
     "hpMul": 1.2, "dmgMul": 1.2},
    {"id": "DZ-T90-SM", "faction": "Algeria", "producer": "SH-05",
     "appliesTo": ["DZ-07"], "cost": 1800, "label": "T-90SM kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    {"id": "DZ-SU30-SM2", "faction": "Algeria", "producer": "SH-06",
     "appliesTo": ["DZ-10"], "cost": 2300, "label": "Su-30SM2 kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    # Turkey
    {"id": "TR-INF-MPT", "faction": "Turkey", "producer": "SH-04",
     "appliesTo": ["TR-01"], "cost": 1200, "label": "MPT-76 rifle refit",
     "hpMul": 1.2, "dmgMul": 1.2},
    {"id": "TR-ALTAY-T2", "faction": "Turkey", "producer": "SH-05",
     "appliesTo": ["TR-08"], "cost": 1800, "label": "Altay T2 kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    {"id": "TR-F16-OZG2", "faction": "Turkey", "producer": "SH-06",
     "appliesTo": ["TR-15"], "cost": 2300, "label": "F-16 Özgür II",
     "hpMul": 1.2, "dmgMul": 1.25},
    # Israel
    {"id": "IL-INF-MD", "faction": "Israel", "producer": "SH-04",
     "appliesTo": ["IL-01"], "cost": 1300, "label": "Marom Dolphin kit",
     "hpMul": 1.2, "dmgMul": 1.2},
    {"id": "IL-MRK-BARAK", "faction": "Israel", "producer": "SH-05",
     "appliesTo": ["IL-08"], "cost": 2000, "label": "Merkava Barak kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    {"id": "IL-F35-ADIRP", "faction": "Israel", "producer": "SH-06",
     "appliesTo": ["IL-15"], "cost": 2600, "label": "F-35I Adir+",
     "hpMul": 1.2, "dmgMul": 1.25},
    # India
    {"id": "IN-INF-FINSAS", "faction": "India", "producer": "SH-04",
     "appliesTo": ["IN-01"], "cost": 1200, "label": "F-INSAS kit",
     "hpMul": 1.2, "dmgMul": 1.2},
    {"id": "IN-T90-MS", "faction": "India", "producer": "SH-05",
     "appliesTo": ["IN-07"], "cost": 1800, "label": "T-90MS conversion",
     "hpMul": 1.2, "dmgMul": 1.25},
    {"id": "IN-SU30-SS", "faction": "India", "producer": "SH-06",
     "appliesTo": ["IN-14"], "cost": 2400, "label": "Super Sukhoi kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    # Pakistan
    {"id": "PK-INF-BW20", "faction": "Pakistan", "producer": "SH-04",
     "appliesTo": ["PK-01"], "cost": 1100, "label": "BW-20 rifle refit",
     "hpMul": 1.2, "dmgMul": 1.2},
    {"id": "PK-AK-II", "faction": "Pakistan", "producer": "SH-05",
     "appliesTo": ["PK-08"], "cost": 1800, "label": "Al-Khalid II kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    {"id": "PK-JF17-B3", "faction": "Pakistan", "producer": "SH-06",
     "appliesTo": ["PK-13"], "cost": 2200, "label": "JF-17 Block III",
     "hpMul": 1.2, "dmgMul": 1.25},
    # Iran
    {"id": "IR-INF-KHY", "faction": "Iran", "producer": "SH-04",
     "appliesTo": ["IR-01"], "cost": 1000, "label": "Khaybar rifle refit",
     "hpMul": 1.2, "dmgMul": 1.2},
    {"id": "IR-KARRAR-P", "faction": "Iran", "producer": "SH-05",
     "appliesTo": ["IR-07"], "cost": 1700, "label": "Karrar+ kit",
     "hpMul": 1.2, "dmgMul": 1.25},
    {"id": "IR-KOWSAR-2", "faction": "Iran", "producer": "SH-06",
     "appliesTo": ["IR-17"], "cost": 2000, "label": "Kowsar II kit",
     "hpMul": 1.2, "dmgMul": 1.25},
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
    # v0.3.6 (see MBT_INF_SCALE): MBT anti-infantry buff, then the explicit
    # canister value for EG-07 on top
    for u in units:
        if u["cls"] == "MBT":
            u["dmg"]["inf"] = round(u["dmg"]["inf"] * MBT_INF_SCALE, 1)
        if u["id"] in MBT_INF_EXPLICIT:
            u["dmg"]["inf"] = MBT_INF_EXPLICIT[u["id"]]
    # v0.6.1 data hygiene (DeepSeek static audit):
    # - designer notes are not player-facing ability text
    # - normalize empty ability strings to the sheet's dash
    for u in units:
        if u["id"] in ABILITY_TEXT_OVERRIDES:
            u["ability"] = ABILITY_TEXT_OVERRIDES[u["id"]]
        elif not u.get("ability"):
            u["ability"] = "—"
    # one-per-match units get an engine-enforced flag (was ability-string only)
    for u in units:
        if u["id"] in UNIQUE_UNITS:
            u["unique"] = True
    # keep the roster ordered by faction block then id (the v0.3.2 UAE
    # additions had been appended at the very end after Iran)
    faction_order = {name: i for i, name in enumerate(FACTIONS)}
    units.sort(key=lambda u: (faction_order.get(u["faction"], 99), u["id"]))
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
    knobs.update(KNOB_OVERRIDES)  # v0.3.6 balance pass (see table above)
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
        "version": "0.10.0",
        "knobs": knobs,
        "armorIncoming": armor_incoming,
        "factions": factions,
        "interceptFactions": INTERCEPT_FACTIONS,
        "units": units,
        "structures": structures,
        "counterMatrix": counters,
        "upgrades": [dict(g, appliesTo=list(g["appliesTo"])) for g in UPGRADES],
    }

    # upgrade table sanity: ids unique, appliesTo units exist and belong to
    # the kit's faction, producer is a known structure
    unit_ids = {u["id"]: u for u in units}
    struct_ids = {s["id"] for s in structures}
    seen_upg = set()
    for g in UPGRADES:
        if g["id"] in seen_upg:
            warnings.append(f"upgrade {g['id']}: duplicate id")
        seen_upg.add(g["id"])
        if g["producer"] not in struct_ids:
            warnings.append(f"upgrade {g['id']}: unknown producer {g['producer']}")
        for uid in g["appliesTo"]:
            if uid not in unit_ids:
                warnings.append(f"upgrade {g['id']}: unknown unit {uid}")
            elif unit_ids[uid]["faction"] != g["faction"]:
                warnings.append(f"upgrade {g['id']}: {uid} belongs to {unit_ids[uid]['faction']}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(game, f, indent=1)

    print(f"wrote {OUT}")
    print(f"  knobs: {len(knobs)}, factions: {len(factions)}, units: {len(units)}, structures: {len(structures)}, upgrades: {len(UPGRADES)}")
    for fn, f in factions.items():
        print(f"    {fn}: {f['unitCount']} units")
    if warnings:
        print("WARNINGS:")
        for w in warnings:
            print(f"  - {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

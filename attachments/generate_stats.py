#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ASH-SHARQ nine-faction unit stat sheet v0.2."""

from openpyxl import Workbook
from openpyxl.styles import Font, Fill, PatternFill, Alignment, Border, Side, NamedStyle, Protection
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import ColorScaleRule, FormulaRule, CellIsRule
from openpyxl.chart import BarChart, Reference
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.series import DataPoint
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.drawing.line import LineProperties
from copy import copy

wb = Workbook()

# ---------- styles ----------
NAVY = "1A3A2A"
GOLD = "7A2E0E"
CREAM = "F4F1EA"
PALE = "E8F0EC"
WHITE = "FFFFFF"
BLUE = "0000FF"
INPUT_FILL = "FFF3B0"
HEADER_FILL = "1A3A2A"
SECT_FILL = "2C5F4A"
ROW_A = "F4F1EA"
ROW_B = "FFFFFF"

thin = Border(
    left=Side(style="thin", color="CCCCCC"),
    right=Side(style="thin", color="CCCCCC"),
    top=Side(style="thin", color="CCCCCC"),
    bottom=Side(style="thin", color="CCCCCC"),
)
thick_bottom = Border(
    left=Side(style="thin", color="CCCCCC"),
    right=Side(style="thin", color="CCCCCC"),
    top=Side(style="thin", color="CCCCCC"),
    bottom=Side(style="medium", color="1A3A2A"),
)

font_title = Font(name="Calibri", size=18, bold=True, color=NAVY)
font_h = Font(name="Calibri", size=12, bold=True, color="FFFFFF")
font_th = Font(name="Calibri", size=9, bold=True, color="FFFFFF")
font_in = Font(name="Calibri", size=10, color=BLUE, bold=True)  # inputs
font_f = Font(name="Calibri", size=10, color="000000")          # formulas
font_link = Font(name="Calibri", size=10, color="008000")
font_note = Font(name="Calibri", size=9, italic=True, color="555555")
font_body = Font(name="Calibri", size=10, color="222222")
center = Alignment(horizontal="center", vertical="center", wrap_text=True)
left = Alignment(horizontal="left", vertical="center", wrap_text=True)

fill_header = PatternFill("solid", fgColor=HEADER_FILL)
fill_sect = PatternFill("solid", fgColor=SECT_FILL)
fill_input = PatternFill("solid", fgColor=INPUT_FILL)
fill_cream = PatternFill("solid", fgColor=CREAM)
fill_pale = PatternFill("solid", fgColor=PALE)
fill_white = PatternFill("solid", fgColor=WHITE)
fill_green = PatternFill("solid", fgColor="C6EFCE")
fill_red = PatternFill("solid", fgColor="FFC7CE")
fill_amber = PatternFill("solid", fgColor="FFEB9C")

FACTION_COLOR = {
    "Egypt": "2E7D32",
    "Saudi": "1B5E20",
    "UAE": "00695C",
    "Algeria": "33691E",
    "Turkey": "B71C1C",
    "Israel": "1565C0",
    "India": "E65100",
    "Pakistan": "006400",
    "Iran": "4A148C",
    "All": "1A3A2A",
}

def style_header_row(ws, row, cols):
    for c in range(1, cols + 1):
        cell = ws.cell(row, c)
        cell.font = font_th
        cell.fill = fill_header
        cell.alignment = center
        cell.border = thin

def alt_fill(r):
    return fill_cream if r % 2 == 0 else fill_white

# ============================================================
# SHEET: README
# ============================================================
ws = wb.active
ws.title = "00_README"
ws.sheet_properties.tabColor = "1A3A2A"
ws.sheet_view.showGridLines = False
ws.page_setup.orientation = "landscape"
ws.page_setup.fitToPage = True
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.freeze_panes = "A1"

ws.merge_cells("B2:H2")
ws["B2"] = "ASH-SHARQ: DESERT COMMAND  —  UNIT STAT SHEET  v0.2"
ws["B2"].font = font_title
ws.merge_cells("B3:H3")
ws["B3"] = "Nine-faction balance workbook for the design / programming team. Pair with GDD v0.1 + v0.2 addendum."
ws["B3"].font = font_note

readme = [
    (5, "HOW THIS FILE WORKS"),
    (6, "Yellow cells with BLUE numbers are INPUTS. Change those. Everything black is a formula — do not type over it."),
    (7, "01_ASSUMPTIONS holds the global knobs (veterancy, armour multipliers, intercept chances). Change a knob, the Units sheet updates."),
    (8, "02_UNITS is the live roster. Filter by Faction or Wave. Derived columns (DPS, Cost/HP, Combat Index) recalculate."),
    (9, "03_STRUCTURES is production and defence buildings. Power and build-radius live here."),
    (10, "04_COUNTERS is class-vs-class expected damage multipliers. Used by Combat Index."),
    (11, "05_FACTION_COMPARE rolls the roster up so you can see if Saudi air is actually better than Egypt air."),
    (12, "06_WAVE_PLAN is the ship order from the GDD. Do not art Wave 3 before Wave 0 is fun."),
    (13, "07_CHANGELOG is empty on purpose. Date every stat edit. If you do not, the next pass will fight you."),
    (15, "SCALE"),
    (16, "Numbers are RA3-family, not milsim. A rifle squad is ~150 credits / 120 HP. An MBT is ~1500 / 1100. A match is 12–25 minutes."),
    (17, "Damage is ‘per volley’ against that armour class. DPS = Volley ÷ ROF_sec. Combat Index is a designer heuristic, not gospel."),
    (18, "Wave 0 slice units are tagged WAVE0. Those must be tuned first. Everything else is a placeholder that should feel right, not final."),
    (20, "COLOUR KEY"),
    (21, "Blue text + yellow fill = input (you edit).  Black text = formula.  Green text on COMPARE = pulled from UNITS."),
    (23, "RULES OF THE FENCE"),
    (24, "No nuclear weapons. No living politicians as units. Do not give Egypt an F-35, Iran an Abrams, Pakistan a Rafale, Israel a T-90."),
    (25, "If a matchup sits at 70/30 after a week of play, change COST or BUILD TIME first, identity second, HP last."),
]
for row, text in readme:
    ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=8)
    ws.cell(row, 2, text).font = Font(name="Calibri", size=11, bold=text.isupper() and len(text) < 40, color=NAVY if text.isupper() and len(text) < 40 else "222222")
    ws.cell(row, 2).alignment = left

ws["B27"] = "Workbook version"
ws["C27"] = "0.2.0"
ws["B28"] = "Date"
ws["C28"] = "2026-08-29"
ws["B29"] = "Status"
ws["C29"] = "FIRST PASS — slice numbers are playable guesses, not shipped values"
ws["C27"].font = font_in
ws["C28"].font = font_in
ws["C29"].font = font_in
ws["C27"].fill = fill_input
ws["C28"].fill = fill_input
ws["C29"].fill = fill_input

for col, w in enumerate([3, 28, 22, 16, 14, 14, 14, 14], 1):
    ws.column_dimensions[get_column_letter(col)].width = w
ws.row_dimensions[2].height = 24

# ============================================================
# SHEET: ASSUMPTIONS
# ============================================================
wa = wb.create_sheet("01_ASSUMPTIONS")
wa.sheet_properties.tabColor = "FFF3B0"
wa.freeze_panes = "A2"
wa.sheet_view.showGridLines = False
wa.page_setup.orientation = "landscape"
wa.page_setup.fitToPage = True
wa.page_setup.fitToWidth = 1
wa.page_setup.fitToHeight = 1
wa.page_setup.paperSize = wa.PAPERSIZE_A4

wa.merge_cells("A1:F1")
wa["A1"] = "GLOBAL KNOBS  —  edit yellow / blue only"
wa["A1"].font = font_h
wa["A1"].fill = fill_header
wa["A1"].alignment = center

headers_a = ["Key", "Value", "Unit", "Used by", "Notes", "Locked?"]
for i, h in enumerate(headers_a, 1):
    c = wa.cell(2, i, h)
    c.font = font_th
    c.fill = fill_sect
    c.alignment = center
    c.border = thin

# Named ranges will point at B column values. Row map:
# 3 vet_dmg, 4 elite_hp, 5 heroic_perk, 6 armor_mult_light, 7 armor_mult_med, 8 armor_mult_heavy
# 9 air_vs_armor, 10 atgm_vs_armor, 11 artillery_vs_building
# 12 intercept_dome, 13 intercept_s400, 14 intercept_patriot, 15 intercept_siper, 16 intercept_bavar
# 17 swarm_hp, 18 trophy_cd, 19 drone_paint_s
# 20 starting_credits, 21 oil_income, 22 power_plant

assumptions = [
    ("VetDmgBonus", 0.25, "ratio", "UNITS Combat Index", "Veteran rank damage multiplier added", "N"),
    ("EliteHPBonus", 0.25, "ratio", "UNITS Combat Index", "Elite rank extra HP", "N"),
    ("HeroicPerk", 0.10, "ratio", "UNITS Combat Index", "Heroic extra mixed bonus (approx)", "N"),
    ("LightArmorMult", 0.85, "ratio", "04_COUNTERS", "Incoming vs light vehicles", "N"),
    ("MedArmorMult", 1.00, "ratio", "04_COUNTERS", "Incoming vs IFV / medium", "N"),
    ("HeavyArmorMult", 1.15, "ratio", "04_COUNTERS", "Incoming vs MBT (thicker, so attacker needs more)", "N"),
    ("AirVsArmor", 1.35, "ratio", "04_COUNTERS", "Attack helo / A2G vs tanks if no AA", "N"),
    ("ATGMVsArmor", 1.80, "ratio", "04_COUNTERS", "ATGM vs MBT if they see it", "N"),
    ("ArtyVsBuilding", 2.20, "ratio", "04_COUNTERS", "Artillery / MLRS vs structures", "N"),
    ("InterceptDome", 0.75, "chance", "Israel Iron Layer", "Iron Dome vs rocket / cruise", "N"),
    ("InterceptS400", 0.70, "chance", "Algeria / India umbrella", "S-400 vs jet / cruise / lofted ballistic", "N"),
    ("InterceptPatriot", 0.65, "chance", "Saudi umbrella", "Patriot vs jet / cruise", "N"),
    ("InterceptSiper", 0.60, "chance", "Turkey umbrella", "Siper vs jet / cruise", "N"),
    ("InterceptBavar", 0.55, "chance", "Iran umbrella", "Bavar-373 vs jet / cruise", "N"),
    ("SwarmHP", 40, "HP", "Iran Shahed-136", "One-way drone hit points", "N"),
    ("TrophyCD", 20, "sec", "Israel Merkava / Namer", "Seconds between APS eats", "N"),
    ("DronePaint", 8, "sec", "Turkey SİHA mesh", "Seconds a spot persists after LOS loss", "N"),
    ("StartCredits", 10000, "cr", "Match start", "1v1 standard", "N"),
    ("OilIncomePerField", 35, "cr/s", "Economy", "Per owned oil field with a living harvester", "N"),
    ("PowerPlantOutput", 100, "pwr", "Structures", "Standard plant", "N"),
    ("LowPowerPenalty", 0.40, "ratio", "Production", "Build speed penalty when power is negative", "N"),
    ("HarvesterCost", 1400, "cr", "Economy", "Oil truck", "N"),
    ("HarvesterHP", 400, "HP", "Economy", "Oil truck", "N"),
    ("MBTTargetCost", 1500, "cr", "Tuning aid", "What a 'standard' MBT should cost. Compare CostΔ.", "N"),
    ("RifleTargetCost", 150, "cr", "Tuning aid", "What a rifle squad should cost.", "N"),
]

for i, (k, v, unit, used, notes, lock) in enumerate(assumptions, 3):
    wa.cell(i, 1, k).font = font_body
    wa.cell(i, 1).alignment = left
    cell = wa.cell(i, 2, v)
    cell.font = font_in
    cell.fill = fill_input
    cell.alignment = center
    cell.border = thin
    if isinstance(v, float) and v <= 2:
        cell.number_format = "0.00"
    else:
        cell.number_format = "#,##0"
    wa.cell(i, 3, unit).font = font_note
    wa.cell(i, 4, used).font = font_note
    wa.cell(i, 5, notes).font = font_note
    wa.cell(i, 6, lock).font = font_body
    wa.cell(i, 6).alignment = center
    for c in range(1, 7):
        wa.cell(i, c).fill = fill_input if c == 2 else alt_fill(i)
        wa.cell(i, c).border = thin
        if c == 2:
            wa.cell(i, c).fill = fill_input

# named ranges
name_map = {
    "VetDmgBonus": "$B$3",
    "EliteHPBonus": "$B$4",
    "HeroicPerk": "$B$5",
    "LightArmorMult": "$B$6",
    "MedArmorMult": "$B$7",
    "HeavyArmorMult": "$B$8",
    "AirVsArmor": "$B$9",
    "ATGMVsArmor": "$B$10",
    "ArtyVsBuilding": "$B$11",
    "InterceptDome": "$B$12",
    "InterceptS400": "$B$13",
    "InterceptPatriot": "$B$14",
    "InterceptSiper": "$B$15",
    "InterceptBavar": "$B$16",
    "SwarmHP": "$B$17",
    "TrophyCD": "$B$18",
    "DronePaint": "$B$19",
    "StartCredits": "$B$20",
    "OilIncomePerField": "$B$21",
    "PowerPlantOutput": "$B$22",
    "LowPowerPenalty": "$B$23",
    "HarvesterCost": "$B$24",
    "HarvesterHP": "$B$25",
    "MBTTargetCost": "$B$26",
    "RifleTargetCost": "$B$27",
}
for n, ref in name_map.items():
    wb.defined_names.add(DefinedName(n, attr_text=f"01_ASSUMPTIONS!{ref}"))

wa.merge_cells("A30:F30")
wa["A30"] = "Hint: after a balance day, duplicate this sheet as 01_ASSUMPTIONS_BAK so you can diff. Do not hide inputs in comments."
wa["A30"].font = font_note

for col, w in enumerate([22, 12, 10, 28, 48, 10], 1):
    wa.column_dimensions[get_column_letter(col)].width = w
wa.row_dimensions[1].height = 22
wa.auto_filter.ref = "A2:F27"

# ============================================================
# UNIT DATA
# Columns we write as inputs: A-U then formulas V-AD
# A ID  B Faction  C Wave  D Name  E Class  F Role  G Domain
# H Cost  I Build_s  J HP  K ArmorClass  L Speed  M Sight
# N DmgInf  O DmgLight  P DmgArmor  Q DmgAir  R DmgBldg  S Range  T ROF
# U Ability  V SoftCounter  W HardCounter  X Notes
# derived: Y DPS_Inf  Z DPS_Armor  AA DPS_Air  AB CostPerHP  AC CostDeltaMBT  AD CombatIndex
# ============================================================

# ArmorClass: Soft / Light / Medium / Heavy / Air / Naval
# Class taxonomy from GDD

units = [
    # WAVE 0 — EGYPT
    ("EG-01", "Egypt", "WAVE0", "Rifle squad", "Infantry", "Line", "Land", 150, 8, 120, "Soft", 55, 7, 12, 6, 2, 1, 4, 5.5, 1.0, "Smoke grenade", "IFV", "Tank in open", "Slice unit"),
    ("EG-02", "Egypt", "WAVE0", "Kornet team", "AT infantry", "AT", "Land", 400, 12, 80, "Soft", 45, 8, 4, 18, 90, 2, 8, 9.0, 4.5, "Top-attack mode", "Artillery / air", "Closing light vehicle", "Slice unit. Identity AT."),
    ("EG-03", "Egypt", "WAVE0", "Igla/Stinger team", "AA infantry", "AA", "Land", 350, 12, 80, "Soft", 45, 9, 3, 4, 3, 55, 5, 8.0, 5.0, "Flare decoy", "Artillery", "High jet", "Slice unit"),
    ("EG-04", "Egypt", "WAVE0", "Engineer", "Engineer", "Utility", "Land", 500, 10, 80, "Soft", 50, 6, 0, 0, 0, 0, 0, 2.0, 0.0, "Capture / repair", "Anything that shoots", "Being escorted", "Slice unit"),
    ("EG-05", "Egypt", "WAVE0", "YPR-765 / BMP-1", "IFV", "Transport", "Land", 700, 12, 380, "Medium", 70, 8, 22, 16, 22, 8, 10, 6.5, 1.2, "Carries 1 squad", "ATGM", "Pure air", "Slice unit"),
    ("EG-06", "Egypt", "WAVE0", "M60A3", "Light tank", "Budget MBT", "Land", 1000, 14, 720, "Heavy", 60, 8, 18, 28, 55, 4, 16, 7.0, 2.2, "—", "Modern AT / air", "Infantry in open", "Slice unit"),
    ("EG-07", "Egypt", "WAVE0", "M1A1 SA Ramses", "MBT", "Main tank", "Land", 1550, 18, 1150, "Heavy", 65, 8, 20, 32, 78, 6, 22, 8.0, 2.0, "Canister / MPAT switch", "ATGM + air", "Other MBT", "Slice unit"),
    ("EG-08", "Egypt", "WAVE0", "M109 / K9", "SPG", "Artillery", "Land", 1200, 16, 420, "Medium", 55, 10, 35, 40, 45, 8, 95, 14.0, 6.0, "Shoot-and-scoot", "Air / raiders", "Spotted blob", "Slice unit"),
    ("EG-09", "Egypt", "WAVE0", "AH-64D Apache", "Attack helo", "AT air", "Air", 1600, 18, 380, "Air", 95, 10, 10, 20, 85, 8, 8, 8.0, 3.0, "Pop-up Hellfire", "MANPADS / SAM / fighter", "Tanks no AA", "Slice unit"),
    ("EG-10", "Egypt", "WAVE0", "F-16C", "Fighter", "Multirole", "Air", 1600, 20, 320, "Air", 130, 12, 8, 14, 40, 55, 18, 12.0, 3.5, "A2A / A2G switch at field", "SAM / better fighter", "Helo / strike", "Slice unit"),
    ("EG-11", "Egypt", "WAVE1", "Sa'ka operator", "SF", "Raid", "Land", 700, 16, 140, "Soft", 65, 8, 18, 14, 25, 4, 10, 5.0, 1.4, "Stealth near cover + C4", "Detection + numbers", "Buildings", ""),
    ("EG-12", "Egypt", "WAVE1", "Fahd APC", "APC", "Taxi", "Land", 500, 10, 280, "Light", 80, 7, 14, 8, 4, 2, 6, 6.0, 1.1, "Cheap wheels", "Auto-cannon", "Infantry walks", ""),
    ("EG-13", "Egypt", "WAVE1", "T-90MS (limited)", "MBT", "Tier-3 tank", "Land", 1750, 22, 1250, "Heavy", 62, 8, 20, 34, 82, 6, 22, 8.0, 2.0, "Do not spam", "Air + ATGM", "Peer MBT", "Few per factory"),
    ("EG-14", "Egypt", "WAVE1", "BM-21 Grad", "MLRS", "Area", "Land", 1100, 16, 360, "Light", 60, 9, 50, 40, 30, 6, 70, 16.0, 8.0, "Barrage", "Air", "Blobs / buildings", "Inaccurate"),
    ("EG-15", "Egypt", "WAVE1", "Ka-52 Alligator", "Attack helo", "Heavy helo", "Air", 1750, 20, 430, "Air", 90, 10, 12, 22, 92, 10, 8, 8.5, 2.8, "Vikhr", "MANPADS", "Armour", ""),
    ("EG-16", "Egypt", "WAVE1", "Rafale", "Fighter", "Premium", "Air", 2000, 24, 360, "Air", 135, 12, 10, 16, 48, 62, 22, 13.0, 3.2, "SCALP-flavour long CD", "SAM", "Air + strike", ""),
    ("EG-17", "Egypt", "WAVE1", "MiG-29M", "Fighter", "Dogfight", "Air", 1500, 18, 300, "Air", 140, 11, 6, 10, 28, 58, 10, 11.0, 3.0, "A2A focus", "Long SAM", "Enemy fighters", ""),
    ("EG-18", "Egypt", "WAVE1", "Missile boat", "Naval", "FAC", "Sea", 1300, 18, 500, "Naval", 85, 10, 20, 25, 30, 20, 40, 10.0, 3.0, "Anti-ship + shore", "Air / frigate", "Unescorted landing", ""),
    ("EG-19", "Egypt", "WAVE1", "FREMM-style frigate", "Naval", "AA sea", "Sea", 2800, 30, 1400, "Naval", 55, 14, 15, 20, 25, 70, 30, 14.0, 2.5, "Exocet + Aster flavour", "Sub / mass air", "Air over water", ""),
    ("EG-20", "Egypt", "WAVE1", "Type-209 flavour sub", "Naval", "Stealth", "Sea", 2200, 28, 700, "Naval", 40, 8, 0, 0, 0, 0, 0, 8.0, 8.0, "Torpedo / scout", "Sonar buildings", "Surface fleet", "Detectable"),

    # WAVE 0 — ALGERIA
    ("DZ-01", "Algeria", "WAVE0", "ANP rifle squad", "Infantry", "Line", "Land", 140, 8, 125, "Soft", 52, 7, 11, 6, 2, 1, 4, 5.5, 1.0, "Entrench (+armor, immobile)", "IFV / TOS", "Tank in open", "Slice unit. Cheaper than Egypt."),
    ("DZ-02", "Algeria", "WAVE0", "Kornet team", "AT infantry", "AT", "Land", 380, 12, 80, "Soft", 45, 8, 4, 18, 88, 2, 8, 9.0, 4.5, "—", "Artillery", "Closing light", "Slice unit"),
    ("DZ-03", "Algeria", "WAVE0", "Igla team", "AA infantry", "AA", "Land", 340, 12, 80, "Soft", 45, 9, 3, 4, 3, 52, 5, 8.0, 5.0, "—", "Artillery", "High jet", "Slice unit"),
    ("DZ-04", "Algeria", "WAVE0", "Engineer", "Engineer", "Utility", "Land", 500, 10, 80, "Soft", 50, 6, 0, 0, 0, 0, 0, 2.0, 0.0, "Capture / repair", "Anything", "Escort", "Slice unit"),
    ("DZ-05", "Algeria", "WAVE0", "BMP-2M Kornet", "IFV", "Workhorse", "Land", 750, 12, 400, "Medium", 68, 8, 20, 18, 28, 8, 10, 6.5, 1.2, "Kornet rack", "ATGM / tank", "Infantry", "Slice unit"),
    ("DZ-06", "Algeria", "WAVE0", "T-72M", "Light tank", "Meat shield", "Land", 900, 12, 700, "Heavy", 58, 7, 16, 26, 52, 4, 14, 7.0, 2.3, "Cheap wall", "Modern AT / air", "Infantry", "Slice unit"),
    ("DZ-07", "Algeria", "WAVE0", "T-90SA", "MBT", "Main tank", "Land", 1500, 18, 1180, "Heavy", 62, 8, 20, 32, 80, 6, 20, 8.0, 2.0, "Shtora dazzler (ATGM break chance)", "Air + ATGM", "Peer MBT", "Slice unit. Faction cheaper tanks."),
    ("DZ-08", "Algeria", "WAVE0", "TOS-1A", "MLRS", "Thermobaric", "Land", 1600, 20, 480, "Medium", 50, 8, 90, 55, 35, 6, 110, 7.0, 10.0, "Short-range horror vs garrison / inf", "Air / tanks front", "City / blobs", "Slice identity unit"),
    ("DZ-09", "Algeria", "WAVE0", "Mi-28NE", "Attack helo", "AT air", "Air", 1550, 18, 400, "Air", 90, 10, 12, 18, 78, 8, 8, 8.0, 3.2, "Tougher, less precise than Apache", "MANPADS / fighter", "Tanks no AA", "Slice unit"),
    ("DZ-10", "Algeria", "WAVE0", "Su-30MKA", "Fighter", "Main jet", "Air", 1800, 22, 360, "Air", 132, 12, 10, 16, 44, 58, 20, 13.0, 3.3, "R-77 flavour long shot", "S-400 peer / F-35", "Strike + air", "Slice unit"),
    ("DZ-11", "Algeria", "WAVE1", "Fuchs 2", "APC", "Mine-resist", "Land", 620, 12, 340, "Light", 78, 7, 14, 8, 4, 2, 6, 6.0, 1.1, "—", "Auto-cannon", "Infantry", ""),
    ("DZ-12", "Algeria", "WAVE1", "BMPT-72 Terminator", "Tank escort", "Anti-infantry", "Land", 1600, 20, 980, "Heavy", 60, 8, 40, 35, 40, 18, 18, 7.0, 1.1, "Eats ATGM teams and infantry", "Tanks / air", "Infantry blobs", "Identity"),
    ("DZ-13", "Algeria", "WAVE1", "2S1 Gvozdika", "SPG", "Light arty", "Land", 1000, 14, 380, "Medium", 58, 9, 28, 32, 36, 6, 70, 12.0, 5.5, "—", "Air", "Soft", ""),
    ("DZ-14", "Algeria", "WAVE1", "BM-30 Smerch", "MLRS", "Heavy rockets", "Land", 1700, 22, 420, "Medium", 52, 10, 70, 55, 40, 8, 100, 22.0, 10.0, "Identity MLRS", "Air / counterbattery", "Base", ""),
    ("DZ-15", "Algeria", "WAVE1", "Pantsir-S1", "Mobile AA", "Gun+missile", "Land", 1300, 16, 400, "Medium", 70, 12, 4, 6, 6, 70, 8, 10.0, 1.5, "Best vs helo and cruise", "SEAD / tanks", "Air", "Identity AA"),
    ("DZ-16", "Algeria", "WAVE1", "MiG-29", "Fighter", "Cheap air", "Air", 1400, 18, 290, "Air", 138, 11, 6, 10, 26, 55, 10, 11.0, 3.0, "—", "Better fighter / SAM", "Helo", ""),
    ("DZ-17", "Algeria", "WAVE1", "Su-24 / Su-34 flavour", "Strike jet", "A2G", "Air", 1700, 22, 340, "Air", 120, 11, 16, 22, 50, 20, 40, 12.0, 4.0, "Poor dogfight", "Fighter / SAM", "Buildings", ""),
    ("DZ-18", "Algeria", "WAVE1", "Kilo 636 flavour", "Naval", "Sub", "Sea", 2400, 30, 750, "Naval", 38, 8, 0, 0, 0, 0, 0, 8.0, 9.0, "Club-S land-attack 1-shot long CD", "ASW", "Coast / fleet", ""),

    # SAUDI WAVE1
    ("SA-01", "Saudi", "WAVE1", "SANG infantry", "Infantry", "Line+", "Land", 180, 9, 130, "Soft", 56, 7, 13, 7, 2, 2, 5, 5.5, 1.0, "Mount/dismount technical", "IFV", "Tank", "Better than basic rifle"),
    ("SA-02", "Saudi", "WAVE1", "TOW team", "AT infantry", "AT", "Land", 420, 12, 80, "Soft", 45, 8, 4, 20, 92, 2, 8, 9.5, 4.8, "Steer 2 seconds", "Artillery", "Closing light", ""),
    ("SA-03", "Saudi", "WAVE1", "Avenger", "Mobile AA", "AA humvee", "Land", 600, 12, 220, "Light", 85, 10, 2, 4, 2, 50, 6, 8.0, 2.5, "Stinger rack", "Tanks", "Helo / drone", ""),
    ("SA-04", "Saudi", "WAVE1", "Engineer", "Engineer", "Utility", "Land", 500, 10, 80, "Soft", 50, 6, 0, 0, 0, 0, 0, 2.0, 0.0, "Capture / repair", "Anything", "Escort", ""),
    ("SA-05", "Saudi", "WAVE1", "M2A2 Bradley", "IFV", "Best IFV", "Land", 850, 14, 430, "Medium", 72, 8, 26, 22, 30, 10, 12, 6.5, 1.1, "TOW", "ATGM / tank", "Infantry + light", "Identity IFV"),
    ("SA-06", "Saudi", "WAVE1", "M-ATV", "Light vehicle", "Raid", "Land", 550, 10, 260, "Light", 95, 8, 16, 14, 18, 4, 6, 6.0, 1.3, "HMG or ATGM variant", "Auto-cannon / air", "Harvesters", ""),
    ("SA-07", "Saudi", "WAVE1", "M60A3", "Light tank", "Reserve", "Land", 1000, 14, 720, "Heavy", 60, 8, 18, 28, 55, 4, 16, 7.0, 2.2, "—", "Modern AT", "Infantry", ""),
    ("SA-08", "Saudi", "WAVE1", "M1A2S Abrams", "MBT", "Best Western tank", "Land", 1800, 20, 1250, "Heavy", 66, 8, 22, 36, 88, 8, 24, 8.5, 1.9, "Blow-out panel (1 pen = crit not death)", "Air + ATGM mass", "Peer MBT", "Identity tank"),
    ("SA-09", "Saudi", "WAVE1", "CAESAR", "SPG", "Truck gun", "Land", 1250, 16, 380, "Light", 80, 10, 36, 42, 48, 8, 95, 16.0, 6.0, "Fast reposition", "Air", "Buildings", ""),
    ("SA-10", "Saudi", "WAVE1", "M270 MLRS", "MLRS", "Guided-ish", "Land", 1550, 18, 400, "Medium", 58, 10, 55, 48, 40, 8, 80, 18.0, 8.0, "More precise than Grad", "Air", "Base", ""),
    ("SA-11", "Saudi", "WAVE1", "AH-64E Apache", "Attack helo", "Best AT helo", "Air", 1750, 20, 400, "Air", 96, 11, 10, 22, 95, 10, 8, 9.0, 2.8, "Longbow cone reveal", "MANPADS / fighter", "Tanks", ""),
    ("SA-12", "Saudi", "WAVE1", "UH-60 Black Hawk", "Transport helo", "Lift", "Air", 1100, 16, 320, "Air", 100, 8, 10, 6, 4, 4, 4, 4.0, 1.5, "Carries squads", "AA", "Behind lines", ""),
    ("SA-13", "Saudi", "WAVE1", "F-15SA", "Fighter", "King of air", "Air", 2200, 24, 400, "Air", 145, 13, 12, 20, 55, 70, 25, 14.0, 3.0, "Heavy A2G or air superiority", "S-400 / F-35", "Anything in sky", "Identity jet"),
    ("SA-14", "Saudi", "WAVE1", "Eurofighter Typhoon", "Fighter", "Agile", "Air", 1900, 22, 350, "Air", 150, 12, 8, 12, 30, 65, 12, 12.0, 2.8, "Better dogfight than payload", "SAM", "Fighters", ""),
    ("SA-15", "Saudi", "WAVE1", "Tornado IDS", "Strike jet", "Aging strike", "Air", 1400, 18, 300, "Air", 118, 10, 14, 20, 42, 16, 35, 11.0, 4.0, "Do not dogfight", "Fighter", "Buildings", ""),

    # UAE WAVE1
    ("AE-01", "UAE", "WAVE1", "Presidential Guard", "Infantry", "Elite inf", "Land", 250, 12, 160, "Soft", 60, 8, 16, 10, 4, 3, 8, 5.5, 0.9, "Breach charge", "IFV / TOS", "Garrison", "Expensive infantry"),
    ("AE-02", "UAE", "WAVE1", "Javelin team", "AT infantry", "Best inf AT", "Land", 480, 14, 80, "Soft", 45, 8, 3, 16, 100, 2, 6, 8.5, 5.0, "Fire-and-forget", "Artillery", "Tanks", ""),
    ("AE-03", "UAE", "WAVE1", "Engineer", "Engineer", "Utility", "Land", 500, 10, 80, "Soft", 50, 6, 0, 0, 0, 0, 0, 2.0, 0.0, "Capture / repair", "Anything", "Escort", ""),
    ("AE-04", "UAE", "WAVE1", "Nimr Ajban", "Light vehicle", "Desert 4x4", "Land", 520, 10, 240, "Light", 100, 8, 14, 16, 22, 4, 6, 6.0, 1.4, "HMG or Kornet", "Auto-cannon", "Raid", ""),
    ("AE-05", "UAE", "WAVE1", "BMP-3", "IFV", "Heavy IFV", "Land", 880, 14, 450, "Medium", 70, 8, 28, 24, 32, 10, 14, 6.5, 1.3, "100mm + 30mm", "ATGM / tank", "Infantry", ""),
    ("AE-06", "UAE", "WAVE1", "Rabdan 8x8", "IFV", "Wheeled IFV", "Land", 900, 14, 440, "Medium", 82, 8, 24, 20, 26, 10, 12, 6.5, 1.2, "Smoke + dismount", "ATGM", "Manoeuvre", ""),
    ("AE-07", "UAE", "WAVE1", "Leclerc", "MBT", "Fast MBT", "Land", 1700, 20, 1100, "Heavy", 75, 8, 20, 34, 84, 6, 22, 8.0, 1.5, "Autoloader burst (3 shots, long reload)", "ATGM + air", "Flank", "Identity tank — speed"),
    ("AE-08", "UAE", "WAVE1", "G6 Rhino", "SPG", "Wheeled heavy", "Land", 1400, 18, 460, "Medium", 70, 10, 40, 45, 52, 8, 100, 16.0, 6.5, "—", "Air", "Buildings", ""),
    ("AE-09", "UAE", "WAVE1", "HIMARS", "MLRS", "Precision", "Land", 1700, 20, 360, "Light", 80, 11, 40, 50, 70, 10, 90, 22.0, 9.0, "ATACMS-flavour 1 rocket long CD", "Air / hunters", "Conyard", "Identity unit"),
    ("AE-10", "UAE", "WAVE1", "AH-64 Apache", "Attack helo", "AT air", "Air", 1650, 18, 380, "Air", 95, 10, 10, 20, 88, 8, 8, 8.0, 3.0, "—", "MANPADS", "Tanks", ""),
    ("AE-11", "UAE", "WAVE1", "CH-47 Chinook", "Transport helo", "Heavy lift", "Air", 1400, 18, 420, "Air", 92, 8, 8, 6, 4, 4, 4, 4.0, 1.6, "Can carry a vehicle", "AA", "Rear", ""),
    ("AE-12", "UAE", "WAVE1", "F-16E Block 60", "Fighter", "Best-in-class multi", "Air", 1850, 22, 340, "Air", 138, 12, 10, 16, 46, 60, 20, 13.0, 3.1, "Long station time", "SAM / F-15 / F-35", "Mixed", "Identity jet"),
    ("AE-13", "UAE", "WAVE1", "Mirage 2000-9", "Fighter", "Aging", "Air", 1450, 18, 300, "Air", 136, 11, 8, 12, 32, 55, 14, 11.0, 3.2, "Cheap interceptor / strike", "Better fighter", "Helo", ""),
    ("AE-14", "UAE", "WAVE1", "Rafale (late)", "Fighter", "Tier-3", "Air", 2050, 26, 360, "Air", 136, 12, 10, 16, 50, 64, 22, 13.0, 3.2, "Locked behind late tech", "SAM", "Air + strike", "Not at game start"),
    ("AE-15", "UAE", "WAVE1", "Baynunah corvette", "Naval", "Corvette", "Sea", 2200, 26, 900, "Naval", 62, 12, 12, 16, 20, 40, 24, 12.0, 2.8, "Anti-ship + modest AA", "Air mass / sub", "Boats", ""),

    # TURKEY WAVE2
    ("TR-01", "Turkey", "WAVE2", "Mehmetçik squad", "Infantry", "Line", "Land", 155, 8, 122, "Soft", 55, 7, 12, 7, 3, 1, 5, 5.5, 1.0, "One-shot AT rocket", "IFV", "Tank", ""),
    ("TR-02", "Turkey", "WAVE2", "Bordo Bereli", "SF", "Raid", "Land", 720, 16, 145, "Soft", 66, 8, 18, 14, 26, 4, 10, 5.0, 1.4, "Stealth in brush + C4", "Detection", "Buildings", ""),
    ("TR-03", "Turkey", "WAVE2", "Engineer", "Engineer", "Utility", "Land", 500, 10, 80, "Soft", 50, 6, 0, 0, 0, 0, 0, 2.0, 0.0, "Capture / repair", "Anything", "Escort", ""),
    ("TR-04", "Turkey", "WAVE2", "Kirpi MRAP", "Light vehicle", "Mine-resist", "Land", 560, 10, 280, "Light", 82, 7, 14, 8, 4, 2, 6, 6.0, 1.2, "—", "Auto-cannon", "Raid", ""),
    ("TR-05", "Turkey", "WAVE2", "ACV-15 / Pars", "IFV", "IFV", "Land", 740, 12, 400, "Medium", 72, 8, 22, 16, 20, 8, 10, 6.5, 1.2, "25mm + dismount", "ATGM", "Infantry", ""),
    ("TR-06", "Turkey", "WAVE2", "M60T Sabra", "Light tank", "Mid tank", "Land", 1100, 14, 800, "Heavy", 58, 8, 18, 30, 62, 4, 16, 7.0, 2.1, "—", "Modern AT", "Infantry", ""),
    ("TR-07", "Turkey", "WAVE2", "Leopard 2A4", "MBT", "Main tank", "Land", 1550, 18, 1120, "Heavy", 68, 8, 20, 34, 80, 6, 22, 8.0, 2.0, "—", "ATGM + air", "Peer", "Until Altay"),
    ("TR-08", "Turkey", "WAVE2", "Altay T1", "MBT", "Late MBT", "Land", 1850, 24, 1280, "Heavy", 66, 9, 22, 36, 90, 8, 24, 8.5, 1.9, "APS flavour", "Air mass", "Peer", "Few"),
    ("TR-09", "Turkey", "WAVE2", "T-155 Fırtına", "SPG", "155", "Land", 1250, 16, 430, "Medium", 62, 10, 36, 42, 48, 8, 95, 15.0, 5.8, "Shoot-and-scoot; can take Akıncı lase", "Air", "Buildings", ""),
    ("TR-10", "Turkey", "WAVE2", "Kasırga", "MLRS", "Rockets", "Land", 1350, 16, 380, "Medium", 58, 10, 60, 48, 36, 6, 75, 18.0, 8.0, "Laser from Akıncı", "Air", "Blobs", ""),
    ("TR-11", "Turkey", "WAVE2", "Korkut", "Mobile AA", "Gun AA", "Land", 900, 14, 340, "Medium", 68, 10, 8, 10, 8, 45, 8, 6.0, 0.8, "Eats drones and helos", "Tanks / fighters", "Swarm / helo", "Key vs Iran"),
    ("TR-12", "Turkey", "WAVE2", "T129 ATAK", "Attack helo", "AT helo", "Air", 1500, 18, 360, "Air", 98, 10, 10, 18, 80, 8, 8, 8.0, 3.0, "UMTAS", "MANPADS", "Tanks", ""),
    ("TR-13", "Turkey", "WAVE2", "Bayraktar TB2", "UAV", "ISR + light strike", "Air", 350, 8, 90, "Air", 70, 14, 6, 10, 18, 8, 8, 10.0, 4.0, "Expendable scout. Mesh paint.", "Fighters / Korkut / Pantsir", "Vision + light AT", "THE unit"),
    ("TR-14", "Turkey", "WAVE2", "Akıncı", "UAV", "Heavy UCAV", "Air", 1100, 16, 220, "Air", 85, 14, 12, 22, 55, 16, 16, 14.0, 5.0, "MAM-T / SOM-flavour; lase for Fırtına", "Fighter / long SAM", "Artillery partner", "Identity"),
    ("TR-15", "Turkey", "WAVE2", "F-16C Özgür / Blk70", "Fighter", "Main jet", "Air", 1650, 20, 320, "Air", 132, 12, 8, 14, 40, 56, 18, 12.0, 3.4, "No F-35", "Better fighter / SAM", "Mixed", ""),
    ("TR-16", "Turkey", "WAVE2", "F-4E Terminator", "Strike jet", "Aging", "Air", 1300, 16, 300, "Air", 115, 10, 14, 20, 40, 14, 32, 11.0, 4.0, "Do not dogfight Rafales", "Fighter", "Buildings", ""),
    ("TR-17", "Turkey", "WAVE2", "Kızılelma (late)", "UAV", "Jet UCAV", "Air", 1400, 22, 260, "Air", 140, 12, 8, 14, 36, 40, 14, 12.0, 3.5, "Hunts high-value, poor vs air superiority", "Fighter", "Strike", "Late"),
    ("TR-18", "Turkey", "WAVE2", "MİLGEM corvette", "Naval", "Corvette", "Sea", 2300, 26, 950, "Naval", 64, 12, 12, 16, 22, 42, 26, 12.0, 2.8, "Atmaca anti-ship", "Air mass / sub", "Boats", ""),

    # ISRAEL WAVE3
    ("IL-01", "Israel", "WAVE3", "Tzanhanim / Golani", "Infantry", "Best basic", "Land", 220, 10, 150, "Soft", 58, 8, 15, 9, 3, 3, 7, 5.5, 0.95, "Rifle grenade", "IFV / TOS", "Garrison", ""),
    ("IL-02", "Israel", "WAVE3", "Sayeret pair", "SF", "Raid", "Land", 780, 16, 150, "Soft", 68, 9, 16, 16, 28, 4, 8, 5.0, 1.4, "Stealth + Spike mini + C4", "Detection", "Pick", ""),
    ("IL-03", "Israel", "WAVE3", "Spike team", "AT infantry", "NLOS AT", "Land", 500, 14, 80, "Soft", 45, 9, 3, 16, 105, 2, 6, 10.0, 5.2, "NLOS from behind ridge, long CD", "Artillery", "Tanks", ""),
    ("IL-04", "Israel", "WAVE3", "Engineer", "Engineer", "Utility", "Land", 500, 10, 80, "Soft", 50, 6, 0, 0, 0, 0, 0, 2.0, 0.0, "Capture / repair", "Anything", "Escort", ""),
    ("IL-05", "Israel", "WAVE3", "Eitan 8x8", "IFV", "Wheeled", "Land", 920, 14, 440, "Medium", 84, 8, 24, 20, 24, 12, 12, 6.5, 1.15, "30mm variant", "ATGM", "Manoeuvre", ""),
    ("IL-06", "Israel", "WAVE3", "Namer", "APC", "Heaviest taxi", "Land", 1100, 16, 900, "Heavy", 55, 7, 20, 14, 10, 8, 10, 5.0, 1.2, "Trophy. Infantry inside shrug small arms.", "Tanks / air", "Urban", "Identity APC"),
    ("IL-07", "Israel", "WAVE3", "Merkava Mk III", "Light tank", "Reserve", "Land", 1200, 16, 900, "Heavy", 58, 8, 18, 30, 68, 6, 18, 7.5, 2.1, "—", "Modern AT", "Infantry", ""),
    ("IL-08", "Israel", "WAVE3", "Merkava Mk IV Windbreaker", "MBT", "Trophy tank", "Land", 1850, 22, 1300, "Heavy", 62, 8, 22, 34, 86, 8, 24, 8.0, 2.0, "Trophy APS + 60mm mortar pop", "Air mass + ATGM mass", "Urban + peer", "Identity tank"),
    ("IL-09", "Israel", "WAVE3", "M109 Doher", "SPG", "155", "Land", 1250, 16, 420, "Medium", 55, 10, 36, 42, 48, 8, 95, 14.0, 6.0, "—", "Air", "Buildings", ""),
    ("IL-10", "Israel", "WAVE3", "PULS / Menatetz", "MLRS", "Guided", "Land", 1600, 18, 400, "Medium", 58, 10, 50, 50, 55, 10, 80, 18.0, 8.0, "Not Grad-inaccurate", "Air", "Base", ""),
    ("IL-11", "Israel", "WAVE3", "AH-64 Saraf", "Attack helo", "AT air", "Air", 1700, 18, 390, "Air", 95, 10, 10, 20, 90, 8, 8, 8.5, 2.9, "—", "MANPADS", "Tanks", ""),
    ("IL-12", "Israel", "WAVE3", "Hermes 450/900", "UAV", "ISR", "Air", 450, 10, 110, "Air", 75, 14, 4, 8, 14, 6, 6, 10.0, 4.0, "Spot + light strike. Not a Shahed.", "Fighter / AA", "Vision", ""),
    ("IL-13", "Israel", "WAVE3", "F-16I Sufa", "Fighter", "Workhorse", "Air", 1750, 20, 330, "Air", 134, 12, 10, 16, 44, 58, 18, 12.5, 3.2, "—", "SAM / F-35 peer", "Mixed", ""),
    ("IL-14", "Israel", "WAVE3", "F-15I Ra'am", "Fighter", "Heavy strike", "Air", 2100, 24, 390, "Air", 142, 13, 14, 22, 58, 30, 28, 14.0, 3.2, "Deep payload", "S-400", "Buildings + air", ""),
    ("IL-15", "Israel", "WAVE3", "F-35I Adir", "Fighter", "Stealth strike", "Air", 2400, 28, 340, "Air", 140, 14, 10, 16, 50, 55, 20, 12.0, 3.0, "Short air cloak. Few pads.", "Lucky SAM / numbers", "Opening strike", "Identity jet. Best air quality."),
    ("IL-16", "Israel", "WAVE3", "Sa'ar 6 flavour", "Naval", "AA sea", "Sea", 2600, 28, 1100, "Naval", 60, 13, 12, 16, 22, 55, 26, 13.0, 2.6, "Barak-8 + anti-ship", "Sub / mass", "Air over water", ""),

    # INDIA WAVE3
    ("IN-01", "India", "WAVE3", "Rifle section", "Infantry", "Line", "Land", 150, 8, 125, "Soft", 54, 7, 12, 6, 2, 1, 4, 5.5, 1.0, "LMG burst", "IFV", "Tank", ""),
    ("IN-02", "India", "WAVE3", "Para SF", "SF", "Raid", "Land", 720, 16, 145, "Soft", 65, 8, 18, 14, 26, 4, 10, 5.0, 1.4, "Stealth + C4", "Detection", "Buildings", ""),
    ("IN-03", "India", "WAVE3", "Nag team / NAMICA", "AT infantry", "Indigenous AT", "Land", 430, 13, 80, "Soft", 45, 8, 3, 17, 94, 2, 7, 9.0, 4.8, "Fire-and-forget", "Artillery", "Tanks", ""),
    ("IN-04", "India", "WAVE3", "Engineer", "Engineer", "Utility", "Land", 500, 10, 80, "Soft", 50, 6, 0, 0, 0, 0, 0, 2.0, 0.0, "Capture / repair", "Anything", "Escort", ""),
    ("IN-05", "India", "WAVE3", "BMP-2 Sarath", "IFV", "Workhorse", "Land", 720, 12, 390, "Medium", 68, 8, 20, 16, 22, 8, 10, 6.5, 1.2, "—", "ATGM / tank", "Infantry", ""),
    ("IN-06", "India", "WAVE3", "T-72 Ajeya", "Light tank", "Meat", "Land", 900, 12, 700, "Heavy", 58, 7, 16, 26, 52, 4, 14, 7.0, 2.3, "—", "Modern AT", "Infantry", ""),
    ("IN-07", "India", "WAVE3", "T-90S Bhishma", "MBT", "Main tank", "Land", 1520, 18, 1180, "Heavy", 62, 8, 20, 32, 80, 6, 20, 8.0, 2.0, "Shtora-ish", "Air + ATGM", "Peer", "The wall"),
    ("IN-08", "India", "WAVE3", "Arjun Mk1A", "MBT", "Pride tank", "Land", 1800, 24, 1300, "Heavy", 55, 8, 22, 36, 92, 6, 24, 8.5, 2.2, "Great gun, bad legs", "Air / flank", "Front duel", "Identity pride"),
    ("IN-09", "India", "WAVE3", "K9 Vajra", "SPG", "155", "Land", 1300, 16, 450, "Medium", 60, 10, 38, 44, 50, 8, 98, 15.0, 5.8, "—", "Air", "Buildings", ""),
    ("IN-10", "India", "WAVE3", "Pinaka", "MLRS", "Rockets", "Land", 1450, 18, 400, "Medium", 58, 10, 62, 50, 38, 8, 78, 18.0, 8.0, "Guided upgrade", "Air", "Blobs", ""),
    ("IN-11", "India", "WAVE3", "Prachand LCH", "Attack helo", "Cheap helo", "Air", 1300, 16, 320, "Air", 100, 9, 8, 16, 70, 8, 7, 7.5, 3.2, "Indigenous", "MANPADS", "Light armour", ""),
    ("IN-12", "India", "WAVE3", "AH-64E", "Attack helo", "Premium helo", "Air", 1700, 20, 390, "Air", 95, 10, 10, 20, 90, 8, 8, 8.5, 2.9, "—", "MANPADS", "Tanks", ""),
    ("IN-13", "India", "WAVE3", "Tejas Mk1A", "Fighter", "Indigenous light", "Air", 1450, 18, 300, "Air", 134, 11, 8, 12, 34, 50, 14, 11.0, 3.2, "Fine, not Rafale", "Better fighter", "Helo / strike", ""),
    ("IN-14", "India", "WAVE3", "Su-30MKI", "Fighter", "Sky wall", "Air", 1850, 22, 380, "Air", 132, 12, 10, 16, 46, 58, 20, 13.0, 3.3, "Long BVR", "F-35 / Rafale numbers", "Mixed", "Numbers jet"),
    ("IN-15", "India", "WAVE3", "Rafale", "Fighter", "Premium", "Air", 2050, 24, 360, "Air", 136, 12, 10, 16, 50, 64, 22, 13.0, 3.1, "Meteor-flavour long shot", "SAM", "Air + strike", ""),
    ("IN-16", "India", "WAVE3", "Jaguar (aging)", "Strike jet", "Cheap strike", "Air", 1250, 16, 280, "Air", 116, 10, 14, 20, 38, 14, 30, 10.5, 4.0, "Dying breed", "Fighter", "Buildings", ""),
    ("IN-17", "India", "WAVE3", "BrahMos TEL", "Missile", "Precision cruise", "Land", 1800, 22, 320, "Light", 55, 8, 20, 40, 80, 20, 80, 28.0, 16.0, "LANE mechanic — draw the path", "Intercept umbrellas", "Conyard / ship", "Identity"),
    ("IN-18", "India", "WAVE3", "Kalvari flavour sub", "Naval", "Sub", "Sea", 2300, 28, 720, "Naval", 40, 8, 0, 0, 0, 0, 0, 8.0, 8.5, "Torpedo", "ASW", "Fleet", ""),
    ("IN-19", "India", "WAVE3", "INS Vikrant flavour", "Naval", "Carrier", "Sea", 6000, 50, 2800, "Naval", 42, 16, 20, 30, 40, 80, 40, 16.0, 3.0, "ONE per match. Jets + SAM. Huge.", "Subs + saturation missiles", "Sea control", "Late naval only"),

    # PAKISTAN WAVE3
    ("PK-01", "Pakistan", "WAVE3", "Infantry section", "Infantry", "Line", "Land", 145, 8, 120, "Soft", 56, 7, 12, 6, 2, 1, 4, 5.5, 1.0, "RPG", "IFV", "Tank", ""),
    ("PK-02", "Pakistan", "WAVE3", "SSG pair", "SF", "Raid", "Land", 700, 16, 140, "Soft", 66, 8, 18, 14, 26, 4, 10, 5.0, 1.4, "Stealth + C4", "Detection", "Pick", ""),
    ("PK-03", "Pakistan", "WAVE3", "Baktar-Shikan", "AT infantry", "AT", "Land", 390, 12, 80, "Soft", 45, 8, 4, 17, 86, 2, 8, 8.5, 4.6, "—", "Artillery", "Tanks", ""),
    ("PK-04", "Pakistan", "WAVE3", "Engineer", "Engineer", "Utility", "Land", 500, 10, 80, "Soft", 50, 6, 0, 0, 0, 0, 0, 2.0, 0.0, "Capture / repair", "Anything", "Escort", ""),
    ("PK-05", "Pakistan", "WAVE3", "Talha / M113", "APC", "Taxi", "Land", 480, 10, 270, "Light", 78, 7, 14, 8, 4, 2, 6, 6.0, 1.1, "—", "Auto-cannon", "Infantry", ""),
    ("PK-06", "Pakistan", "WAVE3", "Al-Zarrar", "Light tank", "Reserve", "Land", 850, 12, 650, "Heavy", 56, 7, 16, 24, 48, 4, 12, 6.5, 2.4, "Cheap", "Modern AT", "Infantry", ""),
    ("PK-07", "Pakistan", "WAVE3", "T-80UD", "MBT", "Fast mid", "Land", 1300, 16, 980, "Heavy", 72, 8, 18, 30, 70, 6, 18, 7.5, 2.0, "Speed", "ATGM + air", "Flank", ""),
    ("PK-08", "Pakistan", "WAVE3", "Al-Khalid", "MBT", "Main tank", "Land", 1450, 18, 1080, "Heavy", 68, 8, 20, 32, 76, 6, 20, 8.0, 2.0, "—", "Air + ATGM", "Peer", ""),
    ("PK-09", "Pakistan", "WAVE3", "Haider (VT-4)", "MBT", "Premium", "Land", 1650, 22, 1200, "Heavy", 66, 8, 22, 34, 84, 6, 22, 8.5, 1.95, "Late", "Air", "Peer", ""),
    ("PK-10", "Pakistan", "WAVE3", "M109 / SH-15", "SPG", "155", "Land", 1200, 16, 420, "Medium", 58, 10, 34, 40, 46, 8, 94, 14.0, 6.0, "—", "Air", "Buildings", ""),
    ("PK-11", "Pakistan", "WAVE3", "Fatah / A-100 MLRS", "MLRS", "Rockets", "Land", 1400, 16, 380, "Medium", 58, 10, 60, 48, 36, 6, 76, 17.0, 8.0, "—", "Air", "Blobs", ""),
    ("PK-12", "Pakistan", "WAVE3", "Z-10ME", "Attack helo", "AT helo", "Air", 1450, 18, 350, "Air", 96, 10, 10, 18, 78, 8, 8, 8.0, 3.1, "New identity rotor", "MANPADS", "Tanks", ""),
    ("PK-13", "Pakistan", "WAVE3", "JF-17 Block II", "Fighter", "Volume jet", "Air", 1350, 16, 290, "Air", 134, 11, 8, 12, 34, 48, 14, 11.0, 3.3, "15% faster rebuild (unique)", "Better fighter", "Mixed volume", "THE volume jet"),
    ("PK-14", "Pakistan", "WAVE3", "JF-17 Block III", "Fighter", "BVR light", "Air", 1550, 18, 310, "Air", 136, 12, 8, 14, 38, 58, 16, 12.0, 3.2, "PL-15 flavour. Still not Rafale.", "Rafale / F-35 / SAM", "Air", ""),
    ("PK-15", "Pakistan", "WAVE3", "F-16 MLU / Blk52", "Fighter", "Veteran quality", "Air", 1700, 20, 320, "Air", 134, 12, 8, 14, 42, 56, 18, 12.0, 3.3, "—", "SAM / F-35", "Mixed", ""),
    ("PK-16", "Pakistan", "WAVE3", "J-10CE", "Fighter", "Best PAF dogfight", "Air", 1900, 22, 340, "Air", 148, 12, 8, 14, 40, 62, 16, 12.0, 2.9, "Limited numbers", "SAM / F-35", "Fighters", "Identity quality jet"),
    ("PK-17", "Pakistan", "WAVE3", "Mirage III/V", "Strike jet", "Aging strike", "Air", 1200, 16, 270, "Air", 118, 10, 12, 18, 36, 12, 28, 10.0, 4.0, "Conventional stand-off only", "Fighter", "Buildings", "NO nukes"),
    ("PK-18", "Pakistan", "WAVE3", "Babur TEL", "Missile", "Cruise", "Land", 1500, 20, 300, "Light", 55, 8, 16, 32, 60, 16, 70, 24.0, 14.0, "WINDOW mechanic — stack 2", "Intercept umbrellas", "Base", "Identity"),
    ("PK-19", "Pakistan", "WAVE3", "Hangor-class sub", "Naval", "AIP sub", "Sea", 2500, 32, 800, "Naval", 36, 8, 0, 0, 0, 0, 0, 9.0, 9.0, "Land-attack 1-shot long CD", "ASW", "Coast / fleet", "Identity navy"),

    # IRAN WAVE2
    ("IR-01", "Iran", "WAVE2", "Regular infantry", "Infantry", "Cheap line", "Land", 130, 7, 115, "Soft", 52, 7, 11, 6, 2, 1, 4, 5.5, 1.05, "RPG + entrench", "IFV / TOS", "Tank", "Cheapest rifle"),
    ("IR-02", "Iran", "WAVE2", "Takavar flavour", "SF", "Raid", "Land", 680, 16, 135, "Soft", 64, 8, 16, 14, 24, 4, 9, 5.0, 1.5, "Stealth", "Detection", "Pick", ""),
    ("IR-03", "Iran", "WAVE2", "Toophan / Dehlavieh", "AT infantry", "AT copies", "Land", 370, 12, 80, "Soft", 45, 8, 4, 16, 82, 2, 8, 8.5, 4.6, "TOW / Kornet copies", "Artillery", "Tanks", ""),
    ("IR-04", "Iran", "WAVE2", "Engineer", "Engineer", "Utility", "Land", 500, 10, 80, "Soft", 50, 6, 0, 0, 0, 0, 0, 2.0, 0.0, "Capture / repair", "Anything", "Escort", ""),
    ("IR-05", "Iran", "WAVE2", "Boragh APC", "APC", "Cheap taxi", "Land", 450, 10, 250, "Light", 70, 7, 12, 7, 3, 2, 5, 5.5, 1.2, "—", "Auto-cannon", "Infantry", ""),
    ("IR-06", "Iran", "WAVE2", "T-72S", "Light tank", "Main cheap tank", "Land", 880, 12, 680, "Heavy", 56, 7, 16, 26, 50, 4, 14, 7.0, 2.3, "—", "Modern AT", "Infantry", ""),
    ("IR-07", "Iran", "WAVE2", "Karrar", "MBT", "Best IR tank", "Land", 1350, 18, 1000, "Heavy", 60, 8, 18, 30, 72, 6, 18, 8.0, 2.1, "Still not Merkava / Altay / Abrams", "Air + ATGM", "Peer budget", "Identity tank"),
    ("IR-08", "Iran", "WAVE2", "Raad SPG / M-46", "SPG", "Arty", "Land", 1050, 14, 360, "Medium", 52, 9, 30, 34, 38, 6, 80, 13.0, 6.0, "—", "Air", "Soft", ""),
    ("IR-09", "Iran", "WAVE2", "Fajr-5 / Zelzal", "MLRS", "Heavy rockets", "Land", 1250, 16, 360, "Medium", 50, 9, 65, 45, 32, 6, 80, 16.0, 9.0, "Inaccurate, big", "Air / Dome", "Blobs", ""),
    ("IR-10", "Iran", "WAVE2", "Fateh TEL", "Missile", "Tactical ballistic", "Land", 1400, 18, 280, "Light", 60, 8, 20, 35, 55, 16, 90, 20.0, 14.0, "PACKS in 8s, looks like a truck", "ABM / Dome / S-400", "Base", "Identity. Disperse mechanic."),
    ("IR-11", "Iran", "WAVE2", "Khordad-15", "Mobile AA", "Mid SAM", "Land", 1100, 16, 360, "Medium", 62, 12, 2, 4, 4, 58, 10, 11.0, 4.0, "Kills drones and the odd jet", "SEAD / tanks", "Air", ""),
    ("IR-12", "Iran", "WAVE2", "Herz-9 / point AA", "Mobile AA", "Short AA", "Land", 700, 12, 260, "Light", 70, 9, 6, 8, 4, 40, 6, 5.0, 1.0, "Vs drones", "Tanks", "Swarm defence", ""),
    ("IR-13", "Iran", "WAVE2", "AH-1 leftover / Mi-28 few", "Attack helo", "Thin helo", "Air", 1300, 16, 300, "Air", 88, 9, 8, 14, 64, 6, 7, 7.5, 3.4, "Thin on purpose", "MANPADS / fighter", "Soft armour", ""),
    ("IR-14", "Iran", "WAVE2", "Mohajer-6 / Shahed-129", "UAV", "Reusable ISR/strike", "Air", 400, 10, 100, "Air", 72, 13, 6, 10, 16, 8, 8, 10.0, 4.2, "Reusable, not the swarm", "Fighter / AA", "Vision", ""),
    ("IR-15", "Iran", "WAVE2", "Shahed-136", "UAV", "One-way", "Air", 150, 5, 40, "Air", 65, 10, 8, 12, 20, 4, 25, 6.0, 0.0, "Built at Workshop. Does not return. HP from SwarmHP knob.", "Dome / Korkut / Pantsir / fighters", "Saturation", "THE unit. Cost is the point."),
    ("IR-16", "Iran", "WAVE2", "Karrar UCAV", "UAV", "Jet one-way", "Air", 400, 10, 80, "Air", 150, 10, 10, 16, 30, 8, 20, 8.0, 0.0, "Faster, fewer", "Fighter", "Strike", ""),
    ("IR-17", "Iran", "WAVE2", "Kowsar / Saeqeh / F-14 leftover", "Fighter", "Poor A2A", "Air", 1200, 16, 260, "Air", 128, 10, 6, 8, 20, 40, 10, 10.0, 3.6, "If this beats a Rafale, hotfix it", "Any modern fighter", "Helo if lucky", "Intentionally worst air"),
    ("IR-18", "Iran", "WAVE2", "MiG-29 / Su-24 leftover", "Strike jet", "Thin strike", "Air", 1400, 18, 300, "Air", 120, 10, 12, 18, 38, 16, 28, 11.0, 4.0, "Expensive to replace", "Fighter / SAM", "Buildings", ""),
    ("IR-19", "Iran", "WAVE2", "Ghadir mini-sub", "Naval", "Denial", "Sea", 1600, 22, 420, "Naval", 30, 6, 0, 0, 0, 0, 0, 5.0, 10.0, "Not a Hangor. Ambush.", "ASW", "Coast", ""),
]

# ============================================================
# SHEET: UNITS
# ============================================================
wu = wb.create_sheet("02_UNITS")
wu.sheet_properties.tabColor = "2C5F4A"
wu.freeze_panes = "E3"
wu.auto_filter.ref = "A2:AD" + str(2 + len(units))
wu.page_setup.orientation = "landscape"
wu.page_setup.fitToPage = True
wu.page_setup.fitToWidth = 1
wu.page_setup.fitToHeight = 0
wu.page_setup.paperSize = wu.PAPERSIZE_A4
wu.page_setup.paperSize = wu.PAPERSIZE_A4
wu.print_title_rows = "1:2"

wu.merge_cells("A1:AD1")
wu["A1"] = "UNIT ROSTER  —  yellow/blue = edit   black = formula   filter Faction or Wave   WAVE0 = slice, tune these first"
wu["A1"].font = font_h
wu["A1"].fill = fill_header
wu["A1"].alignment = center

u_headers = [
    "ID", "Faction", "Wave", "Name", "Class", "Role", "Domain",
    "Cost_cr", "Build_s", "HP", "ArmorClass", "Speed", "Sight",
    "Dmg_Inf", "Dmg_Light", "Dmg_Armor", "Dmg_Air", "Dmg_Bldg", "Range", "ROF_s",
    "Ability", "SoftCounter", "HardCounter", "Notes",
    "DPS_Inf", "DPS_Armor", "DPS_Air", "Cost_per_HP", "CostΔ_vs_MBTref", "CombatIndex",
]
for i, h in enumerate(u_headers, 1):
    c = wu.cell(2, i, h)
    c.font = font_th
    c.fill = fill_sect
    c.alignment = center
    c.border = thin

input_cols = set(range(1, 25))  # A-X
formula_cols = set(range(25, 31))  # Y-AD

for r_i, row in enumerate(units):
    excel_r = r_i + 3
    for c_i, val in enumerate(row, 1):
        cell = wu.cell(excel_r, c_i, val)
        cell.font = font_in if c_i in input_cols else font_f
        cell.alignment = center if c_i not in (4, 21, 22, 23, 24) else left
        cell.border = thin
        cell.fill = alt_fill(excel_r)
        if c_i in (8, 9, 10, 12, 13) or 14 <= c_i <= 20:
            cell.fill = fill_input
            cell.font = font_in
            if isinstance(val, float):
                cell.number_format = "0.0"
            elif isinstance(val, int):
                cell.number_format = "#,##0"
    # faction tint on B
    fac = row[1]
    wu.cell(excel_r, 2).font = Font(name="Calibri", size=10, bold=True, color=FACTION_COLOR.get(fac, "000000"))

    # formulas
    # Y DPS_Inf = N/T if T>0 else 0
    wu.cell(excel_r, 25, f'=IF(T{excel_r}=0,0,N{excel_r}/T{excel_r})')
    wu.cell(excel_r, 26, f'=IF(T{excel_r}=0,0,P{excel_r}/T{excel_r})')
    wu.cell(excel_r, 27, f'=IF(T{excel_r}=0,0,Q{excel_r}/T{excel_r})')
    wu.cell(excel_r, 28, f'=IF(J{excel_r}=0,0,H{excel_r}/J{excel_r})')
    wu.cell(excel_r, 29, f'=IF(E{excel_r}="MBT",H{excel_r}-MBTTargetCost,"")')
    # CombatIndex heuristic:
    # (HP/10 + DPS_armor*8 + DPS_air*6 + DPS_inf*3 + Range*0.4) / (Cost/1000)
    # * (1+VetDmgBonus*0.3) as a 'potential' bump so knobs matter
    wu.cell(excel_r, 30,
            f'=IF(H{excel_r}=0,0,((J{excel_r}/10)+(Y{excel_r}*3)+(Z{excel_r}*8)+(AA{excel_r}*6)+(S{excel_r}*0.4))/(H{excel_r}/1000)*(1+VetDmgBonus*0.3))')
    for c in range(25, 31):
        wu.cell(excel_r, c).font = font_f
        wu.cell(excel_r, c).alignment = center
        wu.cell(excel_r, c).border = thin
        wu.cell(excel_r, c).fill = alt_fill(excel_r)
        wu.cell(excel_r, c).number_format = "0.00"

last_u = 2 + len(units)

# Shahed HP should follow SwarmHP knob — overwrite IR-15 HP as formula
for r_i, row in enumerate(units):
    if row[0] == "IR-15":
        excel_r = r_i + 3
        wu.cell(excel_r, 10, "=SwarmHP")
        wu.cell(excel_r, 10).font = font_link
        wu.cell(excel_r, 10).fill = PatternFill("solid", fgColor="C6EFCE")

# widths
widths = [10, 12, 10, 28, 14, 16, 8, 10, 9, 8, 12, 8, 8, 10, 11, 11, 10, 10, 8, 8, 36, 22, 18, 28, 10, 11, 10, 12, 14, 12]
for i, w in enumerate(widths, 1):
    wu.column_dimensions[get_column_letter(i)].width = w
wu.row_dimensions[1].height = 20
wu.row_dimensions[2].height = 28

# data validations
dv_fac = DataValidation(type="list", formula1='"Egypt,Saudi,UAE,Algeria,Turkey,Israel,India,Pakistan,Iran"', allow_blank=False)
dv_wave = DataValidation(type="list", formula1='"WAVE0,WAVE1,WAVE2,WAVE3"', allow_blank=False)
dv_domain = DataValidation(type="list", formula1='"Land,Air,Sea"', allow_blank=False)
dv_armor = DataValidation(type="list", formula1='"Soft,Light,Medium,Heavy,Air,Naval"', allow_blank=False)
dv_class = DataValidation(
    type="list",
    formula1='"Infantry,AT infantry,AA infantry,SF,Engineer,APC,IFV,Light vehicle,Light tank,MBT,Tank escort,SPG,MLRS,Missile,Mobile AA,Attack helo,Transport helo,Fighter,Strike jet,UAV,Naval"',
    allow_blank=False,
)
for dv, col in ((dv_fac, "B"), (dv_wave, "C"), (dv_class, "E"), (dv_domain, "G"), (dv_armor, "K")):
    dv.add(f"{col}3:{col}{last_u}")
    wu.add_data_validation(dv)

wu.conditional_formatting.add(f"AD3:AD{last_u}", ColorScaleRule(start_type="min", start_color="F4F1EA", mid_type="percentile", mid_value=50, mid_color="A5D6A7", end_type="max", end_color="1B5E20"))
wu.conditional_formatting.add(f"C3:C{last_u}", FormulaRule(formula=['$C3="WAVE0"'], fill=PatternFill("solid", fgColor="FFE082")))

# ============================================================
# SHEET: STRUCTURES
# ============================================================
wsb = wb.create_sheet("03_STRUCTURES")
wsb.sheet_properties.tabColor = "6D4C41"
wsb.freeze_panes = "A3"
wsb.page_setup.orientation = "landscape"
wsb.page_setup.fitToPage = True
wsb.page_setup.fitToWidth = 1
wsb.page_setup.fitToHeight = 1
wsb.page_setup.paperSize = wsb.PAPERSIZE_A4

wsb.merge_cells("A1:L1")
wsb["A1"] = "STRUCTURES  —  shared skeleton + faction-flavoured defences / superweapons"
wsb["A1"].font = font_h
wsb["A1"].fill = fill_header
wsb["A1"].alignment = center

s_headers = ["ID", "Faction", "Name", "Type", "Cost_cr", "Build_s", "HP", "Power_use", "Power_out", "Unlocks", "Notes", "Cost_per_HP"]
for i, h in enumerate(s_headers, 1):
    c = wsb.cell(2, i, h)
    c.font = font_th
    c.fill = fill_sect
    c.alignment = center
    c.border = thin

structures = [
    ("SH-01", "All", "MCV / Construction Yard", "Core", 3500, 0, 2500, 0, 50, "Everything", "Unpacks from MCV. Pack once.", None),
    ("SH-02", "All", "Power Plant", "Eco", 800, 8, 600, 0, 100, "Power", "Output from PowerPlantOutput knob via formula", None),
    ("SH-03", "All", "Oil Depot", "Eco", 600, 8, 500, 10, 0, "Harvester drop-off", "Needs a field", None),
    ("SH-04", "All", "Barracks", "Prod", 500, 8, 700, 15, 0, "Infantry / SF / engineer", "", None),
    ("SH-05", "All", "War Factory", "Prod", 2000, 14, 1200, 25, 0, "Vehicles", "", None),
    ("SH-06", "All", "Airfield / Helipad", "Prod", 1800, 14, 1000, 30, 0, "Air / helo / UAV", "Iran Workshop is separate", None),
    ("SH-07", "All", "Naval Yard", "Prod", 1800, 14, 1100, 25, 0, "Ships / subs", "Water maps only", None),
    ("SH-08", "All", "Command / Tech", "Tech", 1500, 16, 800, 30, 0, "Tier 2–3 units", "", None),
    ("SH-09", "All", "HMG nest / bunker", "Def", 400, 8, 500, 5, 0, "Anti-infantry", "", None),
    ("SH-10", "All", "ATGM tower", "Def", 700, 10, 450, 8, 0, "Anti-tank", "", None),
    ("SH-11", "All", "AA gun", "Def", 600, 10, 400, 8, 0, "Helo / drone", "", None),
    ("SH-12", "Egypt", "Sa'ka Tent", "Unique", 1200, 14, 600, 15, 0, "Hero + insertion ability", "90s insertion CD", None),
    ("SH-13", "Egypt", "October Battery", "SW", 5000, 45, 1500, 50, 0, "October Strike", "Interceptable by high SAM", None),
    ("SH-14", "Saudi", "Patriot battery", "Def", 2200, 20, 700, 35, 0, "Mid-high AA", "InterceptPatriot knob", None),
    ("SH-15", "Saudi", "Green Crescent", "SW", 5200, 45, 1500, 50, 0, "Stand-off strike", "", None),
    ("SH-16", "UAE", "THAAD / Patriot node", "Def", 2400, 22, 700, 35, 0, "ABM flavour", "Can eat inbound SW late", None),
    ("SH-17", "UAE", "Desert Falcon", "SW", 5000, 45, 1400, 50, 0, "HIMARS + F-16 package", "Small radius, building-delete", None),
    ("SH-18", "Algeria", "S-300 / S-400 battery", "Def", 2600, 24, 800, 40, 0, "Strategic SAM", "InterceptS400 knob. Identity.", None),
    ("SH-19", "Algeria", "Hellwind", "SW", 4800, 40, 1400, 45, 0, "TOS + Smerch saturation", "Infantry delete, tanks hurt", None),
    ("SH-20", "Turkey", "Hisar site", "Def", 1600, 16, 600, 25, 0, "Mid SAM", "", None),
    ("SH-21", "Turkey", "Siper battery", "Def", 2300, 22, 750, 35, 0, "Long SAM", "InterceptSiper knob", None),
    ("SH-22", "Turkey", "Tayfun Rain", "SW", 4800, 42, 1400, 45, 0, "SRBM + Kızılelma late", "", None),
    ("SH-23", "Israel", "Iron Dome battery", "Def", 2000, 18, 650, 30, 0, "Rocket / cruise eat", "InterceptDome knob + Tamir bill", None),
    ("SH-24", "Israel", "David's Sling", "Def", 2400, 22, 700, 35, 0, "Mid-high / ABM flavour", "", None),
    ("SH-25", "Israel", "Arrow node", "Def", 2800, 26, 750, 40, 0, "SW hunter", "Late", None),
    ("SH-26", "Israel", "Adir Package", "SW", 5400, 48, 1500, 55, 0, "F-35I + F-15I bunker delete", "Small radius", None),
    ("SH-27", "India", "Akash / QRSAM site", "Def", 1500, 16, 600, 25, 0, "Mid SAM", "", None),
    ("SH-28", "India", "S-400 battery", "Def", 2600, 24, 800, 40, 0, "Strategic SAM", "InterceptS400 knob", None),
    ("SH-29", "India", "Cruise Battery", "Unique", 2000, 20, 600, 25, 0, "BrahMos Lane", "Skill-shot corridor", None),
    ("SH-30", "India", "Trishul", "SW", 5200, 46, 1500, 50, 0, "BrahMos + Su-30 package", "", None),
    ("SH-31", "Pakistan", "HQ-9 / HQ-16 site", "Def", 2000, 20, 700, 30, 0, "Layered AA", "", None),
    ("SH-32", "Pakistan", "Ghaznavi Rain", "SW", 4800, 42, 1400, 45, 0, "SRBM + Babur mix", "", None),
    ("SH-33", "Iran", "Drone Workshop", "Unique", 900, 10, 550, 20, 0, "Shahed-136 production", "Killing this matters more than one drone", None),
    ("SH-34", "Iran", "Bavar-373 battery", "Def", 2100, 20, 700, 35, 0, "Long SAM", "InterceptBavar knob", None),
    ("SH-35", "Iran", "Raad-e Fath", "SW", 4500, 38, 1300, 40, 0, "Fateh + Shahed saturation", "Cheapest SW, most interceptable", None),
]

for r_i, row in enumerate(structures):
    excel_r = r_i + 3
    for c_i, val in enumerate(row[:11], 1):
        cell = wsb.cell(excel_r, c_i, val)
        cell.font = font_in if c_i in (5, 6, 7, 8, 9) else font_body
        cell.alignment = center if c_i not in (3, 10, 11) else left
        cell.border = thin
        cell.fill = fill_input if c_i in (5, 6, 7, 8, 9) else alt_fill(excel_r)
        if c_i in (5, 6, 7, 8, 9) and isinstance(val, int):
            cell.number_format = "#,##0"
    # Power plant output linked to knob
    if row[0] == "SH-02":
        wsb.cell(excel_r, 9, "=PowerPlantOutput")
        wsb.cell(excel_r, 9).font = font_link
        wsb.cell(excel_r, 9).fill = PatternFill("solid", fgColor="C6EFCE")
    wsb.cell(excel_r, 12, f"=IF(G{excel_r}=0,0,E{excel_r}/G{excel_r})")
    wsb.cell(excel_r, 12).font = font_f
    wsb.cell(excel_r, 12).number_format = "0.00"
    wsb.cell(excel_r, 12).alignment = center
    wsb.cell(excel_r, 12).border = thin
    wsb.cell(excel_r, 12).fill = alt_fill(excel_r)
    fac = row[1]
    wsb.cell(excel_r, 2).font = Font(name="Calibri", size=10, bold=True, color=FACTION_COLOR.get(fac, "000000"))

last_s = 2 + len(structures)
wsb.auto_filter.ref = f"A2:L{last_s}"
for i, w in enumerate([10, 12, 28, 10, 10, 10, 8, 12, 12, 28, 36, 12], 1):
    wsb.column_dimensions[get_column_letter(i)].width = w
wsb.row_dimensions[1].height = 20
wsb.row_dimensions[2].height = 22

# ============================================================
# SHEET: COUNTERS
# ============================================================
wc = wb.create_sheet("04_COUNTERS")
wc.sheet_properties.tabColor = "7A2E0E"
wc.freeze_panes = "B3"
wc.page_setup.orientation = "landscape"
wc.page_setup.fitToPage = True
wc.page_setup.fitToWidth = 1
wc.page_setup.fitToHeight = 1
wc.page_setup.paperSize = wc.PAPERSIZE_A4

wc.merge_cells("A1:L1")
wc["A1"] = "CLASS vs CLASS  —  expected damage multiplier (1.00 = neutral). Yellow = edit. Used as a design reminder, not auto-applied to DPS."
wc["A1"].font = font_h
wc["A1"].fill = fill_header
wc["A1"].alignment = center

classes = ["Infantry", "AT inf", "AA inf", "IFV", "MBT", "SPG/MLRS", "Helo", "Fighter", "UAV", "SAM", "Naval"]
wc["A2"] = "Attacker \\ Target"
wc["A2"].font = font_th
wc["A2"].fill = fill_sect
wc["A2"].alignment = center
for i, cl in enumerate(classes, 2):
    c = wc.cell(2, i, cl)
    c.font = font_th
    c.fill = fill_sect
    c.alignment = center
    c.border = thin
for i, cl in enumerate(classes, 3):
    c = wc.cell(i, 1, cl)
    c.font = font_th
    c.fill = fill_sect
    c.alignment = center
    c.border = thin

# matrix values (attacker row, target col) — designer starting point
# order: Inf, AT, AA, IFV, MBT, Arty, Helo, Ftr, UAV, SAM, Nav
matrix = [
    [1.00, 1.10, 1.10, 0.45, 0.20, 0.50, 0.10, 0.05, 0.15, 0.40, 0.10],  # Inf
    [0.40, 0.50, 0.50, 1.10, 1.80, 0.70, 0.15, 0.05, 0.10, 0.60, 0.20],  # AT
    [0.30, 0.30, 0.30, 0.20, 0.10, 0.20, 1.60, 1.10, 1.40, 0.20, 0.40],  # AA
    [1.50, 1.20, 1.20, 0.80, 0.45, 0.80, 0.25, 0.05, 0.20, 0.70, 0.20],  # IFV
    [1.30, 0.90, 0.90, 1.20, 1.00, 1.10, 0.20, 0.05, 0.15, 1.00, 0.30],  # MBT
    [1.40, 1.50, 1.50, 1.10, 0.70, 0.80, 0.20, 0.05, 0.15, 1.30, 0.50],  # Arty  — vs bldg handled by knob
    [0.80, 1.20, 1.00, 1.10, 1.35, 1.40, 0.40, 0.15, 0.50, 0.90, 0.70],  # Helo
    [0.50, 0.60, 0.50, 0.70, 0.80, 1.20, 1.50, 1.00, 1.60, 0.70, 1.10],  # Fighter
    [0.40, 0.50, 0.40, 0.60, 0.70, 0.80, 0.20, 0.10, 0.30, 0.50, 0.50],  # UAV
    [0.10, 0.10, 0.10, 0.15, 0.10, 0.15, 1.70, 1.40, 1.80, 0.20, 0.80],  # SAM
    [0.40, 0.40, 0.40, 0.50, 0.40, 0.60, 0.50, 0.40, 0.40, 0.50, 1.00],  # Naval
]

for r, row in enumerate(matrix):
    for c, val in enumerate(row):
        cell = wc.cell(r + 3, c + 2, val)
        cell.font = font_in
        cell.fill = fill_input
        cell.alignment = center
        cell.border = thin
        cell.number_format = "0.00"

wc.conditional_formatting.add("B3:L13", ColorScaleRule(start_type="num", start_value=0.05, start_color="FFCDD2", mid_type="num", mid_value=1.0, mid_color="FFF9C4", end_type="num", end_value=1.8, end_color="A5D6A7"))

wc.merge_cells("A15:L15")
wc["A15"] = "Read: attacker on the LEFT, target on the TOP. 1.80 AT-vs-MBT is the ATGMVsArmor idea. If you change ATGMVsArmor on Assumptions, also retune C5 (AT vs MBT) so the two documents do not argue."
wc["A15"].font = font_note

wc.merge_cells("A17:C17")
wc["A17"] = "Linked knobs (reference only)"
wc["A17"].font = Font(name="Calibri", size=11, bold=True, color=NAVY)
wc["A18"] = "ATGM vs armour knob"
wc["B18"] = "=ATGMVsArmor"
wc["B18"].font = font_link
wc["B18"].number_format = "0.00"
wc["A19"] = "Air vs armour knob"
wc["B19"] = "=AirVsArmor"
wc["B19"].font = font_link
wc["B19"].number_format = "0.00"
wc["A20"] = "Arty vs building knob"
wc["B20"] = "=ArtyVsBuilding"
wc["B20"].font = font_link
wc["B20"].number_format = "0.00"

wc.column_dimensions["A"].width = 28
for i in range(2, 13):
    wc.column_dimensions[get_column_letter(i)].width = 12
wc.row_dimensions[1].height = 22
wc.row_dimensions[2].height = 22

# ============================================================
# SHEET: FACTION COMPARE
# ============================================================
wf = wb.create_sheet("05_FACTION_COMPARE")
wf.sheet_properties.tabColor = "1565C0"
wf.freeze_panes = "A3"
wf.page_setup.orientation = "landscape"
wf.page_setup.fitToPage = True
wf.page_setup.fitToWidth = 1
wf.page_setup.fitToHeight = 1
wf.page_setup.paperSize = wf.PAPERSIZE_A4

wf.merge_cells("A1:K1")
wf["A1"] = "FACTION ROLL-UP  —  all green numbers are formulas off 02_UNITS. If a column looks wrong, the roster is wrong."
wf["A1"].font = font_h
wf["A1"].fill = fill_header
wf["A1"].alignment = center

f_headers = ["Faction", "Wave in", "Unit count", "Avg Cost", "Avg HP", "Avg DPS_Armor", "Avg DPS_Air", "Avg CombatIndex", "Identity read", "MBT cost (min)", "Fighter cost (min)"]
for i, h in enumerate(f_headers, 1):
    c = wf.cell(2, i, h)
    c.font = font_th
    c.fill = fill_sect
    c.alignment = center
    c.border = thin

factions = ["Egypt", "Saudi", "UAE", "Algeria", "Turkey", "Israel", "India", "Pakistan", "Iran"]
for i, fac in enumerate(factions):
    r = i + 3
    fac_rows = [u for u in units if u[1] == fac]
    mbt_costs = [u[7] for u in fac_rows if u[4] == "MBT"]
    ftr_costs = [u[7] for u in fac_rows if u[4] == "Fighter"]
    wf.cell(r, 1, fac).font = Font(name="Calibri", size=11, bold=True, color=FACTION_COLOR[fac])
    wf.cell(r, 2, f'=IF(COUNTIFS(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$C$3:$C${last_u},"WAVE0")>0,"WAVE0+",IF(COUNTIFS(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$C$3:$C${last_u},"WAVE1")>0,"WAVE1",IF(COUNTIFS(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$C$3:$C${last_u},"WAVE2")>0,"WAVE2","WAVE3")))')
    wf.cell(r, 3, f'=COUNTIF(02_UNITS!$B$3:$B${last_u},A{r})')
    wf.cell(r, 4, f'=AVERAGEIF(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$H$3:$H${last_u})')
    wf.cell(r, 5, f'=AVERAGEIF(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$J$3:$J${last_u})')
    wf.cell(r, 6, f'=AVERAGEIF(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$Z$3:$Z${last_u})')
    wf.cell(r, 7, f'=AVERAGEIF(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$AA$3:$AA${last_u})')
    wf.cell(r, 8, f'=AVERAGEIF(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$AD$3:$AD${last_u})')
    identity = {
        "Egypt": "Depth / mix",
        "Saudi": "Altitude / quality",
        "UAE": "Scalpel / precision",
        "Algeria": "Weight / bubble",
        "Turkey": "Drone mesh",
        "Israel": "Shield + knife",
        "India": "Scale + BrahMos",
        "Pakistan": "First strike",
        "Iran": "Swarm + rain",
    }
    wf.cell(r, 9, identity[fac])
    wf.cell(r, 10, min(mbt_costs) if mbt_costs else None)
    wf.cell(r, 11, min(ftr_costs) if ftr_costs else None)
    for c in range(1, 12):
        wf.cell(r, c).alignment = center
        wf.cell(r, c).border = thin
        wf.cell(r, c).fill = alt_fill(r)
        if c >= 2:
            wf.cell(r, c).font = font_link
        if c in (4, 5, 10, 11):
            wf.cell(r, c).number_format = "#,##0.0"
        if c in (6, 7, 8):
            wf.cell(r, c).number_format = "0.00"
    wf.cell(r, 10).font = Font(name="Calibri", size=10, color="000000")
    wf.cell(r, 11).font = Font(name="Calibri", size=10, color="000000")

# array formulas need Ctrl-Shift for UNIQUE/IF in some Excels — INDEX/MATCH with MAXIFS is fine.
# TEXTJOIN+UNIQUE+IF is dynamic array (Excel 365). LibreOffice may not like it.
# Safer wave column:
for i, fac in enumerate(factions):
    r = i + 3
    wf.cell(r, 2, f'=IF(COUNTIFS(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$C$3:$C${last_u},\"WAVE0\")>0,\"WAVE0+\",IF(COUNTIFS(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$C$3:$C${last_u},\"WAVE1\")>0,\"WAVE1\",IF(COUNTIFS(02_UNITS!$B$3:$B${last_u},A{r},02_UNITS!$C$3:$C${last_u},\"WAVE2\")>0,\"WAVE2\",\"WAVE3\")))')

wf.conditional_formatting.add("H3:H11", ColorScaleRule(start_type="min", start_color="FFCDD2", mid_type="percentile", mid_value=50, mid_color="FFF9C4", end_type="max", end_color="A5D6A7"))

# intercept cheat-sheet
wf.merge_cells("A13:K13")
wf["A13"] = "SUPERWEAPON INTERCEPT CHEAT-SHEET (from Assumptions knobs)"
wf["A13"].font = font_h
wf["A13"].fill = fill_sect
wf["A13"].alignment = center

int_headers = ["Umbrella", "Knob", "Chance", "Who has it", "Beats rain from", "Loses rain to"]
for i, h in enumerate(int_headers, 1):
    c = wf.cell(14, i, h)
    c.font = font_th
    c.fill = fill_header
    c.alignment = center
    c.border = thin

umb = [
    ("Iron Dome / Arrow layer", "=InterceptDome", "Israel", "Iran swarm, Pakistan Babur, Grad-like", "BrahMos skill-shot if corridor unseen; F-35 package"),
    ("S-400", "=InterceptS400", "Algeria, India", "Most cruise / lofted ballistic / jets", "F-35 cloak strike; saturation if batteries dead"),
    ("Patriot", "=InterceptPatriot", "Saudi (+ UAE node)", "Cruise / jet", "Saturation + low drones"),
    ("Siper", "=InterceptSiper", "Turkey", "Cruise / jet", "Swarm + lofted mass"),
    ("Bavar-373", "=InterceptBavar", "Iran", "Casual air", "F-35 / F-15SA / Rafale SEAD"),
]
for i, (name, knob, who, beats, loses) in enumerate(umb):
    r = 15 + i
    wf.cell(r, 1, name).font = font_body
    wf.cell(r, 2, knob.split("=")[1] if False else knob.replace("=", ""))
    wf.cell(r, 2, knob[1:] if knob.startswith("=") else knob)
    wf.cell(r, 3, knob)
    wf.cell(r, 3).font = font_link
    wf.cell(r, 3).number_format = "0%"
    wf.cell(r, 4, who)
    wf.cell(r, 5, beats)
    wf.cell(r, 6, loses)
    for c in range(1, 7):
        wf.cell(r, c).border = thin
        wf.cell(r, c).alignment = left if c >= 4 else center
        wf.cell(r, c).fill = alt_fill(r)
        wf.cell(r, c).font = font_link if c == 3 else font_body

# bar chart of avg combat index
chart = BarChart()
chart.type = "col"
chart.title = "Avg CombatIndex by faction (heuristic)"
chart.y_axis.title = "CombatIndex"
chart.x_axis.title = None
data = Reference(wf, min_col=8, min_row=2, max_row=11)
cats = Reference(wf, min_col=1, min_row=3, max_row=11)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.shape = 4
chart.style = 10
chart.legend = None
chart.y_axis.numFmt = "0.0"
chart.width = 18
chart.height = 8
wf.add_chart(chart, "A22")

for i, w in enumerate([22, 12, 12, 12, 12, 14, 12, 16, 28, 14, 16], 1):
    wf.column_dimensions[get_column_letter(i)].width = w
wf.row_dimensions[1].height = 20

# ============================================================
# SHEET: WAVE PLAN
# ============================================================
ww = wb.create_sheet("06_WAVE_PLAN")
ww.sheet_properties.tabColor = "E65100"
ww.sheet_view.showGridLines = False
ww.page_setup.orientation = "landscape"
ww.page_setup.fitToPage = True
ww.page_setup.fitToWidth = 1
ww.page_setup.fitToHeight = 1
ww.page_setup.paperSize = ww.PAPERSIZE_A4

ww.merge_cells("A1:F1")
ww["A1"] = "SHIP WAVES  —  art and Uncut VO trail the greybox. Slice before spectacle."
ww["A1"].font = font_h
ww["A1"].fill = fill_header
ww["A1"].alignment = center

wh = ["Wave", "Factions", "Must-fun test", "Do not start", "Exit criteria", "GDD ref"]
for i, h in enumerate(wh, 1):
    c = ww.cell(2, i, h)
    c.font = font_th
    c.fill = fill_sect
    c.alignment = center
    c.border = thin

waves = [
    ("WAVE0 Slice", "Egypt vs Algeria", "15-min 1v1. Kornet vs T-90. TOS vs garrison. Su-30 vs F-16. One SAM each.", "F-35 model, campaign cinematics, Uncut Hebrew", "A new player understands counters in one match. Nobody says 'I don't know why I died'.", "GDD v0.1 §12"),
    ("WAVE1 Arab core", "+ Saudi + UAE", "F-15SA vs Su-30. HIMARS vs Conyard. Bradley vs BMP. Patriot vs October Strike.", "India/Pakistan maps, carrier unit", "Four-faction custom lobby is stable. 2v2 does not desync.", "GDD v0.1 §4 + §12"),
    ("WAVE2 Near", "+ Turkey + Iran", "TB2 mesh vs Shahed swarm. Korkut vs Workshop. Fateh pack-up vs Siper. Altay vs Karrar.", "F-35I cloak polish, Vikrant", "Drone weather is readable. Swarm is annoying, not unplayable.", "GDD v0.2 §1 + §5"),
    ("WAVE3 Wider", "+ Israel + India + Pakistan", "Iron Dome bill vs Fateh rain. BrahMos lane vs Babur window. Trophy vs Kornet. F-35I vs S-400.", "New factions beyond these nine", "Ladder is not 70/30 on any flag matchup after a week.", "GDD v0.2 §2–4"),
]
for r_i, row in enumerate(waves):
    excel_r = r_i + 3
    for c_i, val in enumerate(row, 1):
        cell = ww.cell(excel_r, c_i, val)
        cell.font = font_body
        cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        cell.border = thin
        cell.fill = alt_fill(excel_r)
    ww.row_dimensions[excel_r].height = 48

ww.merge_cells("A8:F8")
ww["A8"] = "Greybox all nine the day WAVE0 is fun. A grey JF-17 is more useful than a beautiful unused Rafale."
ww["A8"].font = font_note

for i, w in enumerate([16, 22, 40, 28, 36, 18], 1):
    ww.column_dimensions[get_column_letter(i)].width = w
ww.row_dimensions[1].height = 20
ww.row_dimensions[2].height = 22

# ============================================================
# SHEET: CHANGELOG
# ============================================================
wl = wb.create_sheet("07_CHANGELOG")
wl.sheet_properties.tabColor = "616161"
wl.freeze_panes = "A2"
wl.page_setup.orientation = "landscape"
wl.page_setup.fitToPage = True
wl.page_setup.fitToWidth = 1
wl.page_setup.fitToHeight = 1
wl.page_setup.paperSize = wl.PAPERSIZE_A4

ch = ["Date", "Author", "ID / Knob", "Old", "New", "Why (one line)", "Playtest note"]
for i, h in enumerate(ch, 1):
    c = wl.cell(1, i, h)
    c.font = font_th
    c.fill = fill_header
    c.alignment = center
    c.border = thin

wl["A2"] = "2026-08-29"
wl["B2"] = "Design"
wl["C2"] = "FILE CREATED"
wl["D2"] = "—"
wl["E2"] = "v0.2.0"
wl["F2"] = "First pass from GDD v0.1 + v0.2 addendum"
wl["G2"] = "Not playtested. WAVE0 numbers are the only ones allowed to be taken seriously."
for c in range(1, 8):
    wl.cell(2, c).font = font_body
    wl.cell(2, c).border = thin
    wl.cell(2, c).fill = fill_cream
    wl.cell(2, c).alignment = left

for r in range(3, 32):
    for c in range(1, 8):
        wl.cell(r, c).border = thin
        wl.cell(r, c).fill = fill_input if c in (4, 5) else fill_white
        wl.cell(r, c).font = font_in if c in (4, 5) else font_body

for i, w in enumerate([14, 14, 18, 12, 12, 42, 42], 1):
    wl.column_dimensions[get_column_letter(i)].width = w

wl.merge_cells("A34:G34")
wl["A34"] = "Rule: if you change a WAVE0 cost by more than 10%, write it here the same hour. Future-you is the player who will be angry."
wl["A34"].font = font_note

# print settings all sheets
for s in wb.worksheets:
    s.page_setup.orientation = "landscape"
    s.page_setup.fitToPage = True
    s.page_setup.fitToWidth = 1
    s.page_setup.fitToHeight = 0 if s.title in ("02_UNITS", "00_README") else 1
    s.page_setup.paperSize = s.PAPERSIZE_A4
    s.sheet_properties.pageSetUpPr.fitToPage = True
    s.page_margins.left = 0.4
    s.page_margins.right = 0.4
    s.page_margins.top = 0.5
    s.page_margins.bottom = 0.5
    s.oddHeader.left.text = "ASH-SHARQ  ·  Stat Sheet v0.2"
    s.oddFooter.right.text = "Confidential  ·  Page &P / &N"

out = "/home/workdir/artifacts/ASH-SHARQ_Nine_Faction_Stat_Sheet_v0.2.xlsx"
wb.save(out)
print("Wrote", out, "units", len(units), "structures", len(structures))

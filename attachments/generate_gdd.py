#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate ASH-SHARQ Desert Command Game Design Document."""

from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor, Emu
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml.ns import qn, nsmap
from docx.oxml import OxmlElement
from datetime import date

doc = Document()

# ---------- helpers ----------
def set_run_font(run, name="Calibri", size=11, bold=False, italic=False, color=None):
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    if color:
        run.font.color.rgb = RGBColor(*color)

def add_heading_styled(text, level=1):
    p = doc.add_heading(text, level=level)
    for run in p.runs:
        run.font.color.rgb = RGBColor(0x1A, 0x3A, 0x2A) if level == 1 else RGBColor(0x2C, 0x5F, 0x4A)
    return p

def body(text, size=11, bold=False, italic=False, space_after=8):
    p = doc.add_paragraph()
    run = p.add_run(text)
    set_run_font(run, size=size, bold=bold, italic=italic)
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.line_spacing = 1.15
    return p

def bullet(text, level=0):
    p = doc.add_paragraph(text, style="List Bullet")
    p.paragraph_format.left_indent = Inches(0.25 + level * 0.25)
    for run in p.runs:
        set_run_font(run, size=11)
    return p

def note(text):
    p = doc.add_paragraph()
    run = p.add_run("NOTE: ")
    set_run_font(run, size=10, bold=True, italic=True, color=(0x6B, 0x3A, 0x1A))
    run2 = p.add_run(text)
    set_run_font(run2, size=10, italic=True, color=(0x44, 0x44, 0x44))
    p.paragraph_format.space_after = Pt(10)
    return p

def quote_line(ar, en, tag=""):
    p = doc.add_paragraph()
    if tag:
        t = p.add_run(f"[{tag}]  ")
        set_run_font(t, size=10, bold=True, color=(0x7A, 0x2E, 0x0E))
    a = p.add_run(ar)
    set_run_font(a, name="Arial", size=12, bold=True)
    e = p.add_run(f"   —  {en}")
    set_run_font(e, size=10, italic=True, color=(0x55, 0x55, 0x55))
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.left_indent = Inches(0.2)
    return p

def shade_cell(cell, hex_color):
    tc = cell._tePr if hasattr(cell, "_tePr") else cell._tc
    tcPr = tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), hex_color)
    shd.set(qn("w:val"), "clear")
    tcPr.append(shd)

def set_cell_text(cell, text, bold=False, size=10, color=None, fill=None):
    cell.text = ""
    p = cell.paragraphs[0]
    run = p.add_run(text)
    set_run_font(run, size=size, bold=bold, color=color)
    if fill:
        shade_cell(cell, fill)
    cell.vertical_alignment = 1

def add_table(headers, rows, col_widths=None, header_fill="1A3A2A"):
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, h in enumerate(headers):
        cell = table.rows[0].cells[i]
        set_cell_text(cell, h, bold=True, size=10, color=(255, 255, 255), fill=header_fill)
    for r_i, row in enumerate(rows):
        for c_i, val in enumerate(row):
            fill = "F4F1EA" if r_i % 2 == 0 else "FFFFFF"
            set_cell_text(table.rows[r_i + 1].cells[c_i], str(val), size=9, fill=fill)
    if col_widths:
        for row in table.rows:
            for idx, w in enumerate(col_widths):
                row.cells[idx].width = Inches(w)
    doc.add_paragraph()
    return table

# Page setup
for section in doc.sections:
    section.top_margin = Cm(1.8)
    section.bottom_margin = Cm(1.8)
    section.left_margin = Cm(2.0)
    section.right_margin = Cm(2.0)
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("ASH-SHARQ: Desert Command  ·  Game Design Document v0.1  ·  Confidential  ·  Page ")
    set_run_font(r, size=8, color=(0x66, 0x66, 0x66))
    # page number field
    fld = OxmlElement("w:fldChar")
    fld.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    fld2 = OxmlElement("w:fldChar")
    fld2.set(qn("w:fldCharType"), "end")
    r2 = p.add_run()
    r2._r.append(fld)
    r2._r.append(instr)
    r2._r.append(fld2)
    set_run_font(r2, size=8, color=(0x66, 0x66, 0x66))

# ===================== TITLE =====================
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("WORKING TITLE")
set_run_font(r, size=11, bold=True, color=(0x7A, 0x2E, 0x0E))

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("ASH-SHARQ")
set_run_font(r, size=36, bold=True, color=(0x1A, 0x3A, 0x2A))

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("الشرق")
set_run_font(r, name="Arial", size=28, bold=True, color=(0x2C, 0x5F, 0x4A))

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("DESERT COMMAND")
set_run_font(r, size=20, bold=True, color=(0x7A, 0x2E, 0x0E))

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("A modern real-time strategy war game in the spirit of Red Alert 3\nArabic armies · published inventories · dialect voice acting · online multiplayer")
set_run_font(r, size=12, italic=True)

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("GAME DESIGN DOCUMENT  ·  v0.1  ·  PLAYABLE PITCH FOR DEVELOPMENT")
set_run_font(r, size=11, bold=True)

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("Prepared for the development team  ·  August 2026\nClassification: Internal / Shareable with contractors under NDA")
set_run_font(r, size=10, color=(0x55, 0x55, 0x55))

body("This document is the starting bible. It is written so a small studio or contractor team can open it and begin pre-production: art bible, unit list, economy, modes, campaign beats, and a voice-acting slang pack including adult (18+) military profanity per dialect. Numbers are stylized for game balance, then anchored to publicly reported inventories so each army feels like itself.")

# ===================== 1 VISION =====================
add_heading_styled("1. Vision & Elevator Pitch", 1)

body("Elevator pitch (one sentence): Command an Arab army whose tanks, jets, and curses are the ones that army actually fields — fight the AI or other players across desert, city, and coast in a colorful early-2000s 3D RTS that plays like Red Alert 3 with tighter cameras, better lighting, and a fully Arabic soul.")

body("What the player feels after 20 minutes: I am not commanding generic ‘Middle East faction #3’. I am Egypt with Abrams and Rafales and Sa‘ka, or Saudi with F-15s and Patriots, or UAE with Leclercs and HIMARS, or Algeria with T-90s and S-400s. When a conscript screams at a burning BMP, he screams in his dialect, and he does not sound like a documentary narrator.")

add_heading_styled("1.1 Design pillars", 2)
bullet("Identity first. Every faction is a real Arab armed force, compressed into a fun RTS kit. Equipment lists start from open-source inventories (IISS-style / public reporting), then get game-balanced.")
bullet("RA3 energy, not milsim. Units are readable silhouettes. Abilities are flashy. Superweapons exist. Humour and swagger live in the voice lines. Combat is still deadly.")
bullet("Dialect is a system. Voice packs are not one ‘Arabic’ track. Egypt, Gulf, and Maghreb sound like different countries. Adult language is part of the simulation, toggleable.")
bullet("Play with anyone. Skirmish vs AI, co-op vs AI, 1v1 through 4v4 versus, spectator. Always-online optional; LAN/offline skirmish must work.")
bullet("Readable early-2000s 3D. Think C&C Generals / Red Alert 3 polycounts and colour, with modern PBR-lite lighting, dust, heat haze, and destruction. Not Unreal 5 photoreal. Not voxel. Not 2D.")

add_heading_styled("1.2 What this is not", 2)
bullet("Not a propaganda tool and not a documentary. Campaigns use a fictional 2028–2030 crisis so no living head of state is a character.")
bullet("Not a full flight sim or Steel Battalion. Aircraft are RTS aircraft: short sorties, visible, recallable.")
bullet("Not 12 factions at launch. Four launch armies. More (Jordan, Morocco, Iraq, Qatar…) as DLC / season pass once the loop is fun.")
bullet("Not realistic casualty counts. Units are squads and vehicles, not 440,000-man orders of battle.")

add_heading_styled("1.3 Comparable products", 2)
add_table(
    ["Game", "Steal this", "Do not steal this"],
    [
        ["Red Alert 3 (2008)", "Co-commander energy, dual abilities, colourful factions, naval+land+air on one map, co-op campaign", "Cartoony anime faction, time travel plot, 3-faction lock"],
        ["C&C Generals / ZH (2003)", "Faction fantasy, general powers, salvage/upgrades, desert/urban maps", "GLA terrorism fantasy as a playable ‘Arab’ stand-in"],
        ["Company of Heroes 2", "Cover, suppression, readable infantry", "WW2 setting, no base building"],
        ["Age of Empires IV / SC2", "Ladder clarity, hotkey discipline, spectator", "Fantasy races / protoss"],
        ["WARNO / SD2", "ORBAT flavour", "Hex-level realism, 2-hour matches"],
    ],
)

# ===================== 2 ART TECH =====================
add_heading_styled("2. Art, Camera & Technical Direction", 1)

add_heading_styled("2.1 Visual target", 2)
body("Look target: ‘Red Alert 3 if it shipped in 2012 and had a good lighting artist.’ Units 2–8k triangles. Buildings 3–12k. Maps use large tiled desert/urban kits. Strong colour keys per faction so you never confuse an Egyptian olive drab Abrams with a Saudi desert tan Abrams.")

bullet("Egypt: olive + sand + red-black-white flag trim. Nile green UI.")
bullet("Saudi: desert tan + green flag and gold. Dark green aircraft.")
bullet("UAE: sand + red/black/green/white. Clean EDGE-style grey on elite units.")
bullet("Algeria: green-white-red, Russian green armour, desert camo overlays.")

body("VFX language: dust rooster-tails, heat shimmer, tracer, Kornet/TOW smoke trails, HIMARS arcs, TOS-1 thermobaric bloom (orange-white, short, readable), Patriot/S-300 launch plumes. No grey sludge. Hits must pop.")

add_heading_styled("2.2 Camera & control", 2)
bullet("Classic RTS: free tilt 35–65°, zoom from ‘tabletop army’ to ‘single tank close-up’.")
bullet("WASD + edge pan + minimap jump. Control groups 0–9. Classic C&C sidebar + dual-ability bar on selected unit.")
bullet("Every unit has ONE active ability (or two fire modes). No 8-button hero kits except named heroes.")
bullet("Target platform at launch: PC (Windows). 1080p medium = GTX 1060 / RX 580 class. 1440p high = RTX 3060 class. Later console/cloud is out of scope for v1.")

add_heading_styled("2.3 Suggested stack (for the developer, not locked)", 2)
bullet("Engine: Unreal Engine 5 with Nanite OFF for units (hand-authored LODs) OR Unity HDRP. Prefer Unity if the team is small and 3D RTS tooling already exists. Either works.")
bullet("Netcode: lockstep deterministic for competitive 1v1/2v2; dedicated server + rollback-lite for 3v3/4v4 if lockstep desync risk is high. Spectate from replay file.")
bullet("Voice: full WAV/OGG banks per faction × language pack. English UI default + full Arabic UI. Voice is always native dialect regardless of UI language.")
bullet("Mod hook later: JSON unit stats, not required for v1.")

# ===================== 3 GAMEPLAY =====================
add_heading_styled("3. Core Gameplay Loop", 1)

body("Match length target: 12–25 minutes ladder, 20–40 minutes co-op mission. Best-of style campaign missions 15–30.")

add_heading_styled("3.1 Economy", 2)
bullet("Two resources: CREDITS (harvested from Oil Fields / Supply Docks) and POWER (from plants). A third soft resource: FUEL (affects aircraft sortie time and long-range MLRS; regenerates at depots).")
bullet("Oil Field: captureable map resource. Needs a Harvester / Fuel Truck loop. Destroying an enemy field denies income.")
bullet("Supply Dock / Port: naval maps have tanker berths.")
bullet("No Tiberium. No magic ore crystals. The fantasy is oil, docks, and depots.")
bullet("Saudi unique: ‘Aramco Bonus’ — Oil Fields they own generate +15% credits. UAE unique: ‘Sovereign Fund’ — first 8 minutes +10% build speed on elite buildings. Egypt unique: ‘Strategic Depth’ — Construction Yard rebuilds 20% cheaper once. Algeria unique: ‘State Industry’ — War Factory units 8% cheaper.")

add_heading_styled("3.2 Base building", 2)
body("Classic MCV → Construction Yard. Buildings place in a radius. Pack/unpack MCV allowed once (anti-turtle but not Empire-of-Rising-Sun free build anywhere).")
bullet("Power Plant → Barracks → War Factory → Airfield / Helipad → Naval Yard (water maps) → Tech / Command → Superweapon.")
bullet("Defenses: bunker / HMG nest, ATGM tower, AA gun, SAM battery. Faction-flavoured (see matrices).")
bullet("Walls exist but are expensive. Desert maps reward manoeuvre over fortress.")

add_heading_styled("3.3 Unit classes (universal taxonomy)", 2)
add_table(
    ["Class", "Role", "Soft counter", "Hard counter"],
    [
        ["Infantry squad", "Buildings, garrisons, cheap screen", "IFV, flamethrower/TOS, artillery", "Tank in open"],
        ["AT infantry", "Tanks", "Artillery, air, sniper", "Light vehicles that close"],
        ["AA infantry / MANPADS", "Helicopters, low jets", "Artillery, tanks", "High-altitude / stealth"],
        ["IFV / APC", "Transport + anti-infantry", "ATGM, tank", "Pure air if no AA"],
        ["MBT", "Frontline", "ATGM, attack helo, air, mines", "Other MBT + air"],
        ["Artillery / SPG", "Buildings, blob", "Air, fast raiders", "Nothing if unspotted"],
        ["MLRS", "Area, buildings", "Air, counter-battery", "Dispersed units"],
        ["Attack helicopter", "Tanks, soft", "MANPADS, SAM, fighters", "Infantry in city if no rockets"],
        ["Fighter", "Air superiority, some strike", "SAM, better fighter", "Ground AA umbrella"],
        ["Naval", "Map control on water maps", "Air, coastal missile", "Other navy"],
        ["Hero / SF", "Raid, pick, story", "Detection + numbers", "Being caught"],
        ["Superweapon", "Tempo reset", "Destroy the structure / intercept", "Being late"],
    ],
)

add_heading_styled("3.4 Veterancy", 2)
body("Three ranks like RA3: Veteran / Elite / Heroic. Damage, then HP, then a small unique perk (e.g. Egyptian Abrams Heroic gets a one-shot canister round). XP from kills and captured buildings.")

add_heading_styled("3.5 Win conditions", 2)
bullet("Standard: destroy Construction Yard + all MCVs, or concession.")
bullet("Campaign: scripted objectives (hold the dam, extract the minister, sink the Mistral, etc.).")
bullet("Optional ‘Sudden Death’ ladder modifier after 20 minutes: only superweapons and air.")

# ===================== 4 FACTIONS =====================
add_heading_styled("4. Launch Factions", 1)
body("Four launch factions. Each has a doctrine sentence, a unique mechanic, a hero, a superweapon, and a kit drawn from published equipment. Quantities in-game are NOT real ORBAT sizes — they are RTS costs.")

add_table(
    ["Faction", "Doctrine", "Feel in one word", "Signature toys"],
    [
        ["Egypt", "Mass + mix. Western tanks, French/Russian jets, Sa‘ka raids, Mistral amphibious punch.", "Depth", "M1A1, Rafale, Ka-52, Mistral, Sa‘ka"],
        ["Saudi Arabia", "Air first, quality armour, money. Patriots and F-15s decide the sky.", "Altitude", "M1A2S, Bradley, F-15SA, Patriot, Apache"],
        ["UAE", "Elite, precise, expensive. Special forces and rockets, not meat waves.", "Scalpel", "Leclerc, Rabdan, HIMARS, F-16 Block 60, Apache"],
        ["Algeria", "Russian heavy metal. T-90 wall, S-400 bubble, TOS-1 and Smerch.", "Weight", "T-90SA, BMP-2, Su-30MKA, S-400, TOS-1A"],
    ],
)

note("Inventories below are DESIGN ANCHORS from open sources (GlobalMilitary, IISS-style reporting, national announcements 2024–2026). They will be wrong in places; that is fine. The rule is: do not give Egypt an F-35 or Algeria an Abrams. Do not invent magic lasers. If we need a unique unit, reskin a real platform (Egyptian ‘Ramses’ upgrade package, UAE EDGE munition, Algerian BMPT).")

# ----- EGYPT -----
add_heading_styled("4.1 Egypt — القوات المسلحة المصرية", 2)
body("Doctrine: The largest conventional Arab army. Mixed logistics is a flavour, not a punishment. Player gets a toolkit that can do everything at ‘good’ rather than one thing at ‘best’. Urban and river maps are their home.")
body("Unique mechanic — SA‘KA INSERTION: once the Special Forces Tent is up, the player can call a helicopter-borne Sa‘ka squad onto any explored ground in a 15-second channel (interruptible). Cooldown 90s. This is Egypt’s raid tool.")
body("Hero — COLONEL TAREK ‘EL-NISR’ FAHMY: Sa‘ka officer. Cloak when still. Can mark a vehicle for +30% damage from all Egyptian AT for 8 seconds. Voice: gravel Cairene, dark humour.")
body("Superweapon — OCTOBER STRIKE: a mixed package (Rafale + F-16 + one ballistic-style conventional strike on a large radius). Long charge. Interceptable by high-tier SAM if the player invested.")
body("Ultimate (late) — MISTRAL OVER THE BEACH: on water-capable maps, a scripted helicopter-carrier arrival that drops two waves of vehicles. On land maps it becomes a heavy airlift of two MBTs + IFVs.")

add_heading_styled("Egypt structures", 3)
add_table(
    ["Structure", "Unlocks / function"],
    [
        ["MCV / Construction Yard", "Base. Packs once."],
        ["Power Plant (gas turbine)", "Power. Can upgrade to combined-cycle."],
        ["Oil Depot", "Accepts harvester drops. Drop-off."],
        ["Barracks", "Infantry + engineer + Sa‘ka."],
        ["War Factory", "Tanks, IFV, SPG, MLRS."],
        ["Air Defense Command", "SAM site + radar. Required for advanced AA."],
        ["Airbase", "Fighters, attack helos, AWACS-lite (vision pulse)."],
        ["Naval Yard", "Type-209 flavour sub (stealth scout + torpedo), FREMM-style frigate, missile boat."],
        ["Sa‘ka Tent", "Hero + insertion ability."],
        ["October Battery (SW)", "Superweapon."],
    ],
)

add_heading_styled("Egypt units (v1 roster — keep tight)", 3)
add_table(
    ["Unit", "Real anchor", "Role / ability"],
    [
        ["Rifle squad (mech infantry)", "Standard EAF infantry", "Garrison. Ability: smoke grenade."],
        ["Kornet team", "9M133 Kornet", "AT. Ability: top-attack mode (slow, high dmg)."],
        ["Igla/Stinger team", "Igla-S / Stinger mix", "MANPADS. Ability: flare decoy (self)."],
        ["Engineer", "—", "Capture / repair. Unarmed."],
        ["Sa‘ka operator", "El-Sa‘ka", "SF. Stealth near rocks/buildings. C4 on buildings."],
        ["YPR-765 / BMP-1", "YPR-765, BMP-1", "IFV. Carries 1 squad. 25mm + ATGM."],
        ["Fahd / BTR", "Fahd APC", "Cheap wheeled transport + HMG."],
        ["M60A3", "M60A3", "Budget tank. Fast to roll. Weak vs modern AT."],
        ["M1A1 SA ‘Ramses’", "M1A1 Abrams locally assembled", "Main tank. Ability: canister / MPAT switch."],
        ["T-90MS (limited)", "Reported T-90MS buys", "Tier-3 tank. Fewer, tougher. Do not spam."],
        ["M109 / K9 Thunder", "M109, K9", "155mm SPG. Ability: shoot-and-scoot."],
        ["BM-21 Grad", "BM-21", "Cheap MLRS. Inaccurate, terrifying vs blobs."],
        ["AH-64D Apache", "Apache", "AT helo. Hellfire. Ability: pop-up from nap-of-earth."],
        ["Ka-52 Alligator", "Ka-52", "Heavier helo. Vikhr. Better vs armour, worse vs MANPADS."],
        ["F-16C", "F-16 backbone", "Multirole. Ability: switch A2A / A2G loadout on airfield."],
        ["Rafale", "Rafale DM/EM", "Premium fighter-bomber. MICA + SCALP-flavour cruise (long CD)."],
        ["MiG-29M", "MiG-29M/M2", "Dogfighter. Cheap air superiority."],
        ["Missile boat", "EAF FAC", "Anti-ship + shore fire."],
        ["FREMM-style frigate", "FREMM / MEKO flavour", "AA umbrella at sea + Exocet."],
        ["Type-209 flavour sub", "Type 209/1400", "Invisible scout on water. Torpedo. Detected by sonar buildings."],
    ],
)

# ----- SAUDI -----
add_heading_styled("4.2 Saudi Arabia — القوات البرية الملكية / RSAF", 2)
body("Doctrine: Pay more, get better. Fewer tanks than Egypt, better air force, layered Patriot/Hawk flavour AA. Economy leans on oil. Open desert maps are their home. They punish players who skip AA.")
body("Unique mechanic — RSAF TASKING: instead of building every aircraft at the airfield, the player spends a ‘sortie point’ (regenerates) to call an F-15 strike or Typhoon CAP from off-map. Visible inbound. Can be intercepted. This keeps the sky feeling like a kingdom-scale air force without parking 20 jets on a pad.")
body("Hero — PRINCE BANDAR CALLSIGN ‘SAQR’: F-15SA ace that can land and become a (vulnerable) ground hero or stay in air. Air mode is a strong fighter. Ground mode is a laser-designator that buffs incoming RSAF strikes.")
body("Superweapon — GREEN CRESCENT: a large Patriot-supported stand-off strike (F-15SA + Storm Shadow-flavour / long-range). Alternative late-game: DF-3 conventional variant as a theatre ballistic that can be shot down by THAAD-equivalent (UAE) or S-400 (Algeria).")

add_heading_styled("Saudi units (v1)", 3)
add_table(
    ["Unit", "Real anchor", "Role / ability"],
    [
        ["National Guard infantry", "SANG flavour", "Better than basic rifle, worse than SF. Ability: mount/dismount technical."],
        ["TOW team", "TOW-2A", "AT. Wire-guided — player can steer for 2 seconds."],
        ["Avenger / MANPADS", "Avenger, Stinger", "Mobile AA humvee."],
        ["M2A2 Bradley", "Bradley", "Best IFV in the game vs infantry + light armour. TOW."],
        ["M113", "M113", "Cheap metal box. Upgrade: extra armour."],
        ["M-ATV", "Oshkosh M-ATV", "Fast desert raid, HMG or ATGM variant."],
        ["M60A3", "M60A3", "Reserve tank."],
        ["M1A2S Abrams", "M1A2S", "Best Western tank in the game. Ability: blow-out panel (survives one pen as ‘crit disabled’ instead of death)."],
        ["CAESAR 155", "CAESAR", "Truck SPG. Fast reposition."],
        ["M109", "M109", "Classic SPG."],
        ["M270 MLRS", "M270", "Precision-ish rockets. Better than Grad, worse area than Smerch."],
        ["AH-64E Apache", "Apache E", "Best AT helo. Ability: Longbow radar reveal in a cone."],
        ["UH-60 Black Hawk", "UH-60", "Transport + door guns."],
        ["F-15SA / F-15EX flavour", "F-15SA, planned EX", "King of the air. Ability: heavy A2G or air superiority."],
        ["Eurofighter Typhoon", "Typhoon", "Agile fighter, weaker payload than F-15."],
        ["Tornado IDS (aging)", "Tornado", "Cheap strike jet. Do not win dogfights."],
        ["E-3 Sentry pulse", "E-3A", "Support power: large reveal + detect stealth for 12s. Not a unit you micro."],
        ["Patriot battery", "PAC-2/PAC-3", "Structure + mobile launcher unit. Best mid-high AA."],
    ],
)

# ----- UAE -----
add_heading_styled("4.3 United Arab Emirates — القوات المسلحة الإماراتية", 2)
body("Doctrine: Small, rich, professional. Every unit costs more and dies less often if microed. Presidential Guard and EDGE munitions are the fantasy. They win by not taking stupid fights and by deleting a Construction Yard with HIMARS before the blob arrives.")
body("Unique mechanic — EDGE NETWORK: elite units (Leclerc, F-16E, HIMARS, SF) share vision when within 18 range of each other. Killing one does not break the rest. Encourages combined-arms packets, not deathballs.")
body("Hero — MAJOR LAYLA AL-MANSOURI ‘WIDGEON’: Presidential Guard operator. Female hero (representation + distinct silhouette). Javelin + short cloak + can call a single precision glide bomb. Voice: calm Gulf Arabic, cuts to sharp when angry.")
body("Superweapon — DESERT FALCON: HIMARS + F-16 Block 60 coordinated strike on a small radius but with building-delete damage. Late: THAAD shot that can intercept enemy superweapons in flight.")

add_heading_styled("UAE units (v1)", 3)
add_table(
    ["Unit", "Real anchor", "Role / ability"],
    [
        ["Presidential Guard squad", "Presidential Guard", "Best infantry. Expensive. Ability: breach charge."],
        ["Javelin team", "FGM-148", "Fire-and-forget AT. Best infantry AT vs tanks."],
        ["Nimr Ajban / Jais", "NIMR family", "Fast desert 4x4. HMG or Kornet."],
        ["BMP-3", "BMP-3", "Heavy IFV. 100mm + 30mm. Scary vs infantry."],
        ["Rabdan 8x8", "Al Jasoor Rabdan", "Modern wheeled IFV. Ability: smoke + dismount."],
        ["Leclerc", "Leclerc (354 in inventory)", "Fast MBT. Best mobility of the four MBTs. Ability: autoloader burst (3 quick shots, then long reload)."],
        ["G6 Rhino", "G6 155", "Wheeled heavy SPG."],
        ["HIMARS", "M142", "Precision MLRS. The UAE identity unit. Ability: ATACMS-flavour long shot (1 rocket, huge range, long CD)."],
        ["K239 Chunmoo (few)", "Chunmoo", "Alternate MLRS, more area."],
        ["AH-64 Apache", "Apache", "AT helo."],
        ["CH-47 Chinook", "Chinook", "Heavy lift. Can carry a vehicle."],
        ["F-16E Block 60", "F-16E/F Desert Falcon", "Best-in-class multirole for the price. Conformal tanks = longer station time."],
        ["Mirage 2000-9", "Mirage 2000-9", "Aging but cheap strike / interceptor."],
        ["Rafale (late unlock)", "80 on order flavour", "Tier-3 jet. Do not give at game start."],
        ["Baynunah-style corvette", "Baynunah", "Navy. Anti-ship + modest AA."],
    ],
)

# ----- ALGERIA -----
add_heading_styled("4.4 Algeria — الجيش الوطني الشعبي", 2)
body("Doctrine: The Russian catalogue with North African terrain sense. Heaviest ground game. Best integrated air defense. Worst early air force until Su-30s are out. Mountain and high-desert maps are their home. They want you to walk into the S-400 bubble.")
body("Unique mechanic — INTEGRATED SKY: SAM units and fighters share a ‘track’ — a jet painted by a Pantsir or S-400 takes +20% incoming missile damage from all Algerian AA for 6 seconds. Rewards AA investment.")
body("Hero — CAPTAIN YOUCEF ‘DJEBEL’ BENALI: mountain commando. Bonus in elevation. Can plant a radio beacon that lets Smerch / TOS fire one shot into fog of war.")
body("Superweapon — HELLWIND: TOS-1A + Smerch combined saturation on a large radius. Buildings burn. Infantry in the zone die. Tanks are damaged and suppressed. Late: Iskander-E flavour ballistic, interceptable.")

add_heading_styled("Algeria units (v1)", 3)
add_table(
    ["Unit", "Real anchor", "Role / ability"],
    [
        ["ANP rifle squad", "ANP infantry", "Cheap, stout. Ability: entrench (immobile, +armor)."],
        ["Kornet / Konkurs team", "Kornet, Konkurs", "AT."],
        ["Igla team", "Igla", "MANPADS."],
        ["BMP-2M Kornet", "BMP-2 with Kornet", "Workhorse IFV."],
        ["Fuchs 2", "TPz Fuchs 2 (local)", "Wheeled APC, mine-resistant flavour."],
        ["T-62 / T-72M", "legacy tanks", "Meat shield tanks. Cheap."],
        ["T-90SA", "T-90SA (~600 reported)", "Main tank. Ability: Shtora dazzler (chance to break ATGM lock)."],
        ["BMPT-72 Terminator", "BMPT reported", "Tank escort. Eats infantry and ATGM teams. The ‘do not blob infantry’ unit."],
        ["2S1 Gvozdika", "2S1", "Light SPG."],
        ["PLZ-45", "PLZ-45", "155mm SPG."],
        ["BM-21 Grad", "Grad", "Cheap MLRS."],
        ["BM-30 Smerch", "Smerch", "Heavy MLRS. Identity unit."],
        ["TOS-1A Solntsepek", "TOS-1A", "Short-range thermobaric. Horror vs garrison and infantry. Weak vs tanks from front."],
        ["Mi-28NE / Mi-24", "Mi-28, Mi-24", "Attack helo. Less precise than Apache, tougher."],
        ["Su-30MKA", "Su-30MKA", "Main fighter-bomber. Ability: long-range R-77 flavour shot."],
        ["MiG-29", "MiG-29", "Cheap fighter."],
        ["Su-24 / Su-34 flavour", "Su-24, reported Su-34", "Strike. Poor dogfight."],
        ["Su-35 / Su-57 late", "reported deliveries", "Tier-3 air. Locked behind late tech. Do not over-fantasy stealth."],
        ["Pantsir-S1", "Pantsir", "Mobile gun+missile AA. Best vs helos and cruise."],
        ["S-300 / S-400 battery", "S-300PMU2, S-400 reported", "Strategic SAM structure + launchers. Defines the faction."],
        ["Kilo-class flavour sub", "Project 636", "Naval. Club-S land-attack one-shot (long CD)."],
    ],
)

# ===================== 5 BALANCE NOTES =====================
add_heading_styled("5. Balance Philosophy (for the designer on the team)", 1)
bullet("Rock-paper-scissors must be teachable in one skirmish: tanks beat infantry in open, ATGM beat tanks if they see them, artillery beats ATGM if they are spotted, air beats artillery if AA is missing, SAM beats air if the bubble is up.")
bullet("Do not make Saudi ‘just better Egypt’. Egypt wins on map control and numbers. Saudi wins on air and quality. UAE wins on timing attacks. Algeria wins on the late wall and the bubble.")
bullet("Naval is a mode, not a requirement. 40% of ladder maps have meaningful water. 60% are land.")
bullet("No nuclear weapons. Conventional only. Superweapons are scary, not campaign-enders unless the opponent ignored them.")
bullet("Women exist in UAE and (optionally) other factions as operators and the UAE hero. Do not make it a lecture. Just cast them.")
bullet("Israel, Iran, USA, Russia, France are NOT playable in v1. They can appear as campaign NPCs / off-map support if a mission needs it, never as a third-team stomper that steals the fantasy.")

# ===================== 6 MODES =====================
add_heading_styled("6. Modes", 1)

add_heading_styled("6.1 Skirmish vs AI", 2)
bullet("Difficulties: Recruit / Officer / Staff / Marshal. Marshal cheats on economy 10% and reacts faster, does not spawn free units.")
bullet("AI personalities per faction: Egypt ‘Front’ (attacks on a broad line), Saudi ‘Sky’ (air + artillery), UAE ‘Raid’ (flank + HIMARS), Algeria ‘Fortress’ (turtle then TOS).")
bullet("Map settings: resources high/med/low, random crates on/off, superweapons on/off, revealed map on/off.")

add_heading_styled("6.2 Co-op vs AI", 2)
bullet("2–4 humans share a side against 2–4 AI. Shared or separate bases (playlist both).")
bullet("Co-op campaign: each story mission supports 2 players with split objectives (one holds the ridge, one hits the port).")
bullet("Friendly fire off by default in co-op, on in versus.")

add_heading_styled("6.3 Versus (online)", 2)
bullet("1v1, 2v2, 3v3, 4v4. Ranked 1v1 and 2v2 only at launch.")
bullet("Unranked custom: pick maps, modifiers (no air, no SW, sudden death, low power).")
bullet("Observers / replay. Chat with mute. Ping system.")
bullet("Anti-cheat: server-authoritative commands + replay hash. Keep it simple in v1.")
bullet("Regions: EMEA first (the audience). NA/SEA later.")

add_heading_styled("6.4 Tutorial & Army School", 2)
bullet("10-minute boot camp (move, build, counter).")
bullet("Faction primers: 1 short mission each that forces you to use the unique mechanic.")
bullet("Encyclopaedia: unit vs unit chart, like RA3.")

# ===================== 7 CAMPAIGN =====================
add_heading_styled("7. Campaign Script Outline", 1)
body("Tone: geopolitical pulp, not news. Year 2029. A fictional private military-intelligence network called AL-MIZAN (‘The Balance’) has bought officers, jammed satellites, and staged false-flag attacks to set Arab armies against each other while they seize oil nodes and ports. Each campaign is that army’s version of the same month. Players who finish two campaigns unlock the co-op finale.")
body("No living politician is named. Presidents and kings are ‘the Command’, ‘the Palace’, ‘the Council’.")

add_heading_styled("7.1 Structure", 2)
bullet("4 campaigns × 7 missions = 28. Plus 1 co-op finale (2 missions).")
bullet("Mission types mix: assault, defend, raid, naval landing, city clear, escort, superweapon race.")
bullet("Between missions: a simple situation room with a map of North Africa + Arabian Peninsula. Briefing is VO + text. Language: player’s UI language; radio in dialect.")

add_heading_styled("7.2 Egypt campaign — ‘THE RIVER HOLDS’", 2)
body("Logline: After a drone swarm hits a Sinai radar and a false recording implicates a Gulf partner, Cairo must secure the Canal, the Delta, and a Red Sea port before Al-Mizan turns the country into a corridor.")
bullet("E1 Sinai Glass: tutorial-plus. Hold two passes against militia-flagged armour (Al-Mizan proxies using mixed surplus). Teach Kornet + M60 + one F-16.")
bullet("E2 Night on the Canal: defend / repair Suez infrastructure. Naval intro. Missile boats vs dummy freighters that spawn commandos.")
bullet("E3 Sa‘ka in the Alleys: urban Cairo-adjacent. Garrison game. Hero intro. No tanks in the old city until the player blows a wall.")
bullet("E4 Wings over Beni Suef: airfield attacked. Learn F-16 vs MiG-29M mix vs incoming strike packages.")
bullet("E5 Mistral to the Islands: amphibious. Player uses the carrier fantasy to take a Red Sea island used as a missile farm.")
bullet("E6 The False Recording: raid Al-Mizan server farm in the desert. Stealth optional. If detected, full conventional.")
bullet("E7 October, Again: defend the capital approaches against a coalition-sized proxy assault. Superweapon unlock. Ending: Egypt holds, but Al-Mizan relocates west.")

add_heading_styled("7.3 Saudi campaign — ‘GREEN BANNER’", 2)
body("Logline: Oil nodes in the Eastern Province are sabotaged. The sky is full of unexplained drones. Riyadh answers with the thing it bought the most of: aircraft.")
bullet("S1 Pump Station 6: defend an oil field. Teach harvester protection + M-ATV reaction.")
bullet("S2 Empty Quarter Ghosts: recon in vast desert. Bradley + Apache. Ambush design.")
bullet("S3 Patriot Weather: first mass cruise-missile attack. Player must keep Patriot nodes alive. Teach RSAF Tasking.")
bullet("S4 The Causeway: land-naval hybrid. Teach frigate + F-15.")
bullet("S5 Palace Guard: urban Riyadh-adjacent, constrained ROE (do not flatten the district). Precision only.")
bullet("S6 Saqr Over the Ridge: hero mission. Player is mostly the ace plus a small ground screen.")
bullet("S7 Banner Unbroken: combined defence of the energy spine. Ending: Saudi sky is clean; Al-Mizan has a port in the Maghreb.")

add_heading_styled("7.4 UAE campaign — ‘FALCON PROTOCOL’", 2)
body("Logline: A precision war. Someone is using the Emirates’ own logistics software against them. The Presidential Guard does not do meat waves.")
bullet("U1 Port Khalifa Shadow: counter-sabotage. SF + Nimr. Tight timer.")
bullet("U2 Leclerc at Dawn: first armour fight in open sabkha. Teach autoloader micro.")
bullet("U3 HIMARS Math: player is not allowed a tank mass. Win with rockets, drones-as-vision, and two jets.")
bullet("U4 Island Chain: naval + air. Corvettes and Block 60s.")
bullet("U5 The Hotel: urban hostage-adjacent (extract a defector). Civilian collateral fails the mission.")
bullet("U6 EDGE Broken: enemy has cloned UAE munitions. Fight a mirror kit. Identity crisis mission.")
bullet("U7 Protocol Complete: simultaneous defence of two nodes. Co-op recommended. Ending: Al-Mizan unmasked as a board, not a country.")

add_heading_styled("7.5 Algeria campaign — ‘THE TELL AND THE ERG’", 2)
body("Logline: Mountain and desert. A foreign-flagged ‘stabilisation force’ (Al-Mizan) tries to peel the south. Algiers answers with T-90s and a sky that kills aircraft.")
bullet("A1 Djebel Ambush: teach elevation + Kornet + cheap T-72 screen.")
bullet("A2 Highway of Rust: defend a long road with TOS-1 ambush points.")
bullet("A3 Bubble: first S-300 mission. Player must choose where the umbrella lives.")
bullet("A4 Oran Night: naval + Kilo sub. Club-S shot as a set-piece.")
bullet("A5 Terminator Escort: a column of T-90s must cross open ground. BMPT is the star.")
bullet("A6 Smerch Conversation: counter-battery duel vs UAE-flavour HIMARS proxies.")
bullet("A7 Tell Atlas: final conventional battle. Ending: Al-Mizan burns; the four commands realise they were pointed at each other.")

add_heading_styled("7.6 Finale (unlock, 2 players recommended) — ‘THE BALANCE BREAKS’", 2)
bullet("F1 Boardroom: raid the actual Al-Mizan site (fictional Mediterranean platform + desert bunker). Each player brings their own faction.")
bullet("F2 Four Banners: last stand / assault hybrid. If all four campaigns were beaten, a short epilogue cinematic: four command tents, four coffees, one map, no speech about unity longer than twenty seconds.")

add_heading_styled("7.7 Sample mission script (full enough to build)", 2)
body("MISSION E3 — SA‘KA IN THE ALLEYS")
body("Setting: A dense district inspired by older Cairo / Alexandria streets. Dawn. Call to prayer in the far distance (one layer, not looping every 30s).")
body("Objectives: 1) Insert Colonel Tarek. 2) Clear the police HQ that Al-Mizan seized (garrisoned). 3) Defuse or escort-away a truck bomb on the corniche. 4) Optional: capture the radio station for a map reveal. 5) Extract when the armour column is two minutes out — or stay and fight it with unlocked M60s.")
body("Failure: Hero dies on Recruit he respawns at tent; on Marshal he is permadeath for the mission. Truck bomb detonates. Construction Yard (a forward garage) destroyed.")
body("Script beats:")
bullet("00:00 Briefing VO (Command, MSA with Egyptian colour): ‘The district is closed. You will not flatten it. Sa‘ka only until the bomb is moved.’")
bullet("00:40 Insertion cinematic: two Gazelle/Apache-escorted Black Hawk flavour helos. Player gets 3 Sa‘ka + hero.")
bullet("03:00 First contact. Militia with AKs on rooftops. Teach garrison.")
bullet("07:00 Radio station optional. If taken, fog lifts on the truck.")
bullet("11:00 Truck found. Engineer or Sa‘ka C4-disarm minigame (not a QT nightmare — a 20-second channel with interrupt risk).")
bullet("14:00 Al-Mizan armour (T-55s + technicals) enters from the ring road. Player may call M60s if the garage is held.")
bullet("Win sting: Tarek on radio. See voice section.")

# ===================== 8 VOICE =====================
add_heading_styled("8. Voice, Dialect & 18+ Slang Bible", 1)

body("This section is for the writer, the voice director, and the audio lead. Adult language is a design feature of a war game, not graffiti on the script. It is how conscripts actually talk when a tank is on fire. It is also how officers talk when they think the net is closed.")

add_heading_styled("8.1 Rules", 2)
bullet("Three layers per faction: COMMAND (almost clean, MSA or formal dialect), OFFICER (sharp, some profanity), TROOP (full slang, 18+).")
bullet("A settings slider: Family / Military / Uncut. Family replaces 18+ lines with the clean take we also record. Default on store pages: Military. Uncut is an option in-game.")
bullet("Do not use sectarian slurs. Do not use slurs against a real ethnic or religious group. Do not sexualise children. Adult sexual insults aimed at an enemy combatant are allowed in Uncut because that is how this language is actually used in anger.")
bullet("Do not mock the Qur’an, the prayer, or the shahada. Soldiers can swear by God in the ordinary way (‘wallah’, ‘yil‘an’). Keep the sacred out of the punchline.")
bullet("Record more lines than you think. RTS units repeat. We need 8–12 selects, 6–10 moves, 6–10 attacks, 4 deaths, 3 under-fire, 2 idle jokes, 2 victory.")
bullet("English UI can stay English. Combat VO stays dialect even if the player is in English UI. Subtitles optional, off by default for Uncut.")

add_heading_styled("8.2 Faction voice palettes", 2)
add_table(
    ["Faction", "Dialect", "Register", "Casting note"],
    [
        ["Egypt", "Cairene Egyptian (Masri)", "Fast, nasal, funny, filthy when scared", "Men 20–50. One older nCO. Hero is 40s smoker."],
        ["Saudi", "Najdi + light Gulf", "More clipped, more ‘ya rayyal’, still vicious", "Avoid cartoon Bedouin. Officers are urban Riyadh."],
        ["UAE", "Gulf (Emirati / shared Khaleeji)", "Calm, then suddenly sharp", "Heroine is Emirati, not generic. Mix of Emirati and other Khaleeji extras is fine."],
        ["Algeria", "Algerian Darija (Algiers / Oran mix)", "Dense, French loanwords, hard consonants", "Do not use Moroccan if you can help it. Get Algerian actors."],
        ["UI / Briefing", "Modern Standard Arabic + local colour", "News-anchor clean", "Same actor can do Command layer."],
    ],
)

add_heading_styled("8.3 Shared combat vocabulary (all factions understand)", 2)
body("Keep a few words identical so mixed co-op still reads: ‘Salakh!’ (contact), ‘Dababa!’ (tank), ‘Ta’ira!’ (aircraft), ‘Isnad!’ (support), ‘Insihab!’ (pull back), ‘Imsik!’ (hold). Then let the rest be local.")

add_heading_styled("8.4 EGYPT — sample bank (Uncut)", 2)
body("Infantry rifle squad")
quote_line("تحت أمرك يا باشا.", "Under your command, basha.", "SELECT")
quote_line("قول يا سيدي.", "Say the word.", "SELECT")
quote_line("إحنا موجودين.", "We're here.", "SELECT")
quote_line("ماشي يا عم.", "Alright, uncle.", "MOVE")
quote_line("يا الله عليه.", "Let's go then.", "MOVE")
quote_line("هنفشخهم.", "We're going to wreck them.", "ATTACK")
quote_line("اتلم يا ابن الكلب.", "Come here, you son of a dog.", "ATTACK")
quote_line("كس أم اللي جابك الحرب دي.", "Fuck the mother of whoever started this war.", "ATTACK")
quote_line("يا خرا على المنظر.", "Shit, look at this.", "UNDER FIRE")
quote_line("إصحى يا جدع! دبابة!", "Wake up man! Tank!", "UNDER FIRE")
quote_line("أنا مش هموت هنا يا ولاد الوسخة.", "I'm not dying here, you sons of bitches.", "UNDER FIRE")
quote_line("يا ابن المتناكة... آه.", "You son of a whore… ah.", "DEATH")
quote_line("بلغوا أهلي...", "Tell my family…", "DEATH")
quote_line("يا عم الجيش ده كله بالدوشة. اديني سيجارة.", "This whole army is nothing but noise. Give me a cigarette.", "IDLE")
quote_line("خلي السيسي... لا استنى، خلي القيادة تسمعنا كويس.", "(cuts himself off) Let Command hear us clean.", "IDLE — cut take")

body("Kornet team")
quote_line("الصاروخ في حضني زي ابني.", "This missile sits in my lap like my son.", "SELECT")
quote_line("دبابة؟ هخليها علبة تونة.", "A tank? I'll make it a tuna can.", "ATTACK")
quote_line("اتفضح يا حبيبي. فوق التراك.", "You're exposed, darling. Top of the track.", "ATTACK")

body("M1A1 crew")
quote_line("أبرامز في الخدمة. متقلقش.", "Abrams on duty. Don't worry.", "SELECT")
quote_line("ادوس يا معلم.", "Floor it, boss.", "MOVE")
quote_line("خرمتك. روح بلغ الشيطان.", "I put a hole in you. Go tell the devil.", "ATTACK")
quote_line("يا نهار أسود، صاروخ!", "Black day, missile!", "UNDER FIRE")

body("F-16 / Rafale pilot")
quote_line("النسر فوق. الأرض تحت. أنتم هباء.", "Eagle above. Ground below. You're nothing.", "SELECT")
quote_line("قفل الرادار عليهم. يولعوا.", "Lock them. Let them burn.", "ATTACK")
quote_line("يا ابن الـ... الصاروخ ورايا!", "You son of a— missile on me!", "UNDER FIRE")

body("Colonel Tarek (hero)")
quote_line("طارق. مش فاضي للدردشة.", "Tarek. I don't have time for chat.", "SELECT")
quote_line("هخشّ من الحتة اللي محدش باصصلها.", "I'll come in from the spot nobody's watching.", "MOVE")
quote_line("اتعلموا الحرب من اللي اتحرقوا فيها.", "Learn war from the people who already burned in it.", "ATTACK")
quote_line("يا أولاد الكلب، ده حارتي. مش حارتكم.", "Sons of dogs, this is my alley. Not yours.", "ATTACK")
quote_line("لو متّ، متموتش ورايا زي الخرفان.", "If I die, don't die behind me like sheep.", "UNDER FIRE")

body("Command (clean-ish)")
quote_line("القوات الخاصة في الطريق.", "Special forces are inbound.", "ABILITY")
quote_line("ضربة أكتوبر جاهزة. أكد الإحداثيات.", "October Strike ready. Confirm coordinates.", "SW")

body("Victory / taunt")
quote_line("خلصت؟ طيب. نشرب شاي ونكمل.", "Done? Good. We drink tea and continue.", "WIN")
quote_line("روحوا ناموا. بكرة برضو هنكسّركم.", "Go sleep. Tomorrow we'll break you again.", "TAUNT")

add_heading_styled("8.5 SAUDI — sample bank (Uncut)", 2)
body("National Guard infantry")
quote_line("تحت أمرك.", "At your command.", "SELECT")
quote_line("سمعًا وطاعة.", "Heard and obeyed.", "SELECT")
quote_line("تحركوا يا رجال.", "Move, men.", "MOVE")
quote_line("يا كلب، ذا آخر يومك.", "You dog, this is your last day.", "ATTACK")
quote_line("اطلع من وجهي يا زبالة.", "Get out of my face, you trash.", "ATTACK")
quote_line("الله يلعن اللي ورّطنا فيكم.", "God curse whoever dragged us into you.", "ATTACK")
quote_line("انقصفنا! انقصفنا!", "We're getting shelled!", "UNDER FIRE")
quote_line("ما نتراجع. ما فيه تراجع.", "We don't fall back. There is no falling back.", "UNDER FIRE")
quote_line("أمي...", "Mother…", "DEATH")

body("M1A2S crew")
quote_line("أبرامز إس. ما يتفاهم إلا بالطلق.", "Abrams S. It only talks in rounds.", "SELECT")
quote_line("خلّه يشوف من اللي يوقف في الصحراء.", "Let him see who stands in the desert.", "ATTACK")

body("F-15SA pilot")
quote_line("صقر واحد. السماء لي.", "Saqr One. The sky is mine.", "SELECT")
quote_line("اقفل. أطلق. لا تناقش.", "Lock. Release. Don't discuss.", "ATTACK")
quote_line("يا حمار، فوقك صاروخ!", "You donkey, missile above you!", "WINGMAN")

body("Command")
quote_line("مهمة سلاح الجو في الطريق. أخلوا الممر.", "Air tasking inbound. Clear the corridor.", "ABILITY")
quote_line("البطارية جاهزة. لا تضيعوا الصاروخ.", "Battery ready. Do not waste the missile.", "PATRIOT")

add_heading_styled("8.6 UAE — sample bank (Uncut)", 2)
body("Presidential Guard")
quote_line("الحرس. جاهزين.", "The Guard. Ready.", "SELECT")
quote_line("نتحرك بهدوء.", "We move quiet.", "MOVE")
quote_line("هدف مؤكد. اقتلوه.", "Target confirmed. Kill him.", "ATTACK")
quote_line("يا قليل أدب، هذي مو ساحتكم.", "You have no manners. This is not your ground.", "ATTACK")
quote_line("انضربنا. غطوا بعض.", "We're hit. Cover each other.", "UNDER FIRE")

body("Major Layla")
quote_line("ليلى. لا تعيد الأمر مرتين.", "Layla. Don't give the order twice.", "SELECT")
quote_line("أقدر أمشي بينكم وما تشوفوني.", "I can walk through you and you won't see me.", "MOVE")
quote_line("خلّ الصاروخ يتكلم. أنا خلصت الكلام.", "Let the missile talk. I'm done talking.", "ATTACK")
quote_line("يا عيال الحرام، توقّفوا عن الهزار.", "You bastards, stop joking around.", "UNDER FIRE")
quote_line("إذا سقطت، لا تصوّروا. كمّلوا المهمة.", "If I go down, don't film it. Finish the mission.", "UNDER FIRE")

body("HIMARS crew")
quote_line("الحسابات صحيحة. الباقي على الله وعليكم.", "The math is correct. The rest is on God and on you.", "SELECT")
quote_line("ستة صواريخ. حيّ الله من يِستَر.", "Six rockets. God help whoever is under them.", "ATTACK")

body("F-16E pilot")
quote_line("فالكون. محطة طويلة. لا تستعجلني.", "Falcon. Long station. Don't rush me.", "SELECT")
quote_line("قفلت عليه. يِزوّل.", "I locked him. He's gone.", "ATTACK")

add_heading_styled("8.7 ALGERIA — sample bank (Uncut)", 2)
body("ANP infantry (Darija)")
quote_line("واش حبّيت؟ راني هنا.", "What do you want? I'm here.", "SELECT")
quote_line("روح. رانا نتبعوك.", "Go. We follow you.", "MOVE")
quote_line("يا ولد القحبة، اجي لهنا.", "You son of a whore, come here.", "ATTACK")
quote_line("نقصّك قصّ. ماكش راجل في وجهي.", "I'll cut you down. You're not a man in my face.", "ATTACK")
quote_line("يَزّي هزْر. الطيارة فوقنا!", "Enough talk. Jet above us!", "UNDER FIRE")
quote_line("راني مجروح... بلّغ الكومندان.", "I'm hit… tell the commandant.", "DEATH")
quote_line("عطيني كاينة ولا سيجارة. الحرب هاذي طويلة.", "Give me a can or a cigarette. This war is long.", "IDLE")

body("T-90 crew")
quote_line("تي-تسعين. ما يتّهزّش بالريح.", "T-90. The wind doesn't move it.", "SELECT")
quote_line("أطلق. وسكّر فمك.", "Fire. And shut your mouth.", "ATTACK")
quote_line("صاروخ جاي! ساتوررا!", "Missile incoming! Shtora!", "ABILITY")

body("TOS-1A crew")
quote_line("الشمس حارقة. حنا أحرّ.", "The sun burns. We burn hotter.", "SELECT")
quote_line("حيّ الله اللي في المبنى. ما يخرجش.", "God help whoever is in that building. He isn't coming out.", "ATTACK")

body("Captain Youcef")
quote_line("يوسف. الجبل يسمع فيّا.", "Youcef. The mountain hears me.", "SELECT")
quote_line("نعلّملكم الحرب كيفاش تتدار في التل.", "I'll teach you how war is done in the hills.", "ATTACK")
quote_line("يا الكلاب، هاذ الأرض شربت أكثر من دمكوم.", "You dogs, this ground has drunk more than your blood.", "ATTACK")

add_heading_styled("8.8 Radio protocol (all factions)", 2)
body("Layer a second, quieter take for the same events that Command would allow on an open net. Example: Uncut attack ‘اتلم يا ابن الكلب’ has a Military take ‘تقدّم وأطلق’ and a Family take ‘تقدّم’. Record all three in the same session so the actor’s energy matches.")

add_heading_styled("8.9 Music", 2)
bullet("Main theme: low brass + darbuka + electric oud + a Western RTS ostinato. Think Generals GLA theme if it had a real orchestra and no cheap ‘ethnic’ patch.")
bullet("Egypt: oud + strings, Cairo traffic percussion in menus.")
bullet("Saudi: sparse, wide, male chorus far away, air-to-air drum.")
bullet("UAE: clean, modern, pulse, little ornament.")
bullet("Algeria: bendir, gasba flavour, heavier low end.")
bullet("Superweapon sting: 8 bars, unique per faction. Must be recognizable from the first two notes (ladder readability).")

# ===================== 9 MAPS =====================
add_heading_styled("9. Map List (launch)", 1)
body("12 ladder maps + campaign variants. All need a 1v1 slice and a 4v4 stretch.")
add_table(
    ["Map", "Biome", "Why it exists"],
    [
        ["Sinai Passes", "Rock desert + ridges", "Chokepoints. Egypt home."],
        ["Nile Fork", "River + fields + towns", "Crossings. Engineers matter."],
        ["Empty Quarter", "Sand sea", "Saudi home. Long sightlines. Air king."],
        ["Eastern Pumps", "Oil forest", "Many fields. Economy fights."],
        ["Sabkha Line", "Salt flat + coast", "UAE home. HIMARS heaven if vision is held."],
        ["Port Crescent", "Deep water + docks", "Naval. Mistral / corvette / Kilo."],
        ["Old District", "Dense city", "Garrison. No-tank alleys + ring road."],
        ["Tell Atlas", "Hills + forest pockets", "Algeria home. Elevation."],
        ["Erg Road", "Dune highway", "Column fights. Ambush TOS."],
        ["Red Sea Tooth", "Island chain", "Air + navy."],
        ["Two Mosques Crossing", "Town + river (fictional)", "Sacred-looking but fictional. No real shrine name."],
        ["Four Camps", "Open 4v4 desert", "Classic ladder bowl."],
    ],
)

# ===================== 10 UI UX =====================
add_heading_styled("10. UI / UX", 1)
bullet("Sidebar right (C&C memory). Production tabs: Infantry / Vehicles / Air / Navy / Support.")
bullet("Hotkeys: QWER grid per tab + classic numbers. Full rebind.")
bullet("Arabic UI is real RTL, not mirrored English. Hire a native for this. Buttons, chat, and replays must not break.")
bullet("Colourblind modes. Faction colour is also shape (chevron / circle / diamond / bar).")
bullet("Pause in campaign and skirmish vs AI. No pause in ranked.")
bullet("After-action: graph of resources, units lost, air kills. Shareable card for X/Twitter.")

# ===================== 11 ONLINE =====================
add_heading_styled("11. Online Services (minimum)", 1)
bullet("Account: platform login (Steam / Epic) + optional guest skirmish.")
bullet("Friends list, invite, lobby.")
bullet("Ranked: hidden MMR first season, visible ranks after we have data. Ranks named in Arabic military flavour: Jundi / ‘Arif / Mulazim / Naqib / ‘Aqid / Liwa / Fariq.")
bullet("Report: cheat / abuse / hate. Auto-mute repeat offenders in voice/text.")
bullet("Live ops later: weekly map, extra skin crate. No pay-to-win units. Cosmetics only if we ever monetise.")

# ===================== 12 PRODUCTION =====================
add_heading_styled("12. What to Build First (for the developer)", 1)
body("Do not start by modelling a Rafale. Start by proving the loop.")

add_heading_styled("12.1 Vertical slice (8–10 weeks if the team is real)", 2)
bullet("One biome: Sinai-like desert.")
bullet("Two factions only: Egypt vs Algeria (max contrast).")
bullet("Units each: rifle, ATGM, one IFV, one cheap tank, one MBT, one SPG, one helo, one fighter, engineer, MCV, power, barracks, factory, airfield, one SAM, one superweapon dummy.")
bullet("AI that attacks in waves.")
bullet("10 Egyptian infantry lines + 10 Algerian infantry lines recorded even if placeholder actors.")
bullet("Win/lose. Replay. That's the slice. If this is not fun, nothing else matters.")

add_heading_styled("12.2 Production phases", 2)
add_table(
    ["Phase", "Output"],
    [
        ["0. Slice", "Fun 1v1 in 15 minutes. No campaign."],
        ["1. Four factions greybox", "All v1 units as boxes with icons. Stats pass."],
        ["2. Art pass 1", "Egypt + Algeria full art. Two maps pretty."],
        ["3. Netcode", "2v2 stable. Desync tools."],
        ["4. Voice", "Military + Uncut banks for all four. Family later."],
        ["5. Campaign spine", "Egypt 7 missions greybox, then art."],
        ["6. Saudi + UAE art", "Remaining factions look like themselves."],
        ["7. Ranked beta", "Closed, Arabic + English communities."],
        ["8. Ship", "Four factions, 12 maps, 4 campaigns, co-op finale, skirmish, ranked 1v1/2v2."],
    ],
)

add_heading_styled("12.3 Team sketch (small studio)", 2)
bullet("1 director / designer (this document lives or dies here).")
bullet("1 gameplay engineer + 1 network engineer.")
bullet("1 tools / UI.")
bullet("2 gameplay scripters (missions).")
bullet("3–5 3D (units + maps). 1 animator. 1 VFX.")
bullet("1 audio + contracted composers + contracted dialect VOs.")
bullet("1 producer. QA as soon as slice exists.")
body("A five-person team can make the slice. They cannot ship four campaigns. Plan contractors for voice and vehicles.")

add_heading_styled("12.4 Legal / sensitivity", 2)
bullet("Do not use official emblems without licence. Create ‘inspired by’ markings: Egypt gets a stylised eagle that is not the exact Republican Eagle; Saudi a stylised sword-and-palm that is not the exact emblem, etc. Lawyers will thank you.")
bullet("Do not depict real living commanders. Hero names are fictional.")
bullet("Music: original score. No sampled anthems.")
bullet("Age rating: PEGI 18 / ESRB M if Uncut is in the build. Store page must say strong language + violence. The Family slider is how we also talk to a wider audience.")
bullet("Published inventories are public facts. We still add a loading-screen line: ‘Unit mix is a game abstraction of publicly reported equipment.’")

# ===================== 13 SCRIPT BITS =====================
add_heading_styled("13. Additional Script Packs the Writer Must Deliver", 1)
bullet("Main menu VO one-liners per faction when highlighted.")
bullet("Defeat lines (not just victory). Egypt: ‘البلد أكبر من خسارة معركة.’ Saudi: ‘نعيد التشكيل.’ UAE: ‘نحسبها من جديد.’ Algeria: ‘ما سالاتش.’")
bullet("Unit ready / unit lost / base under attack / insufficient power / construction complete — all four dialects.")
bullet("Spectator lines if we ever add a caster pack (MSA).")
bullet("Tutorial jokes that do not break the tone.")

add_heading_styled("13.1 Sample briefing (Egypt E1)", 2)
body("COMMAND (MSA, slight Egyptian colour):")
body("«سيناء ليست تمرينًا. الرادار سقط قبل الفجر. الذي يتحرك في الممرات ليس جيشًا نظاميًا، وهو يلبس لباس الجيوش. ستمسك الممرين. لن تترك بينهما فجوة. إذا سقط أحدهما، القناة بعدها.»")
body("TARIQ (coming in on the net, Masri):")
body("«فهمنا يا فندم. إحنا مش هنسأل هو مين. هنسأله بعد ما يقع.»")

add_heading_styled("13.2 Sample end-mission sting (UAE U3)", 2)
body("LAYLA:")
body("«ستة صواريخ. مستودع واحد. الحساب كان صحيح. اللي يبي يعيدها، يعيدها من مسافة أبعد.»")

# ===================== 14 APPENDIX =====================
add_heading_styled("14. Appendix A — Inventory Anchors Used", 1)
body("These are starting points for art reference and unit identity, not a spreadsheet of truth. Cross-check before locking a model.")
bullet("Egypt: M1A1 SA locally assembled, M60A3, T-62 leftovers, YPR-765, BMP-1, M109 / K9, BM-21, Kornet, Igla/Stinger, F-16C, Rafale, MiG-29M, AH-64D, Ka-52, S-300VM / Buk / Tor flavour, Type 209, FREMM/MEKO flavour, 2× Mistral-class carriers as a campaign/superweapon fantasy.")
bullet("Saudi: M1A2S, M60A3, Bradley, M113, M-ATV, CAESAR, M109, M270, AH-64D/E, UH-60, CH-47, F-15C/S/SA, Typhoon, Tornado IDS, E-3, Patriot PAC-2/3, Avenger.")
bullet("UAE: Leclerc, BMP-3, Rabdan, NIMR family, G6, M109, HIMARS, Chunmoo, AH-64, CH-47, F-16E Block 60, Mirage 2000-9, Rafale on order, THAAD + Patriot, Baynunah corvettes.")
bullet("Algeria: T-90SA, T-72, T-62, BMP-2, Fuchs 2, BMPT, 2S1, PLZ-45, Grad, Smerch, TOS-1A, Mi-28/Mi-24, Su-30MKA, MiG-29, Su-24, reported Su-35 / Su-57 limited, Pantsir, S-300/S-400, Kilo 636.")

add_heading_styled("15. Appendix B — Open Questions for the First Design Meeting", 1)
bullet("Do we ship Uncut on all storefronts or gate it behind a free ‘language pack’?")
bullet("Is the fourth faction Algeria or Morocco? (Algeria gives Russian contrast. Morocco gives French/US contrast closer to UAE. Current call: Algeria.)")
bullet("Naval: full third axis or ‘coastal only’? Current call: full on 40% of maps.")
bullet("Heroes: one per faction or also campaign-only guest heroes?")
bullet("Do we allow same-faction mirror matches? Yes.")
bullet("Spectator delay for ranked? 2 minutes.")
bullet("Working title ASH-SHARQ vs DESERT COMMAND vs a publisher title. Do not fall in love.")

add_heading_styled("16. Closing note to the developer", 1)
body("Build the slice. Record twenty lines of Cairene infantry and twenty lines of Algerian infantry before you hire a concept artist for a Rafale. If a player laughs, swears back at the speaker, and then loses a tank to a Kornet he did not see, the game is already itself.")
body("When the slice works, this document becomes a living wiki. Until then it is a fence: stay inside the four armies, the two resources, the one-ability rule, and the dialect rule. Everything else is decoration.")

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("— END OF GDD v0.1 —")
set_run_font(r, size=12, bold=True, color=(0x1A, 0x3A, 0x2A))

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("Next expected deliverables from design: unit stat sheet (spreadsheet), hotkey map, and mission E3 greybox script with trigger list.")
set_run_font(r, size=10, italic=True, color=(0x55, 0x55, 0x55))

out = "/home/workdir/artifacts/ASH-SHARQ_Desert_Command_GDD_v0.1.docx"
doc.save(out)
print("Wrote", out)

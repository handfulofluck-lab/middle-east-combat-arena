#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ASH-SHARQ GDD v0.2 addendum — Turkey, Israel, India, Pakistan, Iran."""

from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

doc = Document()

def set_run_font(run, name="Calibri", size=11, bold=False, italic=False, color=None):
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    if color:
        run.font.color.rgb = RGBColor(*color)

def h(text, level=1):
    p = doc.add_heading(text, level=level)
    for run in p.runs:
        run.font.color.rgb = RGBColor(0x1A, 0x3A, 0x2A) if level == 1 else RGBColor(0x2C, 0x5F, 0x4A)
    return p

def body(text, size=11, bold=False, italic=False, space_after=8):
    p = doc.add_paragraph()
    run = p.add_run(text)
    set_run_font(run, size=size, bold=bold, italic=italic)
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.line_spacing = 1.15
    return p

def bullet(text):
    p = doc.add_paragraph(text, style="List Bullet")
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
    tc = cell._tc
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

def add_table(headers, rows, header_fill="1A3A2A"):
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, hdr in enumerate(headers):
        set_cell_text(table.rows[0].cells[i], hdr, bold=True, size=10, color=(255, 255, 255), fill=header_fill)
    for r_i, row in enumerate(rows):
        fill = "F4F1EA" if r_i % 2 == 0 else "FFFFFF"
        for c_i, val in enumerate(row):
            set_cell_text(table.rows[r_i + 1].cells[c_i], str(val), size=9, fill=fill)
    doc.add_paragraph()
    return table

for section in doc.sections:
    section.top_margin = Cm(1.8)
    section.bottom_margin = Cm(1.8)
    section.left_margin = Cm(2.0)
    section.right_margin = Cm(2.0)
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("ASH-SHARQ GDD v0.2 ADDENDUM  ·  Five Regional Powers  ·  Page ")
    set_run_font(r, size=8, color=(0x66, 0x66, 0x66))
    fld = OxmlElement("w:fldChar"); fld.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText"); instr.set(qn("xml:space"), "preserve"); instr.text = " PAGE "
    fld2 = OxmlElement("w:fldChar"); fld2.set(qn("w:fldCharType"), "end")
    r2 = p.add_run(); r2._r.append(fld); r2._r.append(instr); r2._r.append(fld2)
    set_run_font(r2, size=8, color=(0x66, 0x66, 0x66))

p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("ADDENDUM TO GDD v0.1")
set_run_font(r, size=11, bold=True, color=(0x7A, 0x2E, 0x0E))

p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("ASH-SHARQ: DESERT COMMAND")
set_run_font(r, size=26, bold=True, color=(0x1A, 0x3A, 0x2A))

p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("v0.2  —  FIVE REGIONAL POWERS")
set_run_font(r, size=16, bold=True, color=(0x7A, 0x2E, 0x0E))

p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("Turkey · Israel · India · Pakistan · Iran\nRead this on top of GDD v0.1. It does not replace the original four Arab armies.")
set_run_font(r, size=12, italic=True)

body("This addendum expands the launch fantasy from ‘Arab armies only’ to ‘the neighbourhood’. The original four (Egypt, Saudi, UAE, Algeria) stay the identity core. The five new factions are full playable armies with the same rules: published-inventory anchors, one unique mechanic, one hero, one superweapon, dialect/language voice pack including Uncut 18+ lines, Family/Military/Uncut slider.")

h("0. How to ship nine factions without dying", 1)
body("Nine complete art-and-voice factions is a sequel-sized project. Do not pretend otherwise. Recommended ship plan:")
add_table(
    ["Wave", "Factions", "Why"],
    [
        ["Wave 0 — Slice", "Egypt vs Algeria", "Already in v0.1. Prove the loop."],
        ["Wave 1 — Arab core", "+ Saudi + UAE", "Keeps the original promise."],
        ["Wave 2 — Near neighbourhood", "+ Turkey + Iran", "Drone vs missile contrast. Maps already exist (desert, coast, highland)."],
        ["Wave 3 — Wider neighbourhood", "+ Israel + India + Pakistan", "Highest political heat + new biomes (Levant cities, Punjab/Thar, Kashmir-flavour highlands). Needs extra maps and extra legal pass."],
    ],
)
note("Greybox all nine as soon as Wave 0 is fun, so ladder testers can play mirrors. Art and Uncut VO can trail the greybox by a full wave. Never lock a unit that the public inventory cannot support (no Israeli T-90, no Iranian F-35, no Pakistani Rafale).")

h("0.1 What changes in the original vision", 2)
bullet("Subtitle on the box can become DESERT COMMAND / REGIONAL POWERS. Working title ASH-SHARQ still works: the map is the East as seen from Alexandria, not a UN atlas.")
bullet("Al-Mizan (the fictional private network) now also stokes India–Pakistan and Israel–Iran crises in the same month, so campaigns can cross. No living politician is named. No nuclear weapons. No depiction of real terror organisations as playable sides.")
bullet("Ladder: any faction vs any faction. Mirror matches allowed. Map pool expands (see §6).")
bullet("Voice rule is now ‘language of the army’, not ‘Arabic only’. UI stays English + Arabic + the new languages if budget allows. Combat VO is always native.")
bullet("Legal: inspired-by markings only. No official IDF, TSK, IAF, PAF, or IRGC emblems without a licence you will not get.")

h("0.2 Design roles so they do not clone existing factions", 2)
add_table(
    ["Faction", "One-word feel", "Must not play like"],
    [
        ["Turkey", "Drones", "Saudi (air quality) or UAE (precision). Turkey wins with cheap persistent UAV coverage + indigenous missiles, not F-15s."],
        ["Israel", "Shield + knife", "UAE (elite expensive). Israel is elite AND has the best layered defence in the game. Trophy / Iron Dome are the identity, not ‘just better Leclercs’."],
        ["India", "Scale + mix", "Egypt (also mixed). India is heavier, has BrahMos as the unique punch, and a carrier late-game on naval maps."],
        ["Pakistan", "Strike + deny", "Algeria (also missiles). Pakistan is faster, air-first with JF-17/J-10C, Babur cruise, Hangor subs. Lighter tanks than India."],
        ["Iran", "Swarm + rain", "Algeria (SAM + rockets). Iran’s air force is the weakest of the nine. Compensation is disposable drones, SRBMs, and dispersed launchers that rebuild."],
    ],
)

# ===================== TURKEY =====================
h("1. Turkey — Türk Silahlı Kuvvetleri", 1)
body("Doctrine: NATO-sized army that decided to build its own toys. The player should feel Baykar / Roketsan / Aselsan as a system: a TB2 is cheap and annoying, an Akıncı is a flying artillery piece, a Siper battery is a poor man’s S-400 that still ruins casual air play. Ground game is Leopard / M60T now, Altay later in the match.")
body("Unique mechanic — SİHA NETWORK: every friendly UAV shares a ‘mesh’. Spotted enemies stay painted for 8 seconds after the drone leaves LOS. TB2s are expendable scouts; losing one is not a tragedy. Akıncı can lase for Fırtına / Kasırga. This is not Saudi off-map jets. This is organic, on-map drone weather.")
body("Hero — YÜZBAŞI EMRE ‘KARA’ YILMAZ: commando (Bordo Bereliler flavour). Can deploy a portable anti-drone jammer (small radius, 12s) and a satchel. Voice: western-Anatolian, dry, swears when the net is closed.")
body("Superweapon — TAYFUN RAIN: a conventional SRBM/QRSAM-supported strike on a medium radius. Late: SİPER + a Kızılelma UCAV package that hunts remaining air. Interceptable by Iron Dome / S-400 / Patriot / Bavar.")
body("Colour: NATO green + red flag trim + light grey drones. UI accent crimson.")

h("Turkey v1 roster", 2)
add_table(
    ["Unit", "Real anchor", "Role / ability"],
    [
        ["Mehmetçik squad", "TSK infantry", "Solid line infantry. Ability: AT rocket (one-shot)."],
        ["Bordo Bereli", "Maroon Berets", "SF. Stealth in brush. C4."],
        ["Kirpi / Cobra", "BMC Kirpi, Otokar Cobra", "MRAP raid. Mine resist."],
        ["ACV-15 / Pars", "ACV-15, Pars 8x8", "IFV. 25mm + dismount."],
        ["M60T Sabra", "M60T", "Mid tank. Cheap-ish."],
        ["Leopard 2A4", "Leopard 2A4", "Main tank until Altay."],
        ["Altay T1", "Altay serial 2025–26", "Late MBT. APS flavour. Few, expensive."],
        ["T-155 Fırtına", "Fırtına II", "155mm SPG. Shoot-and-scoot."],
        ["Kasırga / TRG-300", "Kasırga MLRS", "Area rockets. Can take laser from Akıncı."],
        ["Korkut", "Korkut SPAAG", "Gun AA vs drones and helos."],
        ["Hisar-A / Hisar-O", "Hisar family", "Mobile SAM mid-tier."],
        ["Siper battery", "Siper", "Long SAM structure. Identity AA."],
        ["T129 ATAK", "T129", "Attack helo. UMTAS ATGM."],
        ["Bayraktar TB2", "TB2", "Cheap ISR + light strike. THE unit."],
        ["Akıncı", "Akıncı", "Heavy UCAV. MAM-T / SOM-flavour. Needs airfield tech."],
        ["Kızılelma (late)", "Kızılelma first deliveries flavour", "Jet UCAV. Fights aircraft poorly, hunts high-value."],
        ["F-16C Özgür / Block 70", "F-16 fleet + Viper kits", "Main fighter. Not F-35. Do not give F-35."],
        ["F-4E Terminator (aging)", "F-4E", "Cheap strike. Do not dogfight Rafales."],
        ["KAAN (campaign / very late)", "KAAN first flights, serial ~2029", "Optional campaign-only cameo. Not a ladder starter."],
        ["MİLGEM corvette", "MİLGEM / İstif", "Navy. Atmaca anti-ship."],
        ["Reis-class flavour sub", "Type 214TN", "Naval stealth + torpedo."],
    ],
)

h("Turkey Uncut sample bank", 2)
body("Infantry")
quote_line("Emret komutanım.", "Order me, commander.", "SELECT")
quote_line("Tamamdır, gidiyoruz.", "Alright, we're moving.", "MOVE")
quote_line("Vurun şu piçlere.", "Hit those bastards.", "ATTACK")
quote_line("Orospu çocuğu, gel buraya.", "You son of a whore, come here.", "ATTACK")
quote_line("Siktir, tanksavar!", "Fuck, ATGM!", "UNDER FIRE")
quote_line("Amına koyayım, IHA düştü.", "Fuck, the drone is down.", "UNDER FIRE")
quote_line("Anneme söyleyin...", "Tell my mother…", "DEATH")
quote_line("Çay nerede lan? Savaş da savaş, çaysız olmaz.", "Where's the tea? Even war needs tea.", "IDLE")

body("TB2 operator")
quote_line("Kuş havada. Siz sadece işaret edin.", "Bird is up. You just mark.", "SELECT")
quote_line("Lazer kilit. MAM gidiyor.", "Laser lock. MAM away.", "ATTACK")
quote_line("Kaybettik bir tanesini. Öbürü yolda.", "We lost one. The other is inbound.", "UNIT LOST")

body("Hero Emre")
quote_line("Kara. Kısa konuş.", "Kara. Talk short.", "SELECT")
quote_line("Bu vadiyi ben ezberledim. Siz ezilmeyin.", "I memorised this valley. Don't get crushed.", "MOVE")
quote_line("Siktir git dağından, burası bizim.", "Get the fuck off this mountain. It's ours.", "ATTACK")

# ===================== ISRAEL =====================
h("2. Israel — Israel Defense Forces", 1)
body("Doctrine: Small, expensive, over-trained, and wrapped in a defensive bubble that makes casual rocket spam look stupid. Ground game is Merkava + Namer — the heaviest infantry taxi in the nine. Air game is F-15I / F-16I / F-35I. The player who skips AA against Israel eats Trophy-deflected ATGMs and then an Adir.")
body("Unique mechanic — IRON LAYER: incoming rockets, cruise and some ballistic shots in a radius around Iron Dome / David’s Sling / Arrow structures have a high intercept chance. The player spends a small credit trickle per intercept (the ‘Tamir bill’). Trophy APS on Merkava and Namer can eat ONE ATGM every 20 seconds. Israel does not get cheap units. Israel gets to live through the first volley.")
body("Hero — RAV SEREN NOA ‘SHACHAF’ BEN-AMI: Sayeret-flavour operator. Female hero, distinct silhouette. Short cloak, Spike-SR, can call a single precise Delilah-flavour loiter. Voice: dry Hebrew, cuts to street when hit.")
body("Superweapon — ADIR PACKAGE: F-35I + F-15I coordinated bunker-delete on a small radius (UAE-like precision, higher air threat). Late: Arrow shot that can kill an inbound superweapon. Iron Beam flavour as a support power vs drones/rockets, not a death laser on tanks — the real system is still maturing, so keep it honest: excellent vs cheap air, weak vs armour.")
body("Colour: Sinai grey-green + black/white. UI accent blue-white. Do not use the exact Star of David as a decal; use a chevron + bar.")
note("Campaign tone for this faction is defensive / counter-strike against Al-Mizan false flags, not a documentary of any real war. No real unit numbers from current conflicts on loading screens. No playable militia factions.")

h("Israel v1 roster", 2)
add_table(
    ["Unit", "Real anchor", "Role / ability"],
    [
        ["Tzanhanim / Golani squad", "IDF infantry", "Best-trained basic infantry. Ability: rifle grenade."],
        ["Sayeret pair", "SF", "Stealth, C4, Spike mini."],
        ["Spike team", "Spike LR/NLOS", "Fire-and-forget AT. Can fire from behind a ridge (NLOS mode, long CD)."],
        ["Eitan 8x8", "Eitan", "Wheeled IFV. 30mm variant."],
        ["Namer", "Namer", "Heaviest APC in the game. Infantry inside almost do not die to small arms. Trophy."],
        ["Merkava Mk III (reserve)", "Mk III", "Budget tank."],
        ["Merkava Mk IV Windbreaker", "Mk 4M Trophy", "Main tank. Trophy APS. Ability: 60mm mortar pop."],
        ["Merkava Barak (late)", "Mk 4 Barak", "Mission-computer flavour: brief auto-spot in a cone."],
        ["M109 Doher", "M109", "SPG."],
        ["PULS / Menatetz", "M270 / PULS", "Guided rockets. Not Grad-inaccurate."],
        ["AH-64 Saraf", "Apache", "AT helo."],
        ["F-16I Sufa", "F-16I", "Workhorse strike-fighter."],
        ["F-15I Ra’am", "F-15I", "Heavy strike. Deep payload."],
        ["F-35I Adir", "F-35I (~50, expanding)", "Stealth strike. Short cloak in air. Identity jet. Expensive, few pads."],
        ["Hermes 450 / 900", "Elbit Hermes", "ISR UAV. Not a Shahed. Spots, light strike."],
        ["Iron Dome battery", "Iron Dome", "Structure + interceptor unit. Eats rockets and some cruise."],
        ["David’s Sling", "David’s Sling", "Mid-high SAM / ABM flavour."],
        ["Arrow 2/3 node", "Arrow", "Late ABM. Superweapon hunter."],
        ["Sa’ar 6 flavour", "Sa’ar 6", "Navy. Barak-8 AA + anti-ship."],
    ],
)

h("Israel Uncut sample bank", 2)
body("Infantry")
quote_line("Hamefaked, anachnu po.", "Commander, we're here.", "SELECT")
quote_line("Zazim.", "Moving.", "MOVE")
quote_line("Tistom et ha-ben zona ha-ze.", "Shut that son of a bitch down.", "ATTACK")
quote_line("Kus emek, tagdil!", "Fuck, RPG!", "UNDER FIRE")
quote_line("Lezayen, yesh tank!", "Fuck, there's a tank!", "UNDER FIRE")
quote_line("Ima...", "Mom…", "DEATH")
quote_line("Aizé hara shel boker.", "What a shit morning.", "IDLE")

body("Merkava crew")
quote_line("Merkava. Trophy duluk.", "Merkava. Trophy is on.", "SELECT")
quote_line("Achalti lo et ha-til. Tizrok od.", "I ate his missile. Throw another.", "APS PROC")
quote_line("Ben zona, hu meachorei ha-kir.", "Son of a bitch, he's behind the wall.", "ATTACK")

body("Noa (hero)")
quote_line("Noa. Al techzor al ze.", "Noa. Don't repeat that.", "SELECT")
quote_line("Ani lo tzricha she-tir’u oti. Rak she-ze yigamer.", "I don't need you to see me. I need this over.", "MOVE")
quote_line("Day. Siyamnu im ha-harot ha-ze.", "Enough. We're done with this shit.", "ATTACK")

body("F-35I pilot")
quote_line("Adir. Hem lo ro’im oti.", "Adir. They don't see me.", "SELECT")
quote_line("Shtei bombot. Binyan echad.", "Two bombs. One building.", "ATTACK")

# ===================== INDIA =====================
h("3. India — Indian Armed Forces", 1)
body("Doctrine: The biggest mixed catalogue on the roster after Egypt, but heavier. T-90 Bhishma wall, Arjun as a proud expensive oddity, Su-30MKI numbers, Rafale quality, BrahMos as the sentence everyone understands. Naval maps can grow an aircraft carrier late, which no other faction gets as a unit (Egypt’s Mistral is a helicopter carrier fantasy, not a jet deck).")
body("Unique mechanic — BRAHMOS LANE: from the Cruise Battery, the player plots a LOW-ALTITUDE LINE on the map. The missile follows it. It can be intercepted if SAM sees the corridor. This is a skill-shot super-cruise, not a click-delete. Teaches map reading.")
body("Hero — COLONEL ARJUN ‘SHERPA’ THAPA: mountain / para flavour (fictional name, not a real CO). Bonus on elevation. Can mark a peak for artillery. Voice: crisp Indian English + Hindi snap when angry.")
body("Superweapon — TRISHUL: BrahMos salvo + Su-30 package on a medium radius. Late: a carrier air wing strike on naval maps, or a second BrahMos lofted shot on land maps.")
body("Colour: olive + saffron-white-green trim used sparingly. Do not paint roundels as the exact IAF roundel; use a stylised orange-white-green bar.")

h("India v1 roster", 2)
add_table(
    ["Unit", "Real anchor", "Role / ability"],
    [
        ["Rifle section", "Indian Army infantry", "Stout. Ability: LMG burst."],
        ["Para SF", "Para SF", "SF. Stealth, C4."],
        ["Nag / NAMICA", "Nag ATGM, NAMICA", "Indigenous AT. Fire-and-forget."],
        ["BMP-2 Sarath", "BMP-2", "Workhorse IFV."],
        ["T-72 Ajeya", "T-72M1", "Meat tank."],
        ["T-90S Bhishma", "T-90S (~1,300)", "Main tank. Shtora-ish dazzler."],
        ["Arjun Mk1A", "Arjun", "Heavy, expensive, great gun. Slow. Identity pride unit."],
        ["Zorawar (late, light)", "Zorawar light tank programme", "Mountain / raid tank. Optional late unlock."],
        ["K9 Vajra / Dhanush", "K9, Dhanush", "155mm."],
        ["Pinaka", "Pinaka MBRL", "MLRS. Guided flavour upgrade."],
        ["Akash / QRSAM", "Akash", "Mobile SAM."],
        ["S-400 battery", "S-400 in IAF/IA", "Strategic SAM. Shared fantasy with Algeria — differentiate by longer lock time, better vs high jet."],
        ["AH-64E / Light Combat Helo", "Apache + Prachand", "Apache premium, Prachand cheap indigenous."],
        ["Tejas Mk1A", "Tejas", "Cheap-ish indigenous fighter. Fine, not Rafale."],
        ["Su-30MKI", "Su-30MKI (~260)", "The wall in the sky. Ability: long BVR."],
        ["Rafale DH/EH", "Rafale (36 + more on order)", "Premium jet. Meteor-flavour long shot."],
        ["Jaguar (aging)", "Jaguar", "Cheap strike. Dying breed."],
        ["BrahMos battery", "BrahMos", "Structure + launcher. The lane mechanic."],
        ["INS Vikrant flavour", "Vikrant", "Naval super-unit on large water maps. Jets + SAMs. Huge cost. One per match."],
        ["Kalvari / Scorpène flavour sub", "Kalvari class", "Navy stealth."],
    ],
)

h("India Uncut sample bank", 2)
body("Infantry — Hindi with army English mixed, the way it actually sounds")
quote_line("Hazir hain, sahab.", "Present, sir.", "SELECT")
quote_line("Chalo, move on.", "Come on, move on.", "MOVE")
quote_line("Usko girao, madarchod.", "Drop him, motherfucker.", "ATTACK")
quote_line("Bhenchod, tank aa gaya!", "Sisterfucker, a tank is here!", "UNDER FIRE")
quote_line("Harami log, fire aa raha hai!", "Bastards, incoming fire!", "UNDER FIRE")
quote_line("Maa ko bolna...", "Tell my mother…", "DEATH")
quote_line("Chai kab milegi, kutta din hai.", "When is the tea coming? It's a dog of a day.", "IDLE")

body("T-90 crew")
quote_line("Bhishma ready. Tension mat lo.", "Bhishma ready. Don't stress.", "SELECT")
quote_line("Gola baith gaya, saale.", "The round sat down, you bastard.", "ATTACK")

body("Colonel Thapa")
quote_line("Thapa. Short briefing.", "Thapa. Short briefing.", "SELECT")
quote_line("Pahad se jo khelega, pahad mein rahega.", "Who plays from the mountain stays in the mountain.", "ATTACK")
quote_line("Bas kar, saale. Yeh exercise nahi hai.", "Enough, bastard. This is not an exercise.", "UNDER FIRE")

body("Rafale / Su-30 pilot")
quote_line("Sher-e-Hind, locked.", "Lion of India, locked.", "ATTACK")
quote_line("Madarchod ki missile peeche hai!", "A motherfucker’s missile is behind me!", "UNDER FIRE")

# ===================== PAKISTAN =====================
h("4. Pakistan — Pakistan Armed Forces", 1)
body("Doctrine: Lighter than India, meaner in the first ten minutes. JF-17 numbers, J-10C quality, F-16 veterans, Al-Khalid / VT-4 (Haider) armour, Babur cruise, Hangor AIP submarines, a growing Chinese/Turkish shopping list. They win by hitting first and denying the sky with HQ-series / indigenous AD, not by a T-90 parking lot.")
body("Unique mechanic — BABUR WINDOW: a cruise corridor like India’s BrahMos lane, but cheaper, slower, and stackable. Player can put two Baburs in the air. Also: JF-17s rebuild 15% faster than other light fighters (PAC Kamra flavour).")
body("Hero — MAJOR BILAL ‘SHER’ QURESHI: SSG flavour. Can call a short artillery smoke + a single loitering munition. Voice: Urdu, Punjabi colour when angry.")
body("Superweapon — GHAZNAVI RAIN: conventional SRBM + Babur mix on a large radius. Late: Hangor Club-flavour land-attack from the sea if a sub is alive, or a J-10C + JF-17 Block III package.")
body("Colour: olive drab + green crescent trim (stylised, not the exact flag star-and-crescent as a killmark).")

h("Pakistan v1 roster", 2)
add_table(
    ["Unit", "Real anchor", "Role / ability"],
    [
        ["Infantry section", "Pakistan Army infantry", "Cheap, brave. Ability: RPG."],
        ["SSG pair", "Special Services Group", "SF. Stealth, C4."],
        ["Baktar-Shikan team", "HJ-8 / Baktar-Shikan", "AT."],
        ["Talha / M113", "HIT Talha, M113", "APC."],
        ["Al-Zarrar", "Al-Zarrar (Type 59 deep rebuild)", "Reserve tank. Cheap."],
        ["T-80UD", "T-80UD", "Mid tank, fast."],
        ["Al-Khalid / Al-Khalid I", "Al-Khalid", "Main tank."],
        ["Haider (VT-4)", "VT-4 / Haider", "Premium tank. Late."],
        ["M109 / SH-15 flavour", "SP howitzers", "155mm."],
        ["A-100 / Fatah MLRS", "A-100, Fatah series", "Rockets."],
        ["HQ-9 / HQ-16 flavour + Korkut", "Chinese SAM + Turkish Korkut", "Layered AA. Korkut eats drones."],
        ["Z-10ME", "Z-10ME", "Attack helo. New identity rotor."],
        ["JF-17 Block II", "JF-17", "Cheap multirole. THE volume jet."],
        ["JF-17 Block III", "Block III AESA + PL-15 flavour", "Better BVR. Still not a Rafale."],
        ["F-16A/C MLU / Block 52", "F-16 fleet ~70+", "Quality jet. Veteran VO."],
        ["J-10CE", "J-10C", "Best PAF dogfighter in v1. Limited numbers."],
        ["Mirage III/V (aging)", "Mirage", "Cheap strike / nuke-role flavour WITHOUT nukes: conventional stand-off only."],
        ["Babur TEL", "Babur cruise", "Cruise launcher. Window mechanic."],
        ["MILGEM / Babur-class corvette", "Turkish MILGEM for PN", "Navy."],
        ["Hangor-class sub", "Type 039A / Hangor, first boat 2026", "AIP sub. Late naval identity. Land-attack one-shot."],
    ],
)

h("Pakistan Uncut sample bank", 2)
body("Infantry — Urdu")
quote_line("Hazir hain, sir.", "Present, sir.", "SELECT")
quote_line("Chalo bhai, nikalte hain.", "Come on brother, we move.", "MOVE")
quote_line("Maar saale ko.", "Kill the bastard.", "ATTACK")
quote_line("Madarchod, fire aa raha hai!", "Motherfucker, incoming!", "UNDER FIRE")
quote_line("Kaminey, tank!", "You scoundrel, tank!", "UNDER FIRE")
quote_line("Ammi se keh dena...", "Tell Ammi…", "DEATH")
quote_line("Chai ke baghair yeh fauj ruk jaaye.", "Without tea this army would stop.", "IDLE")

body("JF-17 pilot")
quote_line("Thunder. Lock tight.", "Thunder. Lock tight.", "SELECT")
quote_line("PL laga, bhenchod utra.", "PL on him, the sisterfucker is down.", "ATTACK")

body("Major Bilal")
quote_line("Sher. Short net.", "Sher. Short net.", "SELECT")
quote_line("Yeh dharti meri hai. Tum mehman ho.", "This ground is mine. You are guests.", "ATTACK")
quote_line("Bas kar harami. Ab fire chalegi.", "Enough, bastard. Fire runs now.", "UNDER FIRE")

# ===================== IRAN =====================
h("5. Iran — Artesh / IRGC fused kit (playable as one faction)", 1)
body("Doctrine: The worst conventional air force of the nine, on purpose. Compensation is industrial: drones that cost nothing, SRBMs that keep coming, dispersed TELs that pack up, and a SAM belt (Bavar / Khordad / Sayyad) that is dangerous until someone spends the air to break it. Playstyle is ‘death by a thousand cuts’ plus one big Fateh/Zolfaghar rain. If Iran wins a fair F-16 dogfight against a Rafale, the designer has failed.")
body("Unique mechanic — SWARM + DISPERSE: Shahed-136 flavour one-way drones are built from a cheap Workshop, not the airfield. They do not return. TELs that fire a ballistic shot can PACK in 8 seconds and look like trucks until they unpack. Killing the Workshop matters more than killing one drone. This is the opposite of Israel’s ‘expensive intercept’ fantasy — it is the reason Iron Dome exists on the other side of the ladder.")
body("Hero — SARTIP-E DOVOM REZA ‘KOUH’ MORADI: Quds-adjacent commando fantasy kept generic (no real org branding). Mountain bonus. Can plant a beacon for one Fateh shot into fog. Voice: Tehran Persian, tight, then filthy.")
body("Superweapon — RAAD-E FATH: mixed Fateh-110 / Zolfaghar / Shahed-136 saturation on a large radius. Buildings burn, infantry die, tanks are hurt not deleted. Interceptable by Iron Dome, Patriot, S-400, Siper, Akash — this is the rock-paper of the roster. Late: Fattah-flavour hypersonic that is HARDER to intercept but tiny radius. Still conventional. No nuclear option, ever.")
body("Colour: desert tan + green-white-red trim used lightly. IRGC and Artesh are fused into one kit so the player is not managing two tech trees.")

h("Iran v1 roster", 2)
add_table(
    ["Unit", "Real anchor", "Role / ability"],
    [
        ["Basij / regular infantry", "Artesh infantry", "Cheap. Ability: RPG. Entrench."],
        ["Takavar / Saberin flavour", "SF", "SF. Stealth."],
        ["Toophan / Dehlavieh team", "TOW copy / Kornet copy", "AT."],
        ["Boragh / BTR flavour", "Boragh APC", "Cheap taxi."],
        ["T-72S / T-72M", "T-72", "Main cheap tank."],
        ["Karrar", "Karrar (T-72 deep rebuild)", "Best Iranian tank. Still not a Merkava or Altay."],
        ["M-46 / Raad SPG", "towed + Raad-1/2", "Artillery."],
        ["Fajr-5 / Zelzal", "heavy rockets", "MLRS. Inaccurate, big."],
        ["Fateh TEL", "Fateh-110 family", "Tactical ballistic. Packs up. Identity unit."],
        ["Khordad-15 / 3rd Khordad", "Khordad family", "Mid SAM. Killed drones and the odd jet."],
        ["Bavar-373 battery", "Bavar-373", "Long SAM. Not quite S-400. Still scary."],
        ["Tor / Herz-9 / Zaer", "point AA", "Short AA vs drones."],
        ["Mi-28 (few) / AH-1 Cobra leftover", "Mi-28 reported + old Cobras", "Helo. Thin."],
        ["Shahed-129 / Mohajer-6", "ISR/strike UAV", "Reusable drone. Light bombs."],
        ["Shahed-136 (one-way)", "Shahed-136", "Kamikaze. Built at Workshop. THE unit."],
        ["Karrar UCAV (jet)", "Karrar drone", "Fast one-way or light strike."],
        ["F-14 leftover / HESA Kowsar / Saeqeh", "aging fighters + copies", "Poor air-to-air. Use as interceptors only if the enemy is careless."],
        ["Su-24 / MiG-29 leftover", "legacy strike/fighter", "Thin, expensive to replace."],
        ["Nasr / Ghader coastal", "anti-ship missiles", "Coastal defence structure + truck."],
        ["Ghadir / Fateh-class mini-sub flavour", "midget + Fateh sub", "Navy denial, not a Hangor."],
    ],
)
note("Iran’s air units are intentionally few and fragile. If testers complain ‘Iran has no air’, point them at the Workshop. If testers win air superiority with Kowsars against F-35s, hotfix the Kowsar.")

h("Iran Uncut sample bank", 2)
body("Infantry — Persian")
quote_line("Amadeam, farmandeh.", "I'm ready, commander.", "SELECT")
quote_line("Harekat konim.", "Let's move.", "MOVE")
quote_line("Bekosh taharesho, pedarsag.", "Kill that one, you father-dog.", "ATTACK")
quote_line("Kiram tu in jang. Tank!", "Fuck this war. Tank!", "UNDER FIRE")
quote_line("Kesafat-ha mizanamun!", "The filth are hitting us!", "UNDER FIRE")
quote_line("Be madaram begu...", "Tell my mother…", "DEATH")
quote_line("Chai ko? In jang bi-chai nemishe.", "Where's the tea? This war doesn't work without tea.", "IDLE")

body("Shahed workshop crew")
quote_line("Kargah amadeh. Parvaz yek-tarafeh.", "Workshop ready. One-way flight.", "SELECT")
quote_line("Bisto chahar ta. Beran ta anja.", "Twenty-four of them. Let them go there.", "ATTACK")
quote_line("Yeki oftad. Dah ta dige poshtesh-an.", "One fell. Ten more are behind it.", "UNIT LOST")

body("Fateh TEL")
quote_line("Fateh. Jolo nemimunim.", "Fateh. We don't stay in front.", "SELECT")
quote_line("Shelik. Pack kon. Fouri.", "Fire. Pack. Now.", "ATTACK / DISPERSE")

body("Hero Reza")
quote_line("Kuh. Kutah harf bezan.", "Kuh. Speak short.", "SELECT")
quote_line("In kuh mal-e maast. Shoma mehman-e bad-id.", "This mountain is ours. You are bad guests.", "ATTACK")
quote_line("Pedarsag, be-hem nazar nakon. Be asemun nazar kon.", "Father-dog, don't look at me. Look at the sky.", "UNDER FIRE")

h("6. Maps added for the new factions", 1)
add_table(
    ["Map", "Biome", "Who it flatters"],
    [
        ["Hatay Ridge", "Scrub highland + olive + border road", "Turkey commando + drones"],
        ["Aegean Tooth", "Islands + short sea", "MİLGEM vs Sa’ar vs Hangor"],
        ["Negev Glass", "Open south + small towns", "Merkava + Dome vs Fateh rain"],
        ["Coastal Plain", "Dense built-up + highway", "Namer / Eitan urban"],
        ["Thar Line", "Sand + canal + border posts", "India vs Pakistan classic"],
        ["Chenab Fork", "River + fields + towns", "Crossings, BrahMos lanes"],
        ["High Pir", "Highland / valley (fictionalised)", "Elevation, light tanks, helos"],
        ["Zagros Door", "Mountain pass + dam", "Iran disperse + Turkey drones"],
        ["Strait Latch", "Narrow water + batteries", "Anti-ship festival"],
        ["Two Plains", "4v4 mixed", "Ladder bowl for mixed nines"],
    ],
)
body("Do not name maps after real massacre sites, real shrines, or real nuclear plants. Fictionalise. ‘Two Mosques Crossing’ from v0.1 stays fictional.")

h("7. Campaign additions (short)", 1)
body("Each new faction gets a 6-mission mini-campaign, not a 7-mission epic, so writing does not explode. Same Al-Mizan month.")
bullet("Turkey — ‘KIRMIZI İZ’: drones over a highland border; a MİLGEM must keep a sea lane; finale is a Siper vs cruise-missile night.")
bullet("Israel — ‘KOVAH BARZEL’: first missions are intercept-the-rain, not tank rushes. Finale is an Adir package on an Al-Mizan bunker, not a city.")
bullet("India — ‘TRISHUL WARD’: a two-front tutorial without naming the neighbour as a campaign villain in text (the player already knows). BrahMos lane tutorial is mission 3.")
bullet("Pakistan — ‘GHAZWA ZERO’: first-strike timing school. Hangor mission on a coast. Finale is survive the second volley.")
bullet("Iran — ‘BARAN’: workshop and TEL dispersal school. If the player builds a fighter deathball they lose. Finale is a rain that must land before Domes/Patriots come up.")
body("Shared finale from v0.1 grows a third mission if any Wave 3 campaign is complete: nine tents, one map, still no speech longer than twenty seconds.")

h("8. Balance notes across all nine", 1)
bullet("Air quality tier (rough): F-35I > Rafale / F-15SA / F-15I / J-10C > F-16 family / Su-30 / MiG-29M / JF-17 III > Tejas / F-4 / Mirage leftover > Iranian copies.")
bullet("Tank quality tier (rough): Merkava IV Trophy / M1A2S / Leclerc ≈ Altay T1 > T-90 family / Al-Khalid / Haider / M1A1 > Karrar / M60T / Arjun (great gun, bad legs) > T-72 / Al-Zarrar / M60A3.")
bullet("AA umbrella tier: Israel Iron Layer > Algeria S-400 / India S-400 > Saudi Patriot / Turkey Siper / Iran Bavar > everyone else’s mid SAM.")
bullet("Drone tier: Turkey reusable mesh > Iran disposable swarm > Israel/UAE/Saudi ISR birds > others.")
bullet("Missile rain tier: Iran saturation > Pakistan Babur stack > India BrahMos precision > Turkey Tayfun / Egypt October / Saudi Crescent.")
bullet("If a matchup is 70/30 after a month of ladder, change costs not identities.")

h("9. Voice production add-on", 1)
add_table(
    ["Faction", "Language", "Casting note", "Uncut watch-outs"],
    [
        ["Turkey", "Turkish", "Western + Black Sea extras. Not cartoon Ottoman.", "Standard profanity is fine. No ethnic slurs (Kürt, Ermeni, Rum used as insults)."],
        ["Israel", "Hebrew (some Arabic radio chatter as colour only)", "Sabra officers + one Russian-accent extra if you want flavour.", "No slurs against Arabs as a people. Enemy combatants can be sworn at as combatants. No religious punchlines."],
        ["India", "Hindi + Indian English", "North + one South voice in air. Do not do a mock accent in English VO.", "Madarchod/bhenchod are army-common. No communal slurs."],
        ["Pakistan", "Urdu + Punjabi snap", "Punjab belt + one Pashto-colour NCO if you can cast it.", "Same as India on communal slurs. Zero."],
        ["Iran", "Tehran Persian", "Get Iranian or Afghan-Dari-aware actors who can do Tehrani.", "No ethnic slurs (Arab, Baluch, Kurd as insults). Pedarsag is the workhorse."],
    ],
)
body("Tea-idle lines are deliberate. Four cultures on this roster treat tea as a system. Keep them. Players will quote them.")

h("10. Legal / ratings / store page", 1)
bullet("PEGI 18 / ESRB M remains correct the moment Uncut Hebrew, Turkish, Hindi, Urdu and Persian are in the build.")
bullet("Store text: ‘Nine regional armed forces. Equipment abstracted from public reporting. All stories fictional.’")
bullet("Do not ship real news footage in trailers.")
bullet("Israel and Iran will generate press. The answer is always: they are RTS factions with public kits, the antagonist is Al-Mizan, nukes are off, civilians are not a resource.")
bullet("India and Pakistan will generate forum wars. Mirror matches and a clean referee (no campaign text that declares a winner of a real war) are the fix.")

h("11. What the developer should do this week", 1)
bullet("Keep Wave 0 as Egypt vs Algeria. Do not start modelling an F-35.")
bullet("Add nine rows to the planned stat sheet, even if Wave 3 units are grey cubes.")
bullet("Commission concept silhouettes only: TB2, Merkava IV, T-90 Bhishma, JF-17, Shahed-136, Fateh TEL, F-35I, Altay, BrahMos truck. Ten images. That is enough to feel the roster.")
bullet("Hire a Turkish and a Persian voice tester before you write 400 more lines — the banks above are seeds, not the session list.")
bullet("Update the one-pager pitch: ‘Nine armies of the East, four of them Arab, all of them themselves.’")

h("12. Closing", 1)
body("The original game was an Arabic war game. It still is, at the centre. The five additions make the ladder a region instead of a peninsula. That is a bigger product and a bigger argument. Hold the fence from v0.1: published kits, no nukes, no living politicians, no sectarian slurs, Uncut behind a slider, slice before spectacle.")
body("If the slice is still Egypt’s Kornet versus Algeria’s TOS, the new five will have a game to walk into. If it is not, they will just be five more unfinished tech trees.")

p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("— END OF GDD v0.2 ADDENDUM —")
set_run_font(r, size=12, bold=True, color=(0x1A, 0x3A, 0x2A))

p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("Pair this file with ASH-SHARQ_Desert_Command_GDD_v0.1.docx. Next: the nine-faction stat sheet.")
set_run_font(r, size=10, italic=True, color=(0x55, 0x55, 0x55))

out = "/home/workdir/artifacts/ASH-SHARQ_GDD_v0.2_Regional_Powers_Addendum.docx"
doc.save(out)
print("Wrote", out)

# MCA v0.3.5 — PLAYTEST & GENRE BENCHMARK REPORT
Method: full data extraction from MCA(1).html, diff vs v0.3.4, effective-DPS
combat math (counter matrix x armor multipliers), cost-equal Lanchester
battle sims, economy pacing model. Benchmarks: C&C Generals, OpenRA,
Age of Empires II, StarCraft II.

## 0. Changelog v0.3.4 -> v0.3.5
Code-only release: zero stat/knob/data changes. New: clickable under-attack
alert stack (top-right). Good direction — keep going on game-feel features.

## 1. CRITICAL BALANCE FINDINGS (with numbers)

### 1.1 AT-infantry swarm deletes tanks (fix first)
Cost-equal sims, no micro, focus fire:
  5x M1A2S Abrams (9000cr) vs 22x Kornet teams (8800cr) -> Kornets win 20-0 in 7.3s
  10x Bradley (8500cr)     vs 22x Kornet teams (8800cr) -> Bradleys win, 6 survive
Why: counter matrix AT inf -> MBT = 1.8 and knob ATGMVsArmor = 1.8 stack on top
of already-good base damage. Kornet = 106 effective DPS/1000cr vs heavy armor;
best MBT is ~30. The counter-chain EXISTS (IFV beats AT inf) but MBT players
have no room to breathe — one missed escort and 9k of armor evaporates.
FIX: counterMatrix AT inf->MBT 1.8 -> 1.45; keep ATGMVsArmor 1.8.
ACCEPTANCE RETEST: 5 MBTs vs cost-equal Kornets should leave ~4-8 Kornets dead
and 1-2 MBTs alive (tanks favored but punishable).

### 1.2 Anti-air triangle is healthy — do not touch
  25x Igla teams (8750cr) beat 5x Apaches (8000cr) 25-0 in 4.4s
  5x F-15SA (11000cr) beat 5x Apaches 5-0 in 10.9s
  5x Apaches beat 5x Abrams 5-0 in 28.5s (helo > tank is fine; AA > helo)
Helo vs tank at zero loss is slightly generous but acceptable given how hard
cheap MANPADS counter it. OPTIONAL: reduce Helo->MBT 1.35 -> 1.25.

### 1.3 Economy outpaces production after minute ~2 (nominal math)
OilIncomePerField = 35 cr/s; StartCredits = 10000.
  Kornet 400cr = 11.4s of ONE field's income (build time 12s)
  Abrams 1800cr = 51s      INS Vikrant 6000cr = 171s
  Opening (Power+Depot+Barracks = 1900) leaves 8100 -> entire tier-1+2
  (War Factory 2000 + Airfield 1800 + Tech 1500) is affordable INSTANTLY.
In genre terms: you start with ~4 bases of income and no real opening choice.
C&C Generals/AoE2/SC2 all gate the mid-game behind a real economic ramp.
FIX (after measuring EFFECTIVE rate — harvester travel time may already
reduce it; log credits at 60s and 180s in a test match):
  If effective >= 25 cr/s/field: OilIncomePerField 35 -> 16, StartCredits
  10000 -> 6000. Target: tier-2 unit costs 45-75s of one-field income;
  opening spend >= 40% of start cash.

### 1.4 Anti-infantry gaps: Egypt & India rosters
Aggregate DPS/1000cr vs Soft: Egypt 2.05, India 1.58 (rest of field: 3.3-7.0).
India relies on Pinaka/BMP-2; Egypt on M60 canister flavor text with no stat.
Both factions feel helpless vs massed rifles/technical rushes.
FIX: MBT->Infantry matrix 1.3 -> 1.45 (helps everyone, Egypt most), and give
Egypt's M1A1 SA its 'Canister switch' as real stats: inf dmg 20 -> 26.

### 1.5 Faction power spread (aggregate, DPS/1000cr)
  antiArmor: Iran 4.6 (by design - swarm), Egypt 5.9, Algeria 5.7 ... India 7.0
  antiAir:   Pakistan 0.15 (no intercept by design), Egypt 0.25, Iran 0.19
Spread looks intentional EXCEPT 1.4. Pakistan's air gap is a big weakness in
2v2 — compensate: Babur WINDOW stack mechanic already does; fine.

## 2. GENRE BENCHMARK (Generals / OpenRA / AoE2 / SC2)
PRESENT (good): attack-move, control groups, rally points, superweapons w/
  charge timer, faction abilities, counter matrix, engineer capture, MCV
  rebuild, harvester economy, 6 maps, 2v2 AI ally, 1x/2x/4x, pause, alerts.
MISSING — standard for the genre, ordered by impact:
  FOG OF WAR (biggest gap; RTS without it is a puzzle, not a duel)
  Unit stances: aggressive / defensive / hold-ground / hold-fire
  Shift-queued waypoints + patrol
  Unit separation (soft anti-clumping push) — blobs currently stack
  Idle-worker / idle-engineer hotkey + alert
  Always-on health bars option
  Production queue spanning selected buildings (Generals-style)
  Difficulty levels (Easy/Normal/Hard) for the AI
  End-of-match score screen (kills, credits earned, time, unit losses)
  Sound: WebAudio procedural engine hums, weapon cracks, explosion thumps —
         zero asset files needed, massive feel upgrade
  Neutral capturable structures on maps (Generals' oil derricks) —
         engineers can already capture; just place neutral depots on maps
  Minimap ping synced with the new alert banners (0.3.5 added the banner,
         add the ping)

## 3. PRIORITIZED BACKLOG FOR KIMI CODE
P0 (balance/feel, do now):
  1. counterMatrix AT inf->MBT 1.8 -> 1.45 (retest per 1.1 acceptance)
  2. counterMatrix MBT->Infantry 1.3 -> 1.45; M1A1 SA inf dmg 20 -> 26
  3. Economy pass per 1.3 (measure first, then halve if confirmed)
  4. Minimap ping on under-attack alert (completes the 0.3.5 feature)
P1 (genre parity):
  5. Fog of war (shroud on unexplored + dim on not-visible; vision = unit sight)
  6. Stances + shift-queued waypoints + patrol
  7. Unit separation steering
  8. Idle-worker/engineer key + alert banner
  9. Difficulty levels + end-of-match score screen
  10. WebAudio procedural SFX (engine loop, shot, boom, UI click)
P2 (delight):
  11. Veterancy chevrons in unit selection panel (VetDmgBonus/EliteHPBonus exist)
  12. Neutral capturable derricks on existing 6 maps
  13. Team colors in 2v2, save/load, small screen shake on big kills

## 4. TECHNICAL NOTES
  - Integrate MCA_ArtPack_v2 sprites per the earlier brief (atlas loader).
  - If entity count grows: spatial hash grid for target acquisition,
    object pooling for projectiles/effects, fixed-timestep sim.

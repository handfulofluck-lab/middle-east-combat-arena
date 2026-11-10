// Theme / tagline / briefing metadata for the maps that pre-date mapgen-v3.
// generate.mjs merges these into the legacy JSON files WITHOUT touching name,
// size, terrain, oil or spawns. A `briefing` here is only used when the map
// has none of its own (existing briefings are kept verbatim).
//
// Time of day is kept to dawn / day / golden for every legacy map: the two
// dusk / night slots of the pack belong to Qal'at Nusur and Strait of Lanterns.
const T = (biome, tod, weather) => ({ biome, tod, weather });

export const LEGACY_META = {
  // ---- listed in manifest.json ----
  sinai: {
    theme: T('coast', 'golden', 'clear'),
    tagline: 'A desert wedge between two gulfs.',
  },
  jerusalem: {
    theme: T('coast', 'day', 'clear'),
    tagline: 'Coastal plain, inland sea, one long front.',
  },
  arabia: {
    theme: T('dunes', 'day', 'dust'),
    tagline: 'The sand heartland between two shores.',
  },
  gulf: {
    theme: T('coast', 'day', 'haze'),
    tagline: 'The whole Gulf, from river mouth to strait.',
  },
  redsea: {
    theme: T('coast', 'golden', 'haze'),
    tagline: 'A long sea corridor, pinched shut in the south.',
  },
  maghreb: {
    theme: T('coast', 'day', 'clear'),
    tagline: 'Two continents, one strait between them.',
  },
  anatolia: {
    theme: T('steppe', 'dawn', 'clear'),
    tagline: 'A high plateau ringed by three seas.',
  },
  indus: {
    theme: T('delta', 'golden', 'haze'),
    tagline: 'A river valley running down to the sea.',
  },
  gulfstates: {
    theme: T('coast', 'dawn', 'haze'),
    tagline: 'Two shores strangled at a single strait.',
  },
  bab_el_mandeb: {
    theme: T('coast', 'day', 'haze'),
    tagline: 'The narrow gate between two seas.',
    briefing: 'A diagonal strait divides two shores, striped with reefs toward the far corners. Whoever commands the channel decides who is allowed to cross it.',
  },
  nile_delta: {
    theme: T('delta', 'dawn', 'haze'),
    tagline: 'River branches fanning out to the sea.',
    briefing: 'Two river branches fan north to the sea and cut the plain into a central wedge with a bank on either side. Fight for the wedge, or go around it by water.',
  },
  cyprus_levant: {
    theme: T('coast', 'golden', 'clear'),
    tagline: 'Broad land, three deep bays.',
    briefing: 'Open ground broken by three deep bays and a scatter of small harbours. Armies own the land between them; navies raid out of every bay.',
  },
  zagros_pass: {
    theme: T('highland', 'day', 'clear'),
    tagline: 'A bare high valley with one prize in the middle.',
    briefing: 'A bare high valley: four corner bases and a single oil field at the crossroads. Nothing blocks the approach, so scouting and speed matter more than walls.',
  },
  kyzylkum_steppe: {
    theme: T('steppe', 'day', 'dust'),
    tagline: 'Flat steppe running down to an inland sea.',
    briefing: 'Flat steppe that runs down to an inland sea in the north-west corner. Wide open tank country where oil is scarce and unevenly spread.',
  },
  arabian_sea_convoy: {
    theme: T('coast', 'day', 'clear'),
    tagline: 'Five islands, open water, no land route.',
    briefing: 'Five islands in open water with no land route between them. Fleets and air wings decide everything; each island has room for one base and little else.',
  },
  // ---- on disk but not in the manifest (tests, tutorials, QA scenarios) ----
  duel: {
    theme: T('redrock', 'golden', 'clear'),
    tagline: 'One ridge, one gap, two commanders.',
    briefing: 'Open desert split by a broken diagonal ridge with a wide gap in the middle. A fast one-on-one with a neutral oil field waiting on each flank.',
  },
  coast: {
    theme: T('coast', 'day', 'clear'),
    tagline: 'Four corners and a southern sea.',
    briefing: 'Open desert bounded by a southern sea and two thin wadis. Four corner bases, with two oil fields in the centre worth fighting for.',
  },
  tigris: {
    theme: T('oasis', 'dawn', 'haze'),
    tagline: 'One river down the middle, two fords across.',
    briefing: 'A river runs down the middle of the map, broken by two fords, and thin channels wall in each corner base. Take a crossing and keep it.',
  },
  hormuz: {
    theme: T('coast', 'day', 'haze'),
    tagline: 'Six bases across a shipping channel.',
    briefing: 'A shipping channel cuts the map in half and three narrow canals run north to south. Six bases face each other across the water in three lanes.',
  },
  rubalkhali: {
    theme: T('dunes', 'golden', 'dust'),
    tagline: 'Six bases around an empty sea of sand.',
    briefing: 'Six bases ring an empty sea of sand with nothing to hide behind. Pure open-field armour and air warfare, with two oil fields waiting in the dead centre.',
  },
  blockade: {
    theme: T('coast', 'golden', 'haze'),
    tagline: 'A strait, three islands, guns on both shores.',
  },
  golan: {
    theme: T('highland', 'golden', 'clear'),
    tagline: 'Open desert below, rocky plateau above.',
  },
  suez: {
    theme: T('dunes', 'day', 'haze'),
    tagline: 'One canal, a few bridges, nowhere else to cross.',
  },
};

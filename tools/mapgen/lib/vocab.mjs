// Shared vocabulary for map metadata (generator, validator, README).
export const GENERATOR = 'mapgen-v3';
// legacy manifest maps after the economy repair pass (legacy_repairs.mjs)
export const LEGACY_GENERATOR = 'legacy-repaired';
export const BIOMES = ['dunes', 'coast', 'highland', 'oasis', 'steppe', 'saltflat', 'redrock', 'delta'];
export const TODS = ['dawn', 'day', 'golden', 'dusk', 'night'];
export const WEATHERS = ['clear', 'haze', 'dust'];
export const SYMMETRIES = ['rot2', 'rot4', 'mirrorX', 'mirrorY', 'mirrorXY', 'hex'];
export const TAGLINE_MAX = 60;
export const MAX_PLAYERS = 6;
// S: 1v1 maps (<= 160), M: 4-player maps (<= 208), L: 6-player maps
export const sizeClass = (w, h) => (Math.max(w, h) <= 160 ? 'S' : Math.max(w, h) <= 208 ? 'M' : 'L');

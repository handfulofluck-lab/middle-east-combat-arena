// Visual themes. A map may carry `theme: { biome, tod, weather }`; this module
// resolves that into one concrete "look": sun, sky, fog, terrain palette,
// water palette, grading. Colours are linear-ish sRGB hex — the renderer
// converts them.

const BIOMES = {
  dunes: {
    sandA: 0xd8b98c, sandB: 0xc6a274, sandC: 0xe9d2ae, rockA: 0x8f7258, rockB: 0x6e5644,
    scrub: 0x7d7a48, wet: 0x9a7b55, duneAmp: 1.0, duneScale: 1.0, rockStyle: 'mesa',
    props: { rocks: 0.6, shrubs: 0.25, palms: 0.05, trees: 0.0 }, veg: 0.08,
  },
  coast: {
    sandA: 0xdcc296, sandB: 0xc8a876, sandC: 0xefdcb8, rockA: 0x8a7a68, rockB: 0x675a4c,
    scrub: 0x6f8050, wet: 0xa48c66, duneAmp: 0.5, duneScale: 1.2, rockStyle: 'crag',
    props: { rocks: 0.5, shrubs: 0.5, palms: 0.5, trees: 0.1 }, veg: 0.22,
  },
  highland: {
    sandA: 0xcbb48e, sandB: 0xb89c74, sandC: 0xdcc9a6, rockA: 0x8a7f72, rockB: 0x665c53,
    scrub: 0x66703f, wet: 0x8a7658, duneAmp: 0.45, duneScale: 1.5, rockStyle: 'mountain',
    props: { rocks: 1.0, shrubs: 0.6, palms: 0.0, trees: 0.35 }, veg: 0.3,
  },
  oasis: {
    sandA: 0xdab786, sandB: 0xc9a06a, sandC: 0xecd2a8, rockA: 0x937458, rockB: 0x6f5644,
    scrub: 0x5f8a45, wet: 0x8d7a50, duneAmp: 0.7, duneScale: 1.0, rockStyle: 'mesa',
    props: { rocks: 0.4, shrubs: 0.7, palms: 1.0, trees: 0.1 }, veg: 0.4,
  },
  steppe: {
    sandA: 0xb5a57a, sandB: 0x9f9066, sandC: 0xc9bb92, rockA: 0x80766a, rockB: 0x5d564d,
    scrub: 0x7f8748, wet: 0x877a58, duneAmp: 0.35, duneScale: 1.8, rockStyle: 'crag',
    props: { rocks: 0.5, shrubs: 1.0, palms: 0.0, trees: 0.25 }, veg: 0.5,
  },
  saltflat: {
    sandA: 0xcdc3ae, sandB: 0xbcae95, sandC: 0xe0d8c6, rockA: 0x8d8073, rockB: 0x675d54,
    scrub: 0x8a8a66, wet: 0xb4a78e, duneAmp: 0.18, duneScale: 2.0, rockStyle: 'crag',
    props: { rocks: 0.4, shrubs: 0.15, palms: 0.0, trees: 0.0 }, veg: 0.04,
  },
  redrock: {
    sandA: 0xc99b78, sandB: 0xb48362, sandC: 0xdcb898, rockA: 0xa66a50, rockB: 0x7d4a3a,
    scrub: 0x7a7440, wet: 0x96684a, duneAmp: 0.55, duneScale: 1.1, rockStyle: 'mesa',
    props: { rocks: 0.9, shrubs: 0.35, palms: 0.0, trees: 0.08 }, veg: 0.1,
  },
  delta: {
    sandA: 0xc2ab7c, sandB: 0xa9925f, sandC: 0xd6c296, rockA: 0x7f7464, rockB: 0x5c5448,
    scrub: 0x56803e, wet: 0x7a6c48, duneAmp: 0.3, duneScale: 1.4, rockStyle: 'crag',
    props: { rocks: 0.3, shrubs: 0.9, palms: 0.9, trees: 0.3 }, veg: 0.6,
  },
};

// sun elevation/azimuth in degrees; intensities tuned for ACES + exposure 1
const TODS = {
  dawn: {
    sunEl: 14, sunAz: 105, sun: 0xffc9a0, sunI: 3.2, sky: 0x7fa6d6, horizon: 0xf6c9a8,
    ground: 0x8a6f58, hemiI: 0.75, fog: 0xdcc0ac, fogDensity: 0.0052, exposure: 1.0,
    shadow: 0.62, water: 0x2f6f8a, waterDeep: 0x123c56, tint: [1.03, 0.99, 0.96], stars: 0,
  },
  day: {
    sunEl: 52, sunAz: 140, sun: 0xfff3dc, sunI: 3.6, sky: 0x4f8fd8, horizon: 0xcfe0ee,
    ground: 0x9a8468, hemiI: 0.85, fog: 0xcfd9e2, fogDensity: 0.0036, exposure: 0.95,
    shadow: 0.55, water: 0x1f86a6, waterDeep: 0x0b3f63, tint: [1.0, 1.0, 1.0], stars: 0,
  },
  golden: {
    sunEl: 24, sunAz: 235, sun: 0xffe0be, sunI: 3.3, sky: 0x3a6fc4, horizon: 0xf0c9a0,
    ground: 0x8e735a, hemiI: 0.95, fog: 0xe6c7a4, fogDensity: 0.0042, exposure: 1.05,
    shadow: 0.6, water: 0x2a93a6, waterDeep: 0x0f4763, tint: [1.03, 1.0, 0.96], stars: 0,
  },
  dusk: {
    sunEl: 8, sunAz: 262, sun: 0xffa97a, sunI: 2.7, sky: 0x48589a, horizon: 0xee936a,
    ground: 0x5a4a58, hemiI: 0.8, fog: 0xa88688, fogDensity: 0.0058, exposure: 1.12,
    shadow: 0.66, water: 0x2a5878, waterDeep: 0x0e2a48, tint: [1.04, 0.96, 0.98], stars: 0.25,
  },
  night: {
    sunEl: 42, sunAz: 200, sun: 0x9db6ff, sunI: 1.75, sky: 0x0e1a3c, horizon: 0x263a6c,
    ground: 0x1a2038, hemiI: 0.7, fog: 0x18244a, fogDensity: 0.0042, exposure: 1.22,
    shadow: 0.7, water: 0x163a5c, waterDeep: 0x061426, tint: [0.86, 0.96, 1.16], stars: 1,
  },
};

const WEATHER = {
  clear: { fogMul: 0.8, haze: 0.0, dust: 0.0, clouds: 0.16 },
  haze: { fogMul: 1.3, haze: 0.5, dust: 0.12, clouds: 0.4 },
  dust: { fogMul: 2.1, haze: 0.8, dust: 1.0, clouds: 0.15 },
};

export function resolveTheme(map) {
  const t = (map && map.theme) || {};
  let biomeName = BIOMES[t.biome] ? t.biome : null;
  if (!biomeName) biomeName = guessBiome(map);
  const todName = TODS[t.tod] ? t.tod : 'golden';
  const weatherName = WEATHER[t.weather] ? t.weather : 'clear';
  const biome = BIOMES[biomeName];
  const tod = TODS[todName];
  const weather = WEATHER[weatherName];
  const el = tod.sunEl * Math.PI / 180;
  const az = tod.sunAz * Math.PI / 180;
  // direction TOWARD the sun
  const sunDir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  return {
    biomeName, todName, weatherName, biome, tod, weather, sunDir,
    fogDensity: tod.fogDensity * weather.fogMul,
    night: todName === 'night',
  };
}

function guessBiome(map) {
  if (!map || !map.terrain) return 'dunes';
  let water = 0, rock = 0;
  const n = map.terrain.length;
  for (let i = 0; i < n; i += 7) {
    const v = map.terrain[i];
    if (v === 2) water++; else if (v === 1) rock++;
  }
  const total = Math.ceil(n / 7);
  if (rock / total > 0.12) return 'highland';
  if (water / total > 0.18) return 'coast';
  return 'dunes';
}

export const THEME_BIOMES = Object.keys(BIOMES);
export const THEME_TODS = Object.keys(TODS);

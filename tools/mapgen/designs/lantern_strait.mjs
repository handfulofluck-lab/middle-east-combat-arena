// Strait of Lanterns — 4-player naval map.
// A cross-shaped inland sea separates four home islands. The only dry links
// are the narrow isthmuses at the four ends of the cross, so the land route
// to a neighbour is long, thin and inside gun range of the water, while every
// harbour opens on the same sea. Fleets are the short road here.
export default {
  id: 'lantern_strait',
  name: 'Strait of Lanterns',
  w: 208,
  h: 208,
  players: 4,
  symmetry: 'rot4',
  seed: 0x1a47e2,
  theme: { biome: 'coast', tod: 'night', weather: 'clear' },
  tagline: 'Four harbours, one sea. The fleet is the short road.',
  briefing: 'Four home islands face each other across a cross-shaped sea. By land the only links are the thin isthmuses at the ends of the straits, each a long march under naval guns; by water every harbour is minutes apart. Build a yard early, watch the lighthouse points, and never leave an isthmus unwatched.',
  tags: ['4p', 'ffa', '2v2', 'naval', 'archipelago', 'strait'],
  build(b, S) {
    const C = 104;
    const n = b.fbm(14, { octaves: 4 });
    const wx = b.fbm(40, { octaves: 2 }), wy = b.fbm(40, { octaves: 2 });
    const organic = (f, amp = 1.8, w = 4) => S.rough(S.warp(f, wx, wy, w), n, amp);

    // ---- the sea: central basin + four arms (rot4 copies of the north arm) ----
    b.water(organic(S.circle(C, C, 43), 2.4, 5));
    b.water(organic(S.capsule(C, C, C, 53, 23), 2.4, 5));
    // outer bight beyond each isthmus (scenery water: makes the isthmus a true causeway)
    b.water(organic(S.circle(C, -3, 20), 1.6, 3));
    // harbour bay cut into the home island from the north arm
    b.water(organic(S.ellipse(76, 52, 17, 7.5), 1.2, 2));

    // ---- lighthouse point: a spit reaching toward the middle of the sea ----
    b.land(S.rough(S.capsule(64, 64, 88, 88, 5.4, 4.2), n, 0.6));
    // sandbar islets out in the arms (scenery: no land route reaches them)
    b.land(organic(S.ellipse(C - 7, 66, 4.2, 6.5), 0.6, 1));

    // ---- rock ----
    b.rock(organic(S.circle(C, C, 5.2), 0.8, 1));                    // the Lantern
    b.rock(organic(S.circle(C + 6, 86, 3.0), 0.5, 1));               // sea stacks around it
    b.rock(organic(S.curve([[6, 70, 6], [14, 54, 7], [10, 36, 6]], 6), 1.6, 3));   // west shore hills
    b.rock(organic(S.ellipseDir(36, 78, 7, 4, 1, 0.4), 1.0, 2));
    b.rock(organic(S.circle(3, 3, 11), 1.4, 2));
    b.rock(organic(S.ellipseDir(60, 20, 6, 3.4, 1, 0.2), 0.9, 2));
    b.rock(organic(S.circle(84, 21, 3.6), 0.7, 1));                  // crag at the isthmus mouth

    b.spawn(55, 50, { pad: 8 });
    b.oilField(44, 43, 'start');
    b.oilField(49, 61, 'start');
    b.oilField(26, 24, 'natural');      // sheltered corner field
    b.oilField(87, 87, 'contested');    // lighthouse point: naval-exposed
    b.oilField(98, 24, 'contested');    // on the isthmus
    return { minWater: 40, minIsland: 50 };
  },
};

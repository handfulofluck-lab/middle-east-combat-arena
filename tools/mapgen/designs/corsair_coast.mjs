// Corsair Coast — 1v1 coastal map, half land and half sea.
// The western half is open water; both bases keep a harbour cove on it. On
// land a rocky spine splits the front into a coast road (short, but inside
// naval gun range the whole way) and a sheltered inland valley. The fat
// headland in the middle carries the best oil on the map and can only be
// held by whoever owns the water around it.
export default {
  id: 'corsair_coast',
  name: 'Corsair Coast',
  w: 160,
  h: 160,
  players: 2,
  symmetry: 'mirrorY',
  seed: 0xc0a57e,
  theme: { biome: 'coast', tod: 'day', weather: 'clear' },
  tagline: 'Half land, half sea. The fleet picks the winner.',
  briefing: 'Open sea fills the west and both bases have a harbour on it. The coast road is the quick way to the enemy but lies under naval guns from end to end, while the inland valley behind the spine is slow and safe. The headland oil belongs to whoever rules the water.',
  tags: ['1v1', 'coastal', 'naval', 'land-and-sea'],
  build(b, S) {
    const n = b.fbm(14, { octaves: 4 });
    const wx = b.fbm(40, { octaves: 2 }), wy = b.fbm(40, { octaves: 2 });
    const organic = (f, amp = 2.0, w = 5) => S.rough(S.warp(f, wx, wy, w), n, amp);

    // ---- sea: everything west of a wandering shoreline ----
    b.water(organic(S.halfPlane(66, 0, 1, 0), 2.4, 7));
    // harbour cove reaching in toward the base
    b.water(organic(S.ellipse(76, 27, 19, 7.5), 1.2, 2));
    // a second, open bay south of the natural
    b.water(organic(S.ellipse(68, 58, 11, 7), 1.4, 3));

    // ---- headland: a fat peninsula on the centre line ----
    b.land(organic(S.ellipse(47, 80, 16, 12), 1.6, 3));
    b.land(S.capsule(54, 80, 80, 80, 6.5));
    b.rock(organic(S.ellipse(34, 80, 3.4, 5.5), 0.6, 1));   // the lighthouse crag

    // ---- the spine and the east wall ----
    b.rock(organic(S.curve([[120, 46, 8], [113, 58, 11], [109, 70, 12], [108, 84, 12]], 11), 2.4, 4));
    b.rock(organic(S.curve([[160, 40, 7], [155, 56, 8], [157, 72, 9], [156, 84, 9]], 8), 2.0, 3));
    // cross-pass through the spine on the centre line (links both lanes)
    b.land(S.rough(S.capsule(92, 80, 150, 80, 3.8), n, 0.6));
    // cover on the coast road and around the bases
    b.rock(organic(S.ellipseDir(86, 62, 5, 3.4, 1, 1), 1.0, 2));
    b.rock(organic(S.circle(134, 34, 4.2), 1.0, 2));
    b.rock(organic(S.ellipse(126, 4, 12, 5), 1.4, 2));
    b.rock(organic(S.ellipse(80, 2, 9, 4), 1.2, 2));

    // sea stacks
    b.rock(organic(S.circle(22, 38, 3.4), 0.6, 1));
    b.rock(organic(S.ellipse(12, 66, 3, 4.4), 0.6, 1));
    b.rock(organic(S.circle(40, 18, 3), 0.6, 1));

    b.spawn(104, 26, { pad: 9 });
    b.oilField(113, 16, 'start');
    b.oilField(114, 36, 'start');
    b.oilField(82, 46, 'natural');      // coast natural: rich but exposed to the fleet
    b.oilField(142, 54, 'natural');     // inland natural: safe from ships
    b.oilField(44, 73, 'contested');    // headland
    b.oilField(138, 74, 'contested');   // inland wells at the cross-pass
    return { minIsland: 50 };
  },
};

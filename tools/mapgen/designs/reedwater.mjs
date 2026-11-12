// Reedwater Delta — 4-player river map.
// Two pairs of channels cut the plain into nine islands: a home island in each
// corner, four neutral islands between them (the north and south ones carry
// oil) and the big centre island. Every
// crossing is a ford — a lens of dry sandbar a few cells wide — so armies are
// funnelled and river gunboats can cover the fords they float beside.
export default {
  id: 'reedwater',
  name: 'Reedwater Delta',
  w: 192,
  h: 192,
  players: 4,
  symmetry: 'mirrorXY',
  seed: 0x4eed5a,
  theme: { biome: 'delta', tod: 'dawn', weather: 'haze' },
  tagline: 'Nine islands, twelve fords, no dry way round.',
  briefing: 'The river braids into nine islands. Your home island touches two channels, each crossed by a single narrow ford; beyond them lie the neutral islands, and beyond those the rich centre. Gunboats cannot leave their reach of river, but they can make a ford impassable.',
  tags: ['4p', 'ffa', '2v2', 'river', 'fords', 'riverine'],
  build(b, S) {
    const n = b.fbm(12, { octaves: 3 });
    const wx = b.fbm(36, { octaves: 2 }), wy = b.fbm(36, { octaves: 2 });
    const organic = (f, amp = 1.2, w = 4) => S.rough(S.warp(f, wx, wy, w), n, amp);

    // ---- channels (north-west quarter; mirrors make the rest) ----
    // north-south channel: map edge -> crossing -> the east-west centre line
    b.water(organic(S.curve([[54, -6, 5.2], [58, 12, 4.8], [50, 28, 5.6], [56, 44, 5], [58, 57, 6], [63, 72, 4.8], [55, 86, 5.2], [57, 100, 5]], 5, 10), 1.0, 3));
    // east-west channel: map edge -> crossing -> the north-south centre line
    b.water(organic(S.curve([[-6, 55, 5.2], [12, 51, 4.8], [28, 59, 5.6], [44, 53, 5], [58, 57, 6], [72, 62, 4.8], [86, 55, 5.2], [100, 57, 5]], 5, 10), 1.0, 3));
    b.water(organic(S.circle(58, 57, 8.5), 1.0, 2));               // confluence pool
    b.water(organic(S.ellipse(42, 33, 8, 7), 1.0, 2));             // harbour backwater by the base
    // reed ponds on the neutral islands and in the centre
    b.water(organic(S.ellipse(96, 30, 7, 4.5), 0.8, 2));
    b.water(organic(S.ellipse(30, 96, 4.5, 7), 0.8, 2));
    b.water(organic(S.circle(77, 77, 4.6), 0.8, 2));

    // ---- fords: dry strips across the channels ----
    b.land(S.rough(S.ellipse(56, 15, 15, 4.6), n, 0.8));     // home <-> north island
    b.land(S.rough(S.ellipse(15, 56, 4.6, 15), n, 0.8));     // home <-> west island
    b.land(S.rough(S.ellipse(96, 57, 6, 15), n, 0.8));       // north island <-> centre (on the centre line)
    b.land(S.rough(S.ellipse(57, 96, 15, 6), n, 0.8));       // west island <-> centre

    // ---- a little high ground: old river terraces and a tell in the middle ----
    b.rock(organic(S.circle(96, 96, 6.5), 1.0, 2));
    b.rock(organic(S.circle(2, 2, 9), 1.2, 2));
    b.rock(organic(S.ellipseDir(80, 12, 6, 3.2, 1, 0.3), 0.8, 2));
    b.rock(organic(S.ellipseDir(12, 80, 3.2, 6, 0.3, 1), 0.8, 2));

    b.spawn(26, 27, { pad: 8 });
    b.oilField(14, 21, 'start');
    b.oilField(20, 38, 'start');
    b.oilField(39, 10, 'natural');     // home natural, watching the north ford
    b.oilField(84, 21, 'contested');   // north / south neutral islands
    b.oilField(84, 84, 'contested');   // centre island
    return { minWater: 40 };
  },
};

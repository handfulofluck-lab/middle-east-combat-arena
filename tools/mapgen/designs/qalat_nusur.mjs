// Qal'at Nusur ("Fortress of Eagles") — 4-player king-of-the-hill.
// A ring-walled citadel plateau sits in the middle of the map with four oil
// fields inside and a single gate on each compass point, so every gate is
// shared by two neighbours. A broken outer rampart turns the ground between
// rampart and citadel into a ring road that all attacks must cross.
export default {
  id: 'qalat_nusur',
  name: "Qal'at Nusur",
  w: 192,
  h: 192,
  players: 4,
  symmetry: 'rot4',
  seed: 0x9a1a70,
  theme: { biome: 'highland', tod: 'dusk', weather: 'clear' },
  tagline: 'Four gates, one citadel. Hold the rock, hold the oil.',
  briefing: 'A walled plateau crowns the centre of the map with four oil fields inside it. Each of its four gates faces the ground between two bases, so no gate is ever yours alone. Take the citadel early and you must hold four doors; leave it and someone else gets rich.',
  tags: ['4p', 'ffa', '2v2', 'king-of-the-hill', 'fortress', 'land'],
  build(b, S) {
    const C = 96;
    const n = b.fbm(13, { octaves: 4 });
    const wx = b.fbm(30, { octaves: 2 }), wy = b.fbm(30, { octaves: 2 });
    const organic = (f, amp = 1.8, w = 3) => S.rough(S.warp(f, wx, wy, w), n, amp);
    const arc = (r, a0, a1, half, step = 6) => {
      const pts = [];
      for (let a = a0; a <= a1 + 0.01; a += step) pts.push(S.polar(C, C, r, a));
      return S.polyline(pts, half);
    };

    // ---- citadel: curtain wall + keep ----
    b.rock(organic(S.ring(C, C, 31, 7), 1.6, 2));
    b.rock(organic(S.circle(C, C, 4.6), 0.6, 1));
    // towers flanking the north gate (rot4 copies flank the other three)
    b.rock(organic(S.circle(C - 10, C - 37, 5.6), 0.8, 1));
    b.rock(organic(S.circle(C + 10, C - 37, 5.6), 0.8, 1));
    // ---- outer rampart: an arc centred on north, open on the diagonals ----
    b.rock(organic(arc(64, 242, 298, 5), 1.8, 3));
    // ---- outer ground ----
    b.rock(organic(S.ellipse(C, 3, 16, 7), 1.6, 3));               // mid-edge massif
    b.rock(organic(S.ellipseDir(70, 38, 6, 3.6, 1, -0.5), 1.0, 2)); // cover near the natural
    b.rock(organic(S.circle(44, 60, 4), 0.9, 2));
    b.rock(organic(S.circle(3, 3, 9), 1.4, 2));                    // corner crag behind the base
    b.rock(organic(S.ellipseDir(57, 57, 5.5, 3.2, 1, -1), 0.9, 2)); // butte in the rampart gap

    // ---- gates: one ~8-wide door on each compass point ----
    b.land(S.capsule(C, C - 47, C, C - 17, 4.0));

    b.spawn(29, 29, { pad: 11 });
    b.oilField(18, 24, 'start');
    b.oilField(25, 40, 'start');
    b.oilField(62, 17, 'natural');
    b.oilField(95, 18, 'contested');    // mid-edge field, equidistant from two neighbours
    b.oilField(85, 85, 'contested');    // inside the citadel
  },
};

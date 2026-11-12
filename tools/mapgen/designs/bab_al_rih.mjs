// Bab al-Rih ("Gate of the Winds") — 1v1 mountain-pass map.
// A granite range runs north-south between the two bases. Three ways through:
// the short central gate (a walled bowl with two oil fields inside the range)
// and one long pass near each end. Bases sit diagonally, so each player has a
// HOME pass guarded by their natural expansion and an AWAY pass that opens
// onto the enemy's — the two flank lanes are deliberately not equivalent.
export default {
  id: 'bab_al_rih',
  name: 'Bab al-Rih',
  w: 144,
  h: 144,
  players: 2,
  symmetry: 'rot2',
  seed: 0xba81a1,
  theme: { biome: 'highland', tod: 'golden', weather: 'clear' },
  tagline: 'Three passes through the range. One is a trap.',
  briefing: 'A granite range splits the valley in two. The central gate is the shortest road and hides two oil fields inside the mountain, but it is barely a column wide; the long passes at either end are slower, and each one opens straight onto a natural expansion.',
  tags: ['1v1', 'mountain-pass', 'chokepoints', 'land'],
  build(b, S) {
    const n = b.fbm(15, { octaves: 4 });
    const wx = b.fbm(34, { octaves: 2 }), wy = b.fbm(34, { octaves: 2 });
    const organic = (f, amp = 2.2, w = 4) => S.rough(S.warp(f, wx, wy, w), n, amp);

    // ---- the range: south half (north half is the 180-degree image) ----
    b.rock(organic(S.curve([[72, 60, 17], [71, 78, 17], [69, 94, 15], [66, 108, 15], [66, 122, 15], [69, 136, 15], [71, 152, 15]], 15), 2.6, 5));
    // buttresses: short spurs that give the range a ragged, ridged outline
    b.rock(organic(S.capsule(60, 96, 45, 102, 5.5, 2.8), 1.4, 3));
    b.rock(organic(S.capsule(78, 104, 93, 97, 5.5, 2.8), 1.4, 3));
    // hogback foothill west of the range: makes a north-south valley lane
    b.rock(organic(S.curve([[40, 62, 3.6], [44, 74, 4.6], [42, 86, 3.4]], 4), 1.3, 3));
    // shoulder ridge screening the main from the centre
    b.rock(organic(S.curve([[8, 82, 5], [20, 86, 4.2], [31, 85, 3.2]], 4), 1.4, 3));
    // mesas: cover on the open ground
    b.rock(organic(S.ellipseDir(30, 52, 7, 4.4, 1, 0.5), 1.2, 2));
    b.rock(organic(S.circle(52, 44, 4.4), 1.0, 2));
        // corner and edge massifs frame the valley
    b.rock(organic(S.circle(2, 2, 15), 2.4, 4));
    b.rock(organic(S.ellipse(0, 46, 6, 13), 1.8, 3));
    b.rock(organic(S.ellipse(100, 146, 13, 6), 1.8, 3));

    // ---- passes ----
    // home pass (south): a bent, ~10-wide corridor through the range
    b.land(S.rough(S.curve([[36, 128, 5.4], [50, 126, 4.4], [61, 121, 4.2], [73, 122, 4.2], [84, 117, 4.4], [100, 116, 5.4]], 4.4, 10), n, 0.7));
    // central gate: two ~7-wide doors into an oil bowl inside the range
    b.land(S.rough(S.curve([[74, 72, 3.7], [64, 73.5, 3.6], [56, 70.5, 3.8], [49, 72.5, 4.4]], 3.7, 10), n, 0.9));
    b.land(S.rough(S.ellipse(72, 72, 8, 14), n, 1.0));

    // ---- bases and oil ----
    b.spawn(22, 105, { pad: 11 });
    b.oilField(11, 111, 'start');
    b.oilField(27, 116, 'start');
    b.oilField(31, 134, 'natural');
    b.oilField(46, 136, 'natural');
    b.oilField(46, 21, 'natural');   // forward third at the mouth of the away pass
    b.oilField(71, 63, 'contested'); // inside the central bowl
  },
};

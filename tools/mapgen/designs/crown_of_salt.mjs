// Crown of Salt — 6-player ring map.
// A jagged salt dome fills the centre; nothing crosses it. Six bases sit in
// six bays around the ring, separated by rock teeth. Between neighbours there
// are exactly two doors: the wide inner gate beside the dome (with an oil
// field in it) and the narrow outer gate under the rim.
export default {
  id: 'crown_of_salt',
  name: 'Crown of Salt',
  w: 224,
  h: 224,
  players: 6,
  symmetry: 'hex',
  seed: 0xc40a5a,
  theme: { biome: 'saltflat', tod: 'day', weather: 'haze' },
  tagline: 'Six bays on a ring road. Two doors to every neighbour.',
  briefing: 'A salt dome blocks the centre, so every road runs around the ring. Each bay has a neighbour on either side and two ways to reach them: the wide inner gate with its oil field, or the narrow outer gate under the rim. There is no shortcut to the far side, only a long way round through somebody else\'s front yard.',
  tags: ['6p', 'ffa', '3v3', 'ring', 'chokepoints', 'land'],
  build(b, S) {
    const C = 112;
    const P = (r, a) => S.polar(C, C, r, a);
    const n = b.fbm(15, { octaves: 4 });
    const wx = b.fbm(34, { octaves: 2 }), wy = b.fbm(34, { octaves: 2 });
    const organic = (f, amp = 2.0, w = 3) => S.rough(S.warp(f, wx, wy, w), n, amp);
    const seg = (r0, a0, r1, a1, ra, rb) => { const p = P(r0, a0), q = P(r1, a1); return S.capsule(p[0], p[1], q[0], q[1], ra, rb); };

    // ---- rim: everything beyond the ring valley ----
    b.rock(S.rough((x, y) => 105 - Math.sqrt((x - C) * (x - C) + (y - C) * (y - C)), b.symFbm(20, { octaves: 4 }), 4.5), { sym: false });
    // ---- the dome and its six spikes (toward the gaps between bays) ----
    b.rock(organic(S.circle(C, C, 27), 2.2, 3));
    b.rock(organic(seg(22, 30, 42, 30, 7, 3.6), 1.4, 2));
    // ---- teeth between neighbouring bays ----
    b.rock(organic(seg(65, 30, 88, 30, 5.5, 6.5), 1.6, 2));
    // ---- cover inside each bay ----
    b.rock(organic(S.ellipseDir(...P(58, 0), 3.6, 7, 1, 0), 1.0, 2));     // shield in front of the base
    b.rock(organic(S.circle(...P(72, 16), 3.6), 0.8, 2));
    b.rock(organic(S.circle(...P(70, -17), 3.2), 0.8, 2));

    b.spawn(C + 83, C, { pad: 11 });
    b.oilField(C + 91, C + 7, 'start');
    b.oilField(C + 91, C - 7, 'start');
    const nat = P(82, 20);
    b.oilField(Math.round(nat[0]), Math.round(nat[1]), 'natural');
    const gate = P(53, 30);
    b.oilField(Math.round(gate[0]), Math.round(gate[1]), 'contested');   // inner gate
  },
};

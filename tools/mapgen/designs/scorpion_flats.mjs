// Scorpion Flats — small, fast 1v1 on an open salt pan.
// Two curved mesas (the claws) wrap the central wells so they can only be
// entered from the two neutral corners, never straight from a base. Short
// rush distance, little cover: a map for aggressive openings.
export default {
  id: 'scorpion_flats',
  name: 'Scorpion Flats',
  w: 128,
  h: 128,
  players: 2,
  symmetry: 'rot2',
  seed: 0x5c0b10,
  theme: { biome: 'saltflat', tod: 'dawn', weather: 'haze' },
  tagline: 'Small, flat and fast. The claws guard the wells.',
  briefing: 'A bare salt pan with almost nowhere to hide. Two curved mesas shield the central wells from both bases, so the oil has to be approached from the open corners. Expect contact inside two minutes.',
  tags: ['1v1', 'open', 'rush', 'land'],
  build(b, S) {
    const n = b.fbm(12, { octaves: 3 });
    const wx = b.fbm(26, { octaves: 2 }), wy = b.fbm(26, { octaves: 2 });
    const organic = (f, amp = 1.3, w = 2.5) => S.rough(S.warp(f, wx, wy, w), n, amp);

    // the claw: an arc from west of the centre round to the south
    b.rock(organic(S.curve([[44, 50, 3.4], [43, 62, 4.6], [49, 73, 5], [60, 79, 4.2], [68, 79, 3]], 4), 1.2, 2));
    // the sting: a mesa between each base and the middle
    b.rock(organic(S.ellipseDir(38, 90, 6.5, 3.6, 1, 1), 1.0, 2));
    // scattered buttes
    b.rock(organic(S.circle(70, 104, 3.6), 0.8, 2));
    b.rock(organic(S.circle(18, 62, 3.8), 0.8, 2));
    b.rock(organic(S.ellipseDir(30, 34, 5.5, 3.2, 1, -0.6), 0.9, 2));
    b.rock(organic(S.circle(96, 112, 3.2), 0.7, 1));
    // low rims in the two base corners
    b.rock(organic(S.ellipse(2, 126, 9, 6), 1.2, 2));

    b.spawn(21, 105, { pad: 11 });
    b.oilField(11, 98, 'start');
    b.oilField(28, 116, 'start');
    b.oilField(48, 114, 'natural');
    b.oilField(19, 20, 'contested');   // neutral corner
    b.oilField(58, 59, 'contested');   // the wells
  },
};

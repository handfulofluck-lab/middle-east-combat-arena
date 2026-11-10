// Kurgan Line — 4-player three-lane steppe map.
// Two long hill belts divide the grassland into a north lane, a centre lane
// and a south lane. Each base anchors one outer lane; the centre lane, with
// the great kurgan and its four oil fields, belongs to nobody. Gaps in the
// belts let a column switch lanes — or get cut off in the wrong one.
export default {
  id: 'kurgan_line',
  name: 'Kurgan Line',
  w: 200,
  h: 200,
  players: 4,
  symmetry: 'mirrorXY',
  seed: 0x6b7a11,
  theme: { biome: 'steppe', tod: 'day', weather: 'clear' },
  tagline: 'Three lanes of open steppe between two hill belts.',
  briefing: 'Two belts of low hills split the steppe into three lanes. Your base anchors an outer lane; the centre lane and the great kurgan at its heart are up for grabs. The gaps in the belts are few, so choose a lane, watch the crossings, and do not get caught between them.',
  tags: ['4p', '2v2', 'ffa', 'three-lane', 'open', 'land'],
  build(b, S) {
    const n = b.fbm(13, { octaves: 4 });
    const wx = b.fbm(32, { octaves: 2 }), wy = b.fbm(32, { octaves: 2 });
    const organic = (f, amp = 1.6, w = 3) => S.rough(S.warp(f, wx, wy, w), n, amp);

    // ---- north hill belt, west half (three overlapping ridges) ----
    b.rock(organic(S.curve([[36, 78, 4], [44, 73, 6], [52, 71, 6.4], [57, 72, 4.2]], 5.5), 1.5, 3));
    b.rock(organic(S.curve([[71, 69, 4.2], [77, 67, 6.2], [84, 69, 6.4], [90, 71, 4.6]], 5.5), 1.5, 3));
    // ---- the great kurgan and its outliers ----
    b.rock(organic(S.circle(100, 100, 8.5), 1.2, 2));
    b.rock(organic(S.circle(64, 100, 4.4), 0.9, 2));
    // ---- kurgans scattered over the lanes ----
    b.rock(organic(S.circle(62, 38, 4), 0.9, 2));
    b.rock(organic(S.ellipseDir(84, 46, 6, 3.4, 1, 0.4), 0.9, 2));
    b.rock(organic(S.circle(45, 22, 3.4), 0.8, 2));
    b.rock(organic(S.circle(100, 12, 5), 1.0, 2));
    b.rock(organic(S.ellipse(100, 44, 3.4, 5), 0.8, 2));
    // ---- backfield: a ridge between the two western bases ----
    b.rock(organic(S.curve([[0, 100, 6], [12, 96, 5.5], [24, 100, 4.5]], 5), 1.4, 3));
    b.rock(organic(S.ellipse(42, 92, 3.6, 6.5), 0.9, 2));
    b.rock(organic(S.circle(3, 3, 8), 1.2, 2));

    b.spawn(28, 44, { pad: 11 });
    b.oilField(17, 39, 'start');
    b.oilField(33, 55, 'start');
    b.oilField(22, 78, 'natural');      // backfield
    b.oilField(91, 28, 'contested');    // mid-lane
    b.oilField(88, 93, 'contested');    // around the great kurgan
  },
};

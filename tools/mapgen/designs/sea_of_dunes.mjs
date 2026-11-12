// Sea of Dunes — 6-player open desert.
// Almost no hard cover: a handful of mesas and barchan-shaped ridges on a
// wide sand sea, made for armour columns and air power. A ring of six wells
// circles the open centre, each one exactly between two bases.
export default {
  id: 'sea_of_dunes',
  name: 'Sea of Dunes',
  w: 240,
  h: 240,
  players: 6,
  symmetry: 'hex',
  seed: 0xd00e5e,
  theme: { biome: 'dunes', tod: 'golden', weather: 'dust' },
  tagline: 'Open sand in every direction. Bring armour and air.',
  briefing: 'A sand sea with six bases on its rim and nothing but a few mesas in between. Tanks can go anywhere and so can the enemy: there are no chokepoints to hide behind. Six wells ring the centre, each one midway between two neighbours.',
  tags: ['6p', 'ffa', '3v3', 'open', 'armour', 'air', 'land'],
  build(b, S) {
    const C = 120;
    const P = (r, a) => S.polar(C, C, r, a);
    const n = b.fbm(14, { octaves: 4 });
    const wx = b.fbm(30, { octaves: 2 }), wy = b.fbm(30, { octaves: 2 });
    const organic = (f, amp = 1.3, w = 3) => S.rough(S.warp(f, wx, wy, w), n, amp);
    // barchan: a disc with a bite taken out of its lee side
    const barchan = (r, a, size, toward) => {
      const [x, y] = P(r, a), [bx, by] = P(r + toward * size * 0.75, a);
      return S.subtract(S.circle(x, y, size), S.circle(bx, by, size * 0.92));
    };

    // ---- corner massifs frame the sand sea (4-way, not 6-way: off the play area) ----
    const corner = (x, y) => S.circle(x, y, 34);
    b.rock(S.rough(S.union(corner(0, 0), corner(240, 0), corner(0, 240), corner(240, 240)), b.symFbm(16, { octaves: 4 }), 4), { sym: false });

    // ---- mesas (each line is replicated six times) ----
    b.rock(organic(S.ellipseDir(...P(54, 30), 4.4, 9, ...P(1, 30).map((v) => v - C)), 1.2, 2)); // shield before each base
    b.rock(organic(S.circle(...P(76, 0), 6), 1.2, 2));        // on the neighbour-to-neighbour line
    b.rock(organic(barchan(30, 30, 7.5, -1), 0.8, 2));        // inner ring of barchans
    b.rock(organic(barchan(102, 0, 9, 1), 0.9, 2));           // outer barchans between bases
    b.rock(organic(S.circle(C, C, 6.5), 1.0, 2));             // the lone rock at the centre

    const sp = P(88, 30);
    const sx = Math.round(sp[0]), sy = Math.round(sp[1]);
    b.spawn(sx, sy, { pad: 11 });
    const o1 = S.polar(sx + 0.5, sy + 0.5, 10.5, 72), o2 = S.polar(sx + 0.5, sy + 0.5, 10.5, -12);
    b.oilField(Math.floor(o1[0]), Math.floor(o1[1]), 'start');
    b.oilField(Math.floor(o2[0]), Math.floor(o2[1]), 'start');
    const nat = P(92, 52);
    b.oilField(Math.round(nat[0]), Math.round(nat[1]), 'natural');
    const well = P(45, 0);
    b.oilField(Math.round(well[0]), Math.round(well[1]), 'contested');
  },
};

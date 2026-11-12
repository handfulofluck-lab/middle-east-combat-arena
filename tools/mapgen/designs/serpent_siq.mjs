// Serpent's Siq — 1v1 canyon maze.
// Solid red sandstone with a hand-laid network of slot canyons and chambers:
// an outer loop around the whole map, a central hub holding the contested
// oil, and side galleries that tie the two together. Nowhere is wider than a
// few tank lengths, so every junction is a potential ambush.
import { ROCK } from '../lib/grid.mjs';

export default {
  id: 'serpent_siq',
  name: "Serpent's Siq",
  w: 152,
  h: 152,
  players: 2,
  symmetry: 'rot2',
  seed: 0x51c0a7,
  theme: { biome: 'redrock', tod: 'day', weather: 'dust' },
  tagline: 'A sandstone labyrinth. Every corner is an ambush.',
  briefing: 'Slot canyons wind through solid sandstone between a handful of open chambers. Three routes lead to the enemy and none is wider than a tank platoon: scout the galleries, hold the junctions, and never commit down a canyon you cannot see the end of.',
  tags: ['1v1', 'canyon-maze', 'chokepoints', 'land'],
  build(b, S) {
    const n = b.fbm(10, { octaves: 3 });
    const wx = b.fbm(24, { octaves: 2 }), wy = b.fbm(24, { octaves: 2 });
    const cave = (f, amp = 1.0, w = 2.2) => S.rough(S.warp(f, wx, wy, w), n, amp);
    const canyon = (pts, r) => cave(S.curve(pts, r, 10), 0.6);
    b.fill(ROCK);

    // ---- chambers ----
    b.land(cave(S.ellipse(26, 127, 22, 17), 1.6));       // main
    b.land(cave(S.ellipse(62, 134, 13, 10), 1.4));       // natural
    b.land(cave(S.ellipse(98, 137, 11, 8), 1.2));        // south gallery (third)
    b.land(cave(S.circle(132, 131, 9), 1.2));            // far corner chamber
    b.land(cave(S.ellipse(38, 70, 11, 10), 1.2));        // west gallery
    b.land(cave(S.circle(48, 100, 6.5), 1.0));           // junction
    b.land(cave(S.circle(73, 107, 5.5), 1.0));           // junction
    b.land(cave(S.ellipseDir(76, 76, 15, 10, 1, -1), 1.4)); // central hub

    // ---- canyons (the 180-degree images close the loop) ----
    b.land(canyon([[40, 130], [50, 134], [61, 134]], 4.6));                     // main -> natural
    b.land(canyon([[70, 136], [80, 143], [90, 139], [98, 137]], 3.9));          // natural -> south gallery
    b.land(canyon([[106, 138], [116, 143], [124, 136], [132, 131]], 3.8));      // south gallery -> corner
    b.land(canyon([[20, 114], [16, 100], [22, 88], [15, 70], [19, 52], [15, 38], [21, 22]], 3.8)); // back door
    b.land(canyon([[36, 116], [42, 108], [48, 100], [58, 92], [66, 84]], 4.0)); // main -> hub
    b.land(canyon([[62, 124], [66, 114], [73, 107], [77, 96], [76, 86]], 3.8)); // natural -> hub
    b.land(canyon([[19, 74], [28, 72], [38, 70]], 3.7));                        // back door -> west gallery
    b.land(canyon([[40, 78], [41, 88], [48, 100]], 3.7));                       // west gallery -> junction
    // cross-canyon: this stub and the 180-degree image of the next one meet in a
    // small chamber, joining each south gallery to the enemy's side gallery
    b.land(canyon([[98, 130], [103, 120], [99, 110]], 3.7));
    b.land(cave(S.circle(99, 108, 5), 0.8));
    b.land(canyon([[45, 64], [54, 58], [58, 49]], 3.7));
    b.land(cave(S.circle(58, 47, 5), 0.8));

    // pillars inside the big chambers
    b.rock(cave(S.circle(32, 119, 2.8), 0.5, 1));
    b.rock(cave(S.ellipseDir(76, 76, 4.2, 2.6, 1, 1), 0.5, 1));

    b.spawn(25, 128, { pad: 10 });
    b.oilField(14, 122, 'start');
    b.oilField(32, 139, 'start');
    b.oilField(58, 137, 'natural');
    b.oilField(100, 138, 'natural');
    b.oilField(36, 68, 'natural');
    b.oilField(68, 84, 'contested');
    return { minRock: 12, minIsland: 40 };
  },
};

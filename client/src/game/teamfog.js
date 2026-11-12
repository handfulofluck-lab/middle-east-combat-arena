// Vision the local player is entitled to: their own sight plus that of every
// ally. The simulation keeps one fog grid per player; teammates share sight
// on the presentation side only (the sim's own fog checks stay per player,
// so nothing here can affect lockstep).
//
// teamFog(game, st) -> { visible, seen } (Uint8Array per map cell), cached
// per simulation tick. With no allies it is the player's own grid, unmerged.

let cacheState = null;
let cacheTick = -1;
let cacheSlot = -1;
let cacheOut = null;

export function alliesOf(st, slot) {
  const out = [];
  const me = st && st.players ? st.players[slot] : null;
  if (!me) return out;
  for (const p of st.players) {
    if (p.slot !== slot && p.team === me.team) out.push(p.slot);
  }
  return out;
}

export function isAllyOrSelf(st, slot, owner) {
  if (owner === slot) return true;
  const me = st && st.players ? st.players[slot] : null;
  const other = st && st.players ? st.players[owner] : null;
  return !!(me && other && me.team === other.team);
}

export function teamFog(game, st) {
  const slot = game.playerSlot | 0;
  const own = st && st.fog ? st.fog[slot] : null;
  if (!own) return null;
  const allies = alliesOf(st, slot).filter((s) => st.fog[s]);
  if (!allies.length) return own;
  if (cacheState === st && cacheTick === st.tick && cacheSlot === slot && cacheOut) return cacheOut;
  const n = own.visible.length;
  if (!cacheOut || cacheOut.visible.length !== n || cacheState !== st) {
    cacheOut = { visible: new Uint8Array(n), seen: new Uint8Array(n) };
  }
  const vis = cacheOut.visible, seen = cacheOut.seen;
  vis.set(own.visible);
  seen.set(own.seen);
  for (const s of allies) {
    const f = st.fog[s];
    const av = f.visible, as = f.seen;
    for (let i = 0; i < n; i++) {
      if (av[i]) vis[i] = 1;
      if (as[i]) seen[i] = 1;
    }
  }
  cacheState = st; cacheTick = st.tick; cacheSlot = slot;
  return cacheOut;
}

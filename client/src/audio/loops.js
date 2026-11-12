// Continuous loops owned by the renderer (rotors, engines, fire, weather).
// Each loop is described as a small synthesis graph (LOOPS); the engine bakes
// that graph once into a seamless buffer on a background OfflineAudioContext,
// so a running loop is five nodes however rich its recipe is. buildLoop()
// returns a handle { set(pan, dist, gain, pitch), stop() }. All control
// changes are smoothed on the audio clock; a loop fades in when created and
// fades out before its nodes are stopped and disconnected.

function src(L, color) {
  let s = L.shared[color];
  if (s) return s;
  const E = L.E;
  s = L.ctx.createBufferSource();
  s.buffer = color === 'crackle' ? E.crackle() : E.noise(color);
  s.loop = true;
  s.start(L.t, E.rng() * (s.buffer ? s.buffer.duration : 1) * 0.9);
  L.srcs.push(s);
  L.shared[color] = s;
  E.count(1);
  return s;
}

function filt(L, type, f, q) {
  const n = L.ctx.createBiquadFilter();
  n.type = type; n.frequency.value = f; n.Q.value = q || 0.707;
  L.E.count(1);
  return n;
}

function gain(L, v) {
  const g = L.ctx.createGain();
  g.gain.value = v;
  L.E.count(1);
  return g;
}

// source -> [filter] -> gain -> loop mix; returns the gain node
function layer(L, source, type, f, q, level) {
  const g = gain(L, level);
  if (type) {
    const fl = filt(L, type, f, q);
    source.connect(fl); fl.connect(g);
    g.filter = fl;
  } else {
    source.connect(g);
  }
  g.connect(L.mix);
  return g;
}

function osc(L, type, f, rateTracked) {
  const o = L.ctx.createOscillator();
  o.type = type; o.frequency.value = f;
  o.start(L.t);
  L.srcs.push(o);
  if (rateTracked) L.rates.push({ p: o.frequency, base: f });
  L.E.count(1);
  return o;
}

// LFO -> depth -> param (param keeps its own base value)
function lfo(L, f, depth, param, type, delay, rateTracked) {
  const o = L.ctx.createOscillator();
  o.type = type || 'sine'; o.frequency.value = f;
  const g = gain(L, depth);
  o.connect(g); g.connect(param);
  o.start(L.t + (delay || 0));
  L.srcs.push(o);
  if (rateTracked) L.rates.push({ p: o.frequency, base: f });
  L.E.count(1);
  return o;
}

export const LOOPS = {
  // helicopter: blade "whop" amplitude-modulates rumble + thump, turbine whine on top
  rotor(L) {
    const blade = 12.6;
    const a = layer(L, src(L, 'brown'), 'lowpass', 420, 0.7, 0.9);
    lfo(L, blade, 0.6, a.gain, 'sine', 0, true);
    lfo(L, blade * 2, 0.2, a.gain, 'sine', 0, true);
    const b = layer(L, osc(L, 'triangle', blade * 4, true), null, 0, 0, 0.22);
    lfo(L, blade, 0.2, b.gain, 'sine', 0, true);
    layer(L, src(L, 'pink'), 'bandpass', 1900, 7, 0.16);
    const air = layer(L, src(L, 'white'), 'highpass', 3500, 0.7, 0.03);
    lfo(L, blade, 0.028, air.gain, 'sine', 0, true);
    const whine = layer(L, osc(L, 'sawtooth', 1950, true), 'lowpass', 2600, 0.7, 0.006);
    lfo(L, 0.4, 12, whine.filter.detune, 'sine');
  },
  jet(L) {
    const body = layer(L, src(L, 'pink'), 'bandpass', 850, 0.6, 1.6);
    layer(L, src(L, 'brown'), 'lowpass', 170, 0.7, 1.3);
    layer(L, src(L, 'white'), 'highpass', 3200, 0.7, 0.07);
    const w1 = osc(L, 'sine', 2850, true), w2 = osc(L, 'sine', 4020, true);
    layer(L, w1, null, 0, 0, 0.012);
    layer(L, w2, null, 0, 0, 0.007);
    lfo(L, 0.23, 30, w1.detune); lfo(L, 0.23, 30, w2.detune);
    lfo(L, 0.31, 0.2, body.gain);
  },
  // tank / truck diesel: saw + sub square through a low-pass, chugging AM, track clatter
  engine(L) {
    const rpm = 11.5;
    const e = layer(L, osc(L, 'sawtooth', rpm * 4, true), 'lowpass', 240, 2, 0.4);
    lfo(L, rpm, 0.2, e.gain, 'sine', 0, true);
    layer(L, osc(L, 'square', rpm * 2, true), 'lowpass', 140, 0.7, 0.16);
    const r = layer(L, src(L, 'brown'), 'bandpass', 180, 1, 1.6);
    lfo(L, rpm, 0.5, r.gain, 'sine', 0, true);
    layer(L, src(L, 'crackle'), 'bandpass', 1400, 1, 0.4);
  },
  fire(L) {
    layer(L, src(L, 'crackle'), 'highpass', 1500, 0.7, 1.4);
    const roar = layer(L, src(L, 'brown'), 'lowpass', 380, 0.7, 1.4);
    lfo(L, 3.1, 0.4, roar.gain); lfo(L, 7.3, 0.22, roar.gain);
    layer(L, src(L, 'pink'), 'bandpass', 900, 0.7, 0.4);
  },
  wind(L) {
    const w = layer(L, src(L, 'pink'), 'bandpass', 520, 1.1, 1.5);
    lfo(L, 0.11, 220, w.filter.frequency);
    lfo(L, 0.17, 0.55, w.gain);
    const wh = layer(L, src(L, 'pink'), 'bandpass', 1500, 3.5, 0.3);
    lfo(L, 0.07, 500, wh.filter.frequency);
    lfo(L, 0.13, 0.2, wh.gain);
    layer(L, src(L, 'brown'), 'lowpass', 150, 0.7, 0.8);
  },
  waves(L) {
    const swell = layer(L, src(L, 'pink'), 'lowpass', 1100, 0.7, 1.1);
    lfo(L, 0.13, 0.85, swell.gain);
    const hiss = layer(L, src(L, 'white'), 'highpass', 2600, 0.7, 0.06);
    lfo(L, 0.13, 0.05, hiss.gain, 'sine', 1.9);
    const low = layer(L, src(L, 'brown'), 'lowpass', 200, 0.7, 0.9);
    lfo(L, 0.09, 0.35, low.gain);
  },
};

// length of the baked buffer per loop (long enough to hide its slowest LFO)
export const LOOP_LEN = { rotor: 4, jet: 7, engine: 4, fire: 7, wind: 14, waves: 15.4 };
// calibrated so gain 1 at dist 0 sits clearly under weapon fire
const LOOP_LVL = { rotor: 0.36, jet: 0.36, engine: 0.28, fire: 0.36, wind: 0.5, waves: 0.42 };

export function buildLoop(E, name) {
  const ctx = E.ctx;
  const t = ctx.currentTime + 0.005;
  const L = { name, E, ctx, t, srcs: [], shared: {}, rates: [], dead: false, src: null };
  // four nodes per running loop: source, distance low-pass, level, panner
  // (the reverb send is one gain shared by every loop)
  L.lp = filt(L, 'lowpass', 12000, 0.5);
  L.out = gain(L, 0);
  L.pan = E.panner(0);
  L.lp.connect(L.out); L.out.connect(L.pan); L.pan.connect(E.bus.loop);
  L.out.connect(E.bus.loopSend);
  const last = { pan: 2, dist: -1, gain: -1, pitch: -1 };
  const want = { pitch: 1 };
  const lvl = LOOP_LVL[name];

  const begin = (buf) => {
    if (L.dead || L.src) return;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = want.pitch;
    s.connect(L.lp);
    s.start(Math.max(ctx.currentTime, t), E.rng() * buf.duration * 0.9);
    L.src = s;
    L.srcs.push(s);
    E.count(1);
  };
  const baked = E.baker.loops.get(name);
  if (baked) {
    begin(baked);
  } else if (E.baker.can() && !E.offline) {
    // first use: the loop joins in as soon as its buffer is rendered
    E.baker.want('loop', name, () => { const b = E.baker.loops.get(name); if (b) begin(b); });
  } else {
    // no OfflineAudioContext (or an un-prebaked offline render): live graph
    L.mix = gain(L, 1);
    L.mix.connect(L.lp);
    LOOPS[name](L);
  }

  L.set = (pan, dist, g, pitch) => {
    if (L.dead) return;
    try {
      const now = ctx.currentTime;
      pan = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
      dist = Number.isFinite(dist) ? Math.max(0, Math.min(1, dist)) : 0;
      g = Number.isFinite(g) ? Math.max(0, Math.min(2, g)) : 1;
      if (Math.abs(pan - last.pan) > 0.01 && L.pan.pan) {
        L.pan.pan.setTargetAtTime(pan * 0.9, now, 0.06);
        last.pan = pan;
      }
      if (Math.abs(dist - last.dist) > 0.005) {
        L.lp.frequency.setTargetAtTime(650 + 19000 * Math.pow(1 - dist, 2.6), now, 0.06);
      }
      if (Math.abs(dist - last.dist) > 0.005 || Math.abs(g - last.gain) > 0.004) {
        L.out.gain.setTargetAtTime(lvl * g / (1 + 9 * dist * dist), now, 0.06);
        last.dist = dist; last.gain = g;
      }
      if (pitch !== undefined && Number.isFinite(pitch) && Math.abs(pitch - last.pitch) > 0.004) {
        const k = Math.max(0.25, Math.min(4, pitch));
        want.pitch = k;
        if (L.src) L.src.playbackRate.setTargetAtTime(k, now, 0.08);
        for (const r of L.rates) r.p.setTargetAtTime(r.base * k, now, 0.08);
        last.pitch = pitch;
      }
    } catch (e) { /* best-effort */ }
  };
  L.stop = () => {
    if (L.dead) return;
    L.dead = true;
    try {
      const now = ctx.currentTime;
      L.out.gain.cancelScheduledValues(now);
      L.out.gain.setTargetAtTime(0, now, 0.08);
      for (const s of L.srcs) { try { s.stop(now + 0.6); } catch (e) { /* ok */ } }
      E.after(now + 0.7, () => {
        try { L.pan.disconnect(); L.out.disconnect(); } catch (e) { /* ok */ }
      });
    } catch (e) { /* ok */ }
    E.loopGone(L);
  };
  L.set(0, 0.25, 0.8);
  return L;
}

// Module worker: builds procedural audio buffers off the main thread so
// asset generation never blocks a frame. Protocol: { id, key, sr } in,
// { id, key, chans: Float32Array[] } out (buffers transferred).
import { generateAsset } from './assetgen.js';

self.onmessage = (ev) => {
  const m = ev.data || {};
  try {
    const chans = generateAsset(m.key, m.sr);
    self.postMessage({ id: m.id, key: m.key, chans }, chans.map((c) => c.buffer));
  } catch (e) {
    self.postMessage({ id: m.id, key: m.key, error: String(e && e.message || e) });
  }
};

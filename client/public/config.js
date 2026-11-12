// Runtime configuration. Static hosts ship this file as-is; server/index.js
// serves a generated version at the same URL. Edit relayUrl to point a static
// deployment (GitHub Pages, Netlify, itch.io) at your multiplayer relay.
window.MCA_CONFIG = Object.assign({
  relayUrl: '',        // '' = same origin (/ws) when served over http(s)
  apiBase: '',         // '' = same origin
  paywall: 'off',      // 'off' | 'multiplayer' | 'full' (enforced server-side)
  storeEnabled: false, // true once the server has payment keys configured
}, window.MCA_CONFIG || {});

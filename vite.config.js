import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The client fetches game data and maps at runtime (so maps stay editable
// without a rebuild); this copies them, minified, into the build output.
function staticData() {
  return {
    name: 'mca-static-data',
    apply: 'build',
    generateBundle() {
      const client = path.join(here, 'client');
      const emit = (rel) => {
        const src = fs.readFileSync(path.join(client, rel), 'utf8');
        this.emitFile({ type: 'asset', fileName: rel, source: JSON.stringify(JSON.parse(src)) });
      };
      emit('data/game.json');
      emit('maps/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(path.join(client, 'maps/manifest.json'), 'utf8'));
      for (const id of manifest.maps) emit('maps/' + id + '.json');
    },
  };
}

// The game client lives in client/. `npm run build` emits a static site into
// dist/web that any static host (or server/index.js) can serve.
// MCA_PORT lets several dev servers run side by side without sharing a cache.
const port = Number(process.env.MCA_PORT || 5173);

export default defineConfig({
  root: 'client',
  base: './',
  publicDir: 'public',
  plugins: [staticData()],
  cacheDir: '../node_modules/.vite-' + port,
  server: { host: '127.0.0.1', port, strictPort: true, hmr: process.env.MCA_HMR === '0' ? false : undefined },
  preview: { host: '127.0.0.1', port },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
});

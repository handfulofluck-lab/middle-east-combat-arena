import { defineConfig } from 'vite';

// The game client lives in client/. `npm run build` emits a static site into
// dist/web that any static host (or server/index.js) can serve.
// MCA_PORT lets several dev servers run side by side without sharing a cache.
const port = Number(process.env.MCA_PORT || 5173);

export default defineConfig({
  root: 'client',
  base: './',
  publicDir: 'public',
  cacheDir: '../node_modules/.vite-' + port,
  server: { host: '127.0.0.1', port, strictPort: true },
  preview: { host: '127.0.0.1', port },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      input: { index: 'client/index.html' },
    },
  },
});

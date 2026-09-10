import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client is a standalone SPA built into dist/client, which the Worker
// serves as static assets. During `npm run dev` the Vite server proxies API
// and WebSocket traffic to `wrangler dev` on :8787.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});

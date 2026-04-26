import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite serves the UI from /ui. The build output is /dist; CI's build step
// runs `pnpm build` which produces a static bundle there.
//
// Worker support: Vite handles the `?worker` import suffix natively, so
// /host/worker.ts (when it lands) can be imported as
// `new Worker(new URL('../host/worker.ts', import.meta.url), { type: 'module' })`
// or via the `?worker` shorthand without extra config.

export default defineConfig({
  plugins: [react()],
  root: 'ui',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  resolve: {
    // Allow imports from sibling directories (sim/, host/, transport/,
    // protocol/) without ../ ../ chains. The UI uses these via the
    // SimTransport interface only; this keeps imports tidy.
    alias: {},
  },
});

import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true },
  // the HEIC decoder (~3 MB) is its own chunk, only fetched when an iPhone photo needs it
  build: { chunkSizeWarningLimit: 3500 },
});

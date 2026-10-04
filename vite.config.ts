import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Preact JSX plus Prefresh, so component edits hot-swap without reloading the page (and losing the painting)
  plugins: [preact()],
  server: { host: true },
  // the HEIC decoder (~3 MB) is its own chunk, only fetched when an iPhone photo needs it
  build: { chunkSizeWarningLimit: 3500 },
});

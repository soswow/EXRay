import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works from any static host (e.g. GitHub Pages).
  base: './',
  worker: { format: 'es' },
});

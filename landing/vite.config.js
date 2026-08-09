import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds into the worker's static assets at /landing/; the worker serves
// /landing/index.html for every non-asset path on partyplusone.com.
export default defineConfig({
  plugins: [react()],
  base: '/landing/',
  build: {
    outDir: '../public/landing',
    emptyOutDir: true,
  },
});

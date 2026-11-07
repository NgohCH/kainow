import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on port 3000 and the page is served by Vite.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: { proxy: { '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') } } },
});

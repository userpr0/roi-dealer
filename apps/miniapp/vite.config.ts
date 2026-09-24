import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Public path the app is served from, e.g. `/roi-dealer/` on GitHub Pages. Default: site root.
  base: process.env['MINIAPP_BASE_PATH'] ?? '/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { sourcemap: true },
});

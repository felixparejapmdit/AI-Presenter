import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// A dedicated port, separate from the Vite (5173) and Tauri (1420) defaults, so this
// app never collides with other local projects. strictPort makes a clash fail loudly.
const DEV_PORT = 17391;
const PREVIEW_PORT = 17392;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/e2e/**', '**/test-results/**'] },
  },
  preview: {
    host: '127.0.0.1',
    port: PREVIEW_PORT,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    // Export libraries load through dynamic import, so they never slow down startup.
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

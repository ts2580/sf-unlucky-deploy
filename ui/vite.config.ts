import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: uiRoot,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(uiRoot, '../dist/ui'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:27546',
    },
  },
});

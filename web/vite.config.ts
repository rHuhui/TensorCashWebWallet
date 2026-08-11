import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/wallet/',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    strictPort: true,
    port: 5173,
  },
});

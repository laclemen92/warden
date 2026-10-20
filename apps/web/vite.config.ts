import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Vendor code every page needs changes less often than the app, so give it stable chunks
          // that stay cached across releases. Page-specific libraries are left to the per-route split.
          groups: [
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/,
            },
            {
              name: 'tanstack-query',
              test: /[\\/]node_modules[\\/]@tanstack[\\/](react-query|query-core)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // CI runners share their CPU with every other package's tests, and jsdom tests that type
    // into several fields can take well over the default 5s there. Keep this above the 5s
    // `asyncUtilTimeout` in test/setup.ts, so a single slow wait fails with its own message.
    testTimeout: 30_000,
  },
});

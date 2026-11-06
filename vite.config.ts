import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  // play/ is the stable release build; don't hot-reload the dev server when it's rewritten
  server: { watch: { ignored: ['**/play/**', '**/play-next/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120000,
  },
});

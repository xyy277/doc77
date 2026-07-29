import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    globals: true,
    environment: 'node',
    include: ['packages/**/__tests__/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts'],
      exclude: ['packages/**/dist/**', 'packages/**/__tests__/**'],
    },
    // Run each test file in its own context
    pool: 'forks',
    testTimeout: 60000,
    hookTimeout: 60000,
    // Externalize native modules that vitest's SSR transform cannot handle
    server: {
      deps: {
        external: ['sharp'],
      },
    },
  },
});

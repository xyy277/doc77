import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/__tests__/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts'],
      exclude: ['packages/**/dist/**', 'packages/**/__tests__/**'],
    },
    // Ensure each package's tests run with its own context
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});

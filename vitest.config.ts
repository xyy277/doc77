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
    // Use threads pool - forks can exhaust process limits on CI runners
    pool: 'threads',
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});

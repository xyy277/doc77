import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [path.join(__dirname, '__tests__').replace(/\\/g, '/') + '/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      // 在测试环境中把 workspace 包解析到源码而非 dist（dist 会引用未构建的 @doc77/mcp）
      '@doc77/core': path.join(root, 'packages/core/src/index.ts'),
      '@doc77/mcp': path.join(root, 'packages/mcp/src/index.ts'),
      '@doc77/ai': path.join(root, 'packages/ai/src/index.ts'),
    },
  },
});

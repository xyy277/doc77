import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['@modelcontextprotocol', '@doc77/core', '@doc77/mcp', '@doc77/ai', 'zod'],
});

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['@doc77/mcp', '@doc77/ai', '@doc77/gallery', '@huggingface/transformers'],
});

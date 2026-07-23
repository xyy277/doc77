import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['@doc77/core', 'sharp', 'exif-reader'],
});

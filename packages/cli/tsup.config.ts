import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bin/doc77': 'src/bin/doc77.ts',
  },
  format: ['esm', 'cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['@modelcontextprotocol', '@doc77/core', '@doc77/mcp', '@doc77/ai'],
});

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Simulate the Electron case: transformers is NOT resolvable as a bare
// specifier (it lives outside the app bundle, under DOC77_MODULES_DIR).
vi.mock('@huggingface/transformers', () => {
  throw new Error("Cannot find module '@huggingface/transformers'");
});

describe('translation engine — Electron modules dir fallback', () => {
  it('imports transformers from DOC77_MODULES_DIR when the bare import fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-modules-'));
    const pkgDir = path.join(dir, 'node_modules', '@huggingface', 'transformers');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', type: 'module', main: './index.js' }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'index.js'),
      'export const env = {};\nexport const pipeline = () => {};\n',
    );
    process.env.DOC77_MODULES_DIR = dir;
    try {
      const { isEngineAvailable } = await import('../engine.js');
      expect(await isEngineAvailable()).toBe(true);
    } finally {
      delete process.env.DOC77_MODULES_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays unavailable when DOC77_MODULES_DIR has no transformers either', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-empty-'));
    process.env.DOC77_MODULES_DIR = dir;
    try {
      vi.resetModules();
      const { isEngineAvailable } = await import('../engine.js');
      expect(await isEngineAvailable()).toBe(false);
    } finally {
      delete process.env.DOC77_MODULES_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

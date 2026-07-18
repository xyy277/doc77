import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initI18n } from '../src/i18n/index.js';
import {
  modulesDir,
  buildInstallPlan,
  parsePackageInfo,
  moveExtracted,
  resolveModuleEntry,
} from '../src/server/electron-install.js';

beforeAll(() => initI18n('en-US'));

describe('Electron module install', () => {
  describe('modulesDir', () => {
    const savedHome = process.env.HOME;
    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    });

    it('is based on os.homedir(), not $HOME (Windows has no HOME → old code hit D:\\tmp)', () => {
      // Regression: `process.env.HOME || '/tmp'` resolved to `D:\tmp` on Windows.
      delete process.env.HOME;
      expect(modulesDir()).toBe(path.join(os.homedir(), '.doc77', 'electron-modules'));
      expect(modulesDir().startsWith(path.sep + 'tmp')).toBe(false);
    });
  });

  describe('parsePackageInfo', () => {
    it('throws a friendly error naming the package for registry 404 payloads (not a TypeError)', () => {
      // Regression: @doc77/translate does not exist → registry returns {"error":"Not Found"}
      // → old code crashed with "Cannot read properties of undefined (reading 'tarball')".
      expect(() => parsePackageInfo('{"error":"Not Found"}', '@doc77/translate')).toThrow(
        /@doc77\/translate/,
      );
    });

    it('throws a friendly error naming the package for non-JSON responses', () => {
      expect(() => parsePackageInfo('<html>bad gateway</html>', '@doc77/ai')).toThrow(/@doc77\/ai/);
    });

    it('returns version and tarball URL for valid registry metadata', () => {
      const raw = JSON.stringify({ version: '1.2.3', dist: { tarball: 'https://r/x.tgz' } });
      const info = parsePackageInfo(raw, '@doc77/ai');
      expect(info.version).toBe('1.2.3');
      expect(info.dist.tarball).toBe('https://r/x.tgz');
    });
  });

  describe('moveExtracted', () => {
    let dest: string;
    afterEach(() => {
      if (dest) fs.rmSync(dest, { recursive: true, force: true });
    });

    function makeExtracted(): string {
      dest = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-einstall-'));
      fs.mkdirSync(path.join(dest, 'package'));
      fs.writeFileSync(path.join(dest, 'package', 'package.json'), '{"name":"@doc77/ai"}');
      return dest;
    }

    it('creates node_modules/@doc77 parents before renaming (fresh install regression)', () => {
      // Regression: renameSync into a non-existent node_modules/@doc77/ threw ENOENT.
      makeExtracted();
      moveExtracted(dest, '@doc77/ai');
      expect(fs.existsSync(path.join(dest, 'node_modules', '@doc77', 'ai', 'package.json'))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(dest, 'package'))).toBe(false);
    });

    it('replaces a previously installed copy', () => {
      makeExtracted();
      const target = path.join(dest, 'node_modules', '@doc77', 'ai');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'stale.txt'), 'old');
      moveExtracted(dest, '@doc77/ai');
      expect(fs.existsSync(path.join(target, 'stale.txt'))).toBe(false);
      expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
    });
  });

  describe('buildInstallPlan', () => {
    it('installs ai via npm-free tarballs including its @doc77/core runtime dep', () => {
      expect(buildInstallPlan('ai')).toEqual({
        method: 'tarball',
        packages: ['@doc77/ai', '@doc77/core'],
      });
    });

    it('installs translate via system npm as @huggingface/transformers (@doc77/translate does not exist)', () => {
      const plan = buildInstallPlan('translate');
      expect(plan.method).toBe('npm');
      if (plan.method === 'npm') expect(plan.spec).toContain('@huggingface/transformers');
    });

    it('installs mcp via system npm (third-party dependency tree)', () => {
      expect(buildInstallPlan('mcp').method).toBe('npm');
    });
  });

  describe('resolveModuleEntry', () => {
    let pkgDir: string;
    afterEach(() => {
      if (pkgDir) fs.rmSync(pkgDir, { recursive: true, force: true });
    });

    function makePkg(pkgJson: Record<string, unknown>, entryRel: string): string {
      pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-entry-'));
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson));
      const entryAbs = path.join(pkgDir, entryRel);
      fs.mkdirSync(path.dirname(entryAbs), { recursive: true });
      fs.writeFileSync(entryAbs, 'export {};\n');
      return pkgDir;
    }

    it('resolves the ESM entry from the exports map', () => {
      makePkg(
        { name: 'x', exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' } } },
        'dist/index.js',
      );
      expect(resolveModuleEntry(pkgDir)).toBe(path.join(pkgDir, 'dist', 'index.js'));
    });

    it('falls back to the main field', () => {
      makePkg({ name: 'x', main: './lib/main.js' }, 'lib/main.js');
      expect(resolveModuleEntry(pkgDir)).toBe(path.join(pkgDir, 'lib', 'main.js'));
    });

    it('returns null when the package is not installed', () => {
      expect(resolveModuleEntry(path.join(os.tmpdir(), 'doc77-definitely-missing'))).toBeNull();
    });
  });
});

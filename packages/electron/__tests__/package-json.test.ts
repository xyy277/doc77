import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Electron package.json fileAssociations 校验测试 —— T6 验收标准之一：
 *   "package.json JSON 校验通过，build.fileAssociations 存在且含 md/txt/pdf"
 */
describe('packages/electron/package.json — fileAssociations', () => {
  const pkgPath = resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  it('存在 build 字段', () => {
    expect(pkg).toHaveProperty('build');
    expect(typeof pkg.build).toBe('object');
  });

  it('build.fileAssociations 存在且为数组', () => {
    expect(pkg.build).toHaveProperty('fileAssociations');
    expect(Array.isArray(pkg.build.fileAssociations)).toBe(true);
    expect(pkg.build.fileAssociations.length).toBeGreaterThan(0);
  });

  it('fileAssociations 包含 md 扩展名', () => {
    const mdAssoc = pkg.build.fileAssociations.find((a: { ext: string[] }) => a.ext.includes('md'));
    expect(mdAssoc).toBeDefined();
    expect(mdAssoc.name).toBe('Markdown');
  });

  it('fileAssociations 包含 txt 扩展名', () => {
    const txtAssoc = pkg.build.fileAssociations.find((a: { ext: string[] }) =>
      a.ext.includes('txt'),
    );
    expect(txtAssoc).toBeDefined();
  });

  it('fileAssociations 包含 pdf 扩展名', () => {
    const pdfAssoc = pkg.build.fileAssociations.find((a: { ext: string[] }) =>
      a.ext.includes('pdf'),
    );
    expect(pdfAssoc).toBeDefined();
  });

  it('fileAssociations 包含 json/yaml/yml 扩展名', () => {
    const exts = new Set<string>();
    for (const a of pkg.build.fileAssociations) {
      for (const e of a.ext) exts.add(e);
    }
    expect(exts.has('json')).toBe(true);
    expect(exts.has('yaml')).toBe(true);
    expect(exts.has('yml')).toBe(true);
  });

  it('每个 fileAssociation 条目都有 ext 和 name', () => {
    for (const a of pkg.build.fileAssociations) {
      expect(a).toHaveProperty('ext');
      expect(Array.isArray(a.ext)).toBe(true);
      expect(a.ext.length).toBeGreaterThan(0);
      expect(a).toHaveProperty('name');
      expect(typeof a.name).toBe('string');
    }
  });
});

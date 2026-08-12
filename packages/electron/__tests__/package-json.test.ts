import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Electron fileAssociations 校验测试 —— T6 验收标准之一：
 *   "fileAssociations 存在且含 md/txt/pdf/json/yaml/yml"
 *
 * build 配置位于 electron-builder.yml（package.json 的 build 字段已移除，
 * 见 95721cb），故从 yml 解析 win/mac 块的 fileAssociations 条目。
 */
describe('packages/electron/electron-builder.yml — fileAssociations', () => {
  const ymlPath = resolve(__dirname, '..', 'electron-builder.yml');
  const yml = readFileSync(ymlPath, 'utf-8');

  // Parse fileAssociation entries: "- ext: [a, b]" followed by "name: X"
  const entryRe = /- ext:\s*\[([^\]]*)\]\s*\n\s*name:\s*([^\n]+)/g;
  const entries: { ext: string[]; name: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(yml)) !== null) {
    entries.push({
      ext: m[1].split(',').map((s) => s.trim()),
      name: m[2].trim(),
    });
  }

  it('electron-builder.yml 存在且包含 fileAssociations', () => {
    expect(yml.length).toBeGreaterThan(0);
    expect(yml).toContain('fileAssociations');
  });

  it('fileAssociations 条目存在且非空', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('fileAssociations 包含 md 扩展名', () => {
    const mdAssoc = entries.find((a) => a.ext.includes('md'));
    expect(mdAssoc).toBeDefined();
    expect(mdAssoc!.name).toBe('Markdown');
  });

  it('fileAssociations 包含 txt 扩展名', () => {
    const txtAssoc = entries.find((a) => a.ext.includes('txt'));
    expect(txtAssoc).toBeDefined();
  });

  it('fileAssociations 包含 pdf 扩展名', () => {
    const pdfAssoc = entries.find((a) => a.ext.includes('pdf'));
    expect(pdfAssoc).toBeDefined();
  });

  it('fileAssociations 包含 json/yaml/yml 扩展名', () => {
    const exts = new Set<string>();
    for (const a of entries) {
      for (const e of a.ext) exts.add(e);
    }
    expect(exts.has('json')).toBe(true);
    expect(exts.has('yaml')).toBe(true);
    expect(exts.has('yml')).toBe(true);
  });

  it('每个 fileAssociation 条目都有 ext 和 name', () => {
    for (const a of entries) {
      expect(a.ext.length).toBeGreaterThan(0);
      expect(typeof a.name).toBe('string');
      expect(a.name.length).toBeGreaterThan(0);
    }
  });
});

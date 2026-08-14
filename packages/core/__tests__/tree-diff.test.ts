import { describe, it, expect, beforeEach } from 'vitest';
// 副作用导入：tree-diff.js 为 UMD-lite（浏览器 script 标签兼容），挂载到 globalThis.Doc77TreeDiff
import '../src/web/js/tree-diff.js';

interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  modified?: string;
}

interface DiffResult {
  added: DirEntry[];
  removed: string[];
  updated: DirEntry[];
}

function getDiff(): (a: DirEntry[], b: DirEntry[]) => DiffResult {
  const d = (globalThis as Record<string, unknown>).Doc77TreeDiff as
    { diffEntries: (a: DirEntry[], b: DirEntry[]) => DiffResult } | undefined;
  if (!d) throw new Error('tree-diff.js 未挂载到 globalThis（UMD-lite 的 ESM 分支未执行）');
  return d.diffEntries;
}

const f = (name: string, size = 10): DirEntry => ({
  name,
  type: 'file',
  size,
  modified: '2026-08-14T08:00:00.000Z',
});
const d = (name: string): DirEntry => ({
  name,
  type: 'directory',
  modified: '2026-08-14T08:00:00.000Z',
});

/**
 * 目录树增量 diff 纯函数
 *
 * 驱动 preview.js 的 applyDiff：只对变化的行做 DOM 操作，
 * 未变化行保持原节点（展开状态与选中高亮不丢）。
 */
describe('Doc77TreeDiff.diffEntries', () => {
  let diffEntries: (a: DirEntry[], b: DirEntry[]) => DiffResult;

  beforeEach(() => {
    diffEntries = getDiff();
  });

  it('无变化时三组均为空', () => {
    const a = [d('docs'), f('README.md')];
    expect(diffEntries(a, [...a])).toEqual({ added: [], removed: [], updated: [] });
  });

  it('识别新增条目（保持新顺序）', () => {
    const result = diffEntries([f('a.md')], [f('a.md'), d('new-dir'), f('z.md')]);
    expect(result.added.map((e) => e.name)).toEqual(['new-dir', 'z.md']);
    expect(result.removed).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  it('识别删除条目（保持旧顺序）', () => {
    const result = diffEntries([f('a.md'), d('gone'), f('b.md')], [f('a.md'), f('b.md')]);
    expect(result.removed).toEqual(['gone']);
    expect(result.added).toEqual([]);
  });

  it('识别更新条目（size/modified 变化）', () => {
    const result = diffEntries([f('a.md', 10)], [f('a.md', 1024)]);
    expect(result.updated).toEqual([f('a.md', 1024)]);
    expect(result.removed).toEqual([]);
    expect(result.added).toEqual([]);
  });

  it('name 相同但 type 变化视为更新而非新增+删除', () => {
    const result = diffEntries([f('node')], [d('node')]);
    expect(result.updated).toEqual([d('node')]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('混合场景：增删改同时发生', () => {
    const oldEntries = [d('keep-dir'), f('edit-me.md', 5), f('del-me.md'), d('old-dir')];
    const newEntries = [d('keep-dir'), d('new-dir'), f('edit-me.md', 99), f('new-file.md')];
    const result = diffEntries(oldEntries, newEntries);
    expect(result.removed).toEqual(['del-me.md', 'old-dir']);
    expect(result.added.map((e) => e.name)).toEqual(['new-dir', 'new-file.md']);
    expect(result.updated.map((e) => e.name)).toEqual(['edit-me.md']);
    expect(result.updated[0].size).toBe(99);
  });

  it('空输入与 undefined 容错', () => {
    expect(diffEntries(undefined as unknown as DirEntry[], []).added).toEqual([]);
    expect(diffEntries([], undefined as unknown as DirEntry[]).removed).toEqual([]);
    expect(diffEntries([], []).updated).toEqual([]);
  });

  it('顺序稳定：added/updated 保持服务端顺序，removed 保持旧顺序', () => {
    const oldEntries = [f('b.md'), f('a.md')];
    const newEntries = [f('c.md'), f('a.md'), f('b.md'), f('d.md')];
    const result = diffEntries(oldEntries, newEntries);
    expect(result.added.map((e) => e.name)).toEqual(['c.md', 'd.md']);
    expect(result.removed).toEqual([]);
    expect(result.updated).toEqual([]);
  });
});

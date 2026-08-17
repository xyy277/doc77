import { describe, it, expect } from 'vitest';
import { decideGraphUpdate } from './watcher.js';

/**
 * decideGraphUpdate 分派规则（防卡顿修复的纯函数核心）：
 * - truncated（>50 路径）→ full
 * - 无扩展名非 md 文件的 create/delete/mixed → full（可能引入新笔记）
 * - md 变更 → incremental（仅 md 路径）
 * - 其余（有扩展名非 md、无扩展名 modify）→ null（不影响链接结构）
 */
describe('decideGraphUpdate（图谱更新分派）', () => {
  it('truncated（>50 路径截断）→ 全量', () => {
    expect(decideGraphUpdate({ paths: ['a.md'], truncated: true }, 'modify')).toEqual({
      kind: 'full',
    });
  });

  it('md 变更 → 精确增量（仅 md 路径）', () => {
    expect(decideGraphUpdate({ paths: ['a.md', 'b.md'], truncated: false }, 'modify')).toEqual({
      kind: 'incremental',
      paths: ['a.md', 'b.md'],
    });
    expect(decideGraphUpdate({ paths: ['a.md'], truncated: false }, 'create')).toEqual({
      kind: 'incremental',
      paths: ['a.md'],
    });
  });

  it('无扩展名非 md 文件 create/delete/mixed → 全量（可能引入新笔记）', () => {
    expect(decideGraphUpdate({ paths: ['README'], truncated: false }, 'create')).toEqual({
      kind: 'full',
    });
    expect(decideGraphUpdate({ paths: ['LICENSE'], truncated: false }, 'delete')).toEqual({
      kind: 'full',
    });
    expect(decideGraphUpdate({ paths: ['TODO'], truncated: false }, 'mixed')).toEqual({
      kind: 'full',
    });
  });

  it('无扩展名非 md 文件 modify → 忽略（内容修改不影响链接结构）', () => {
    expect(decideGraphUpdate({ paths: ['README'], truncated: false }, 'modify')).toBeNull();
  });

  it('有扩展名非 md（.png/.ts）任何操作 → 忽略', () => {
    expect(decideGraphUpdate({ paths: ['img.png'], truncated: false }, 'create')).toBeNull();
    expect(decideGraphUpdate({ paths: ['code.ts'], truncated: false }, 'modify')).toBeNull();
    expect(decideGraphUpdate({ paths: ['img.png'], truncated: false }, 'delete')).toBeNull();
  });

  it('md + 无扩展名 modify 混合 → 增量仅 md（不丢 md 变更）', () => {
    expect(decideGraphUpdate({ paths: ['a.md', 'README'], truncated: false }, 'modify')).toEqual({
      kind: 'incremental',
      paths: ['a.md'],
    });
  });

  it('md + 无扩展名 add 混合 → 全量（结构变更兜底）', () => {
    expect(decideGraphUpdate({ paths: ['a.md', 'README'], truncated: false }, 'mixed')).toEqual({
      kind: 'full',
    });
  });
});

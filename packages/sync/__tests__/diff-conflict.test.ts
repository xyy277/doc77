/**
 * T13 验收测试 — diff + conflict + ai-assist
 *
 * 覆盖：
 * - computeDiff：本地 "A\nB" 远程 "A\nC" → diff 标记 B/C 差异
 * - detectConflicts：识别双向修改
 * - resolveConflict：local/remote/merge 策略
 * - aiResolveConflict：mock AI 返回合并结果
 */
import { describe, it, expect } from 'vitest';
import { computeDiff, formatDiff } from '../src/diff.js';
import { detectConflicts, resolveConflict, type ConflictStrategy } from '../src/conflict.js';
import { aiResolveConflict, buildConflictPrompt } from '../src/merge/ai-assist.js';
import type { FileChange, ConflictEntry } from '../src/types.js';

describe('T13 — computeDiff', () => {
  it('本地 "A\\nB" 远程 "A\\nC" → 标记 B 移除、C 新增', () => {
    const diff = computeDiff('A\nB', 'A\nC');
    expect(diff.hasChanges).toBe(true);
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1);
    // 第一行 A 不变
    expect(diff.lines[0].type).toBe('unchanged');
    expect(diff.lines[0].content).toBe('A');
    // B 被移除
    expect(diff.lines.some((l) => l.type === 'removed' && l.content === 'B')).toBe(true);
    // C 被新增
    expect(diff.lines.some((l) => l.type === 'added' && l.content === 'C')).toBe(true);
  });

  it('相同内容无变更', () => {
    const diff = computeDiff('A\nB\nC', 'A\nB\nC');
    expect(diff.hasChanges).toBe(false);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it('formatDiff 输出 unified diff 格式', () => {
    const diff = computeDiff('A\nB', 'A\nC');
    const formatted = formatDiff(diff);
    expect(formatted).toContain('+ C');
    expect(formatted).toContain('- B');
    expect(formatted).toContain('  A');
  });
});

describe('T13 — detectConflicts', () => {
  it('识别双向修改的文件为冲突', () => {
    const localChanges: FileChange[] = [
      {
        path: 'a.md',
        type: 'modified',
        mtime: '2026-07-31T10:00:00Z',
        hash: 'local-hash',
        size: 100,
      },
      { path: 'b.md', type: 'added', mtime: '2026-07-31T10:00:00Z', hash: 'local-hash', size: 50 },
    ];
    const remoteFiles = [
      { path: 'a.md', lastModified: '2026-07-31T10:30:00Z' }, // 远程也修改了 a.md
    ];
    const conflicts = detectConflicts(localChanges, remoteFiles);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].path).toBe('a.md');
  });

  it('仅本地修改（远程无此文件）不产生冲突', () => {
    const localChanges: FileChange[] = [
      { path: 'new.md', type: 'added', mtime: '2026-07-31T10:00:00Z', hash: 'hash', size: 50 },
    ];
    const conflicts = detectConflicts(localChanges, []);
    expect(conflicts.length).toBe(0);
  });
});

describe('T13 — resolveConflict', () => {
  const conflict: ConflictEntry = {
    path: 'test.md',
    localHash: 'aaa',
    remoteHash: 'bbb',
  };

  it("strategy='local' 返回本地版本", () => {
    const result = resolveConflict(conflict, 'local', {
      local: 'local content',
      remote: 'remote content',
    });
    expect(result.resolved).toBe(true);
    expect(result.mergedContent).toBe('local content');
  });

  it("strategy='remote' 返回远程版本", () => {
    const result = resolveConflict(conflict, 'remote', {
      local: 'local content',
      remote: 'remote content',
    });
    expect(result.resolved).toBe(true);
    expect(result.mergedContent).toBe('remote content');
  });

  it("strategy='merge' 有三方内容时返回合并结果", () => {
    const result = resolveConflict(conflict, 'merge', {
      base: 'A\nB\nC',
      local: 'A\nX\nC',
      remote: 'A\nB\nY',
    });
    expect(result.resolved).toBe(true);
    expect(result.mergedContent).toBeDefined();
    // 合并结果应包含 X 和 Y（双方各自的修改）
    expect(result.mergedContent).toContain('X');
    expect(result.mergedContent).toContain('Y');
  });

  it("strategy='ask' 返回未解决", () => {
    const result = resolveConflict(conflict, 'ask');
    expect(result.resolved).toBe(false);
  });
});

describe('T13 — aiResolveConflict', () => {
  it('构造 prompt 包含本地和远程版本', () => {
    const prompt = buildConflictPrompt({
      filePath: 'test.md',
      localContent: 'local version',
      remoteContent: 'remote version',
    });
    expect(prompt).toContain('test.md');
    expect(prompt).toContain('local version');
    expect(prompt).toContain('remote version');
  });

  it('mock AI 返回合并结果', async () => {
    const mockChat: (prompt: string) => Promise<string> = async () => {
      return 'merged content from AI';
    };
    const result = await aiResolveConflict(
      { filePath: 'test.md', localContent: 'local', remoteContent: 'remote' },
      mockChat,
    );
    expect(result.mergedContent).toBe('merged content from AI');
  });

  it('AI 返回代码块包裹时自动去除', async () => {
    const mockChat: (prompt: string) => Promise<string> = async () => {
      return '```\nmerged code block\n```';
    };
    const result = await aiResolveConflict(
      { filePath: 'test.md', localContent: 'local', remoteContent: 'remote' },
      mockChat,
    );
    expect(result.mergedContent).toBe('merged code block');
  });
});

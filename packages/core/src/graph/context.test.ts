import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { registerProject } from '../db/projects.js';
import { fullGraphIndex } from './indexer.js';
import { collectGraphNeighbors } from './context.js';

describe('graph context (AI 邻居注入)', () => {
  let testDir: string;
  let projectDir: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-graph-ctx-'));
    projectDir = path.join(testDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a.md'), '# A\n\n参见 [[b]]');
    fs.writeFileSync(
      path.join(projectDir, 'b.md'),
      '# B\n\n回链 [[a]] 和 [c](c.md)'.padEnd(5000, '\n内容填充'),
    );
    fs.writeFileSync(path.join(projectDir, 'c.md'), '# C\n\n引用 [[a]]');
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('GraphCtx', projectDir).id;
    await fullGraphIndex(projectId, projectDir);
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const readContent = (pid: number, filePath: string): string => {
    const abs = path.join(projectDir, filePath);
    if (!fs.existsSync(abs)) return 'Error: file not found';
    return fs.readFileSync(abs, 'utf-8');
  };

  it('返回图谱邻居文档内容（含 1 跳邻居）', () => {
    const ctx = collectGraphNeighbors(projectId, 'a.md', readContent);
    // a 的邻居 b、c（共享引用）
    expect(ctx).toContain('b.md');
    expect(ctx).toContain('c.md');
    expect(ctx).toContain('<doc path="');
  });

  it('N/K/T 预算约束生效', () => {
    const ctx = collectGraphNeighbors(projectId, 'a.md', readContent, {
      maxDocs: 1,
      maxCharsPerDoc: 100,
      maxTotalChars: 300,
    });
    // 单文档截断 ≤100 字符
    const docMatch = ctx.match(/<doc path="[^"]+">\n([\s\S]*?)\n<\/doc>/);
    expect(docMatch).toBeDefined();
    if (docMatch) expect(docMatch[1].length).toBeLessThanOrEqual(100);
  });

  it('无邻居时返回空串', async () => {
    fs.writeFileSync(path.join(projectDir, 'isolated.md'), '# 孤立文档\n没有任何链接');
    // 重建后 isolated 无出链无入链
    await fullGraphIndex(projectId, projectDir);
    const ctx = collectGraphNeighbors(projectId, 'isolated.md', readContent);
    expect(ctx).toBe('');
  });

  it('readContent 返回 Error 的文档被跳过', () => {
    const ctx = collectGraphNeighbors(projectId, 'a.md', () => 'Error: sensitive file');
    expect(ctx).toBe('');
  });
});

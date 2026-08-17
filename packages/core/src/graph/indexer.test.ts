import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, getConnection } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { registerProject } from '../db/projects.js';
import { indexFileLinks, fullGraphIndex } from './indexer.js';
import { queryBacklinks, queryOutlinks, getGraphStats } from './repository.js';
import { relatedDocs } from './related.js';

describe('graph indexer + repository', () => {
  let testDir: string;
  let projectDir: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-graph-idx-'));
    projectDir = path.join(testDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'a.md'),
      '# A\n\n参见 [[b]] 和 [c](c.md) 以及 [[不存在]]',
    );
    fs.writeFileSync(path.join(projectDir, 'b.md'), '# B\n\n回链 [[a]]');
    fs.writeFileSync(path.join(projectDir, 'c.md'), '# C\n\n引用 [[a]]');
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('GraphTest', projectDir).id;
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('增量索引：出链/入链正确入库，死链标记 broken', () => {
    indexFileLinks(projectId, projectDir, 'a.md');
    indexFileLinks(projectId, projectDir, 'b.md');
    indexFileLinks(projectId, projectDir, 'c.md');

    const out = queryOutlinks(getConnection(), projectId, 'a.md');
    expect(out.map((l) => l.to_path).sort()).toEqual(['b.md', 'c.md']);
    expect(out.every((l) => l.status === 'resolved')).toBe(true);

    const backlinks = queryBacklinks(getConnection(), projectId, 'a.md');
    expect(backlinks.map((b) => b.from_path).sort()).toEqual(['b.md', 'c.md']);
    expect(backlinks[0].title).toBeDefined();

    // 死链
    const stats = getGraphStats(getConnection(), projectId);
    expect(stats.broken).toBe(1); // a.md 的 [[不存在]]
  });

  it('hash 短路：未变更文件跳过，变更后重建', () => {
    indexFileLinks(projectId, projectDir, 'a.md');
    const first = getGraphStats(getConnection(), projectId);
    // 再次索引（未变更）—— 不重复写
    indexFileLinks(projectId, projectDir, 'a.md');
    expect(getGraphStats(getConnection(), projectId).edges).toBe(first.edges);
    // 变更内容 → 重建（出链变化）
    fs.writeFileSync(path.join(projectDir, 'a.md'), '# A 改\n\n参见 [[b]]');
    indexFileLinks(projectId, projectDir, 'a.md');
    const out = queryOutlinks(getConnection(), projectId, 'a.md');
    expect(out.map((l) => l.to_path)).toEqual(['b.md']);
  });

  it('删除文件：入链置 broken，出链清空', () => {
    indexFileLinks(projectId, projectDir, 'a.md');
    indexFileLinks(projectId, projectDir, 'b.md');
    fs.rmSync(path.join(projectDir, 'a.md'));
    indexFileLinks(projectId, projectDir, 'a.md'); // 不存在 → 清理路径

    const out = queryOutlinks(getConnection(), projectId, 'a.md');
    expect(out).toHaveLength(0);
    const stats = getGraphStats(getConnection(), projectId);
    // b.md 的 [[a]] 现在指向已删除文件 → broken（2：b 的 [[a]] + a 自身已删无 from 边）
    expect(stats.broken).toBeGreaterThanOrEqual(1);
    expect(queryBacklinks(getConnection(), projectId, 'a.md')).toHaveLength(0);
  });

  it('related：co-citation 评分与排序', async () => {
    await fullGraphIndex(projectId, projectDir);
    // a 被 b、c 引用；b 与 c 都引用 a → b、c 互为相关（共享 in(a)）
    const related = relatedDocs(projectId, 'b.md', 5);
    expect(related.map((r) => r.path)).toContain('c.md');
    expect(related[0].title).toBeDefined();
    // a 的邻居 b、c；b、c 共享出链 a → 互为相关
    const relatedA = relatedDocs(projectId, 'a.md', 5);
    // a 的出链 b/c，入链 b/c —— 候选含 a 自身已剔除
    expect(relatedA.every((r) => r.path !== 'a.md')).toBe(true);
  });

  it('fullGraphIndex 全量重建 + 清理不存在文件', async () => {
    await fullGraphIndex(projectId, projectDir);
    const stats1 = getGraphStats(getConnection(), projectId);
    expect(stats1.nodes).toBe(3);

    // 删除文件后全量重建 → meta 清理
    fs.rmSync(path.join(projectDir, 'c.md'));
    await fullGraphIndex(projectId, projectDir);
    const stats2 = getGraphStats(getConnection(), projectId);
    expect(stats2.nodes).toBe(2);
    // b 引用 a 仍 resolved；其他文件引用 c 的边自愈
    expect(queryBacklinks(getConnection(), projectId, 'c.md')).toHaveLength(0);
  });

  it('fullGraphIndex hash 短路：未变更文件不重写（indexed_at 不变）', async () => {
    await fullGraphIndex(projectId, projectDir);
    // datetime('now') 秒级精度：等 1.1s 保证未短路时 indexed_at 必变化
    await new Promise((r) => setTimeout(r, 1100));
    const before = getConnection()
      .prepare(
        'SELECT file_path, title, tags, file_hash, indexed_at FROM doc_meta ORDER BY file_path',
      )
      .all() as Array<{ file_path: string }>;
    await fullGraphIndex(projectId, projectDir);
    const after = getConnection()
      .prepare(
        'SELECT file_path, title, tags, file_hash, indexed_at FROM doc_meta ORDER BY file_path',
      )
      .all();
    // 短路跳过 → 行内容逐字段完全一致（修复前每次重建都会重写 indexed_at）
    expect(after).toEqual(before);
  });

  it('fullGraphIndex 内容级短路：touch 改 mtime 但内容不变 → 不重写', async () => {
    await fullGraphIndex(projectId, projectDir);
    // touch：utimes 改 mtime 不改内容——快速短路（mtime+size）被绕过，
    // 内容级短路（hash 相同）兜底 → 不重写（indexed_at 不变）
    const now = new Date();
    fs.utimesSync(path.join(projectDir, 'a.md'), now, now);
    await new Promise((r) => setTimeout(r, 1100));
    const before = getConnection()
      .prepare('SELECT indexed_at FROM doc_meta WHERE project_id = ? AND file_path = ?')
      .get(projectId, 'a.md') as { indexed_at: string };
    await fullGraphIndex(projectId, projectDir);
    const after = getConnection()
      .prepare('SELECT indexed_at FROM doc_meta WHERE project_id = ? AND file_path = ?')
      .get(projectId, 'a.md') as { indexed_at: string };
    expect(after.indexed_at).toBe(before.indexed_at);
  });

  it('fullGraphIndex 短路后仅重建变更文件', async () => {
    await fullGraphIndex(projectId, projectDir);
    // 变更 b.md 内容（出链变化）；a/c 未变更
    fs.writeFileSync(path.join(projectDir, 'b.md'), '# B 改\n\n引用 [[a]] 和 [[c.md]]');
    await new Promise((r) => setTimeout(r, 1100));
    const before = getConnection()
      .prepare(
        'SELECT file_path, indexed_at FROM doc_meta WHERE project_id = ? AND file_path IN (?, ?) ORDER BY file_path',
      )
      .all(projectId, 'a.md', 'c.md') as Array<{ file_path: string; indexed_at: string }>;
    await fullGraphIndex(projectId, projectDir);
    // b.md 变更 → 出链重建
    const bOut = queryOutlinks(getConnection(), projectId, 'b.md');
    expect(bOut.map((l) => l.to_path).sort()).toEqual(['a.md', 'c.md']);
    // 未变更文件 → 短路跳过（indexed_at 不变，未被重写）
    const untouched = getConnection()
      .prepare(
        'SELECT file_path, indexed_at FROM doc_meta WHERE project_id = ? AND file_path IN (?, ?) ORDER BY file_path',
      )
      .all(projectId, 'a.md', 'c.md') as Array<{ file_path: string; indexed_at: string }>;
    expect(untouched).toEqual(before);
  });

  it('非 markdown 文件不产生图谱节点（代码文件过滤）', async () => {
    fs.writeFileSync(path.join(projectDir, 'notes.ts'), '// 代码文件\n[[a]] 与 [b](b.md)');
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# 说明\n见 [[a]]');
    await fullGraphIndex(projectId, projectDir);
    const stats = getGraphStats(getConnection(), projectId);
    expect(stats.nodes).toBe(4); // a/b/c/README —— notes.ts 不索引
    expect(
      queryBacklinks(getConnection(), projectId, 'a.md').map((b) => b.from_path),
    ).not.toContain('notes.ts');
  });
});

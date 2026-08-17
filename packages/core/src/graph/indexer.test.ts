import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, getConnection } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { registerProject } from '../db/projects.js';
import { indexFileLinks, fullGraphIndex } from './indexer.js';
import { queryBacklinks, queryOutlinks, getGraphStats, replaceFileLinks } from './repository.js';
import { relatedDocs } from './related.js';

// 事务测试需注入 replaceFileLinks 失败（ESM 静态 import 绑定下 spyOn 不生效）
vi.mock('./repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repository.js')>();
  return { ...actual, replaceFileLinks: vi.fn(actual.replaceFileLinks) };
});

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
    // 每个测试重建 DB 后 projectId 复用（都是 1），必须清文件列表缓存
    // 防跨测试串扰（真实世界 projectId 唯一无此问题）
    const { clearWikilinkCache } = await import('../renderers/wikilink.js');
    clearWikilinkCache(projectId);
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

  it('content 透传：索引的是传入内容而非磁盘（保存点免重读）', () => {
    // 磁盘内容与传入 content 不同——断言索引结果来自传入值
    fs.writeFileSync(path.join(projectDir, 'a.md'), '# 磁盘旧内容\n\n[[b]]');
    const changed = indexFileLinks(projectId, projectDir, 'a.md', getConnection(), {
      content: '# 传入新内容\n\n[[c]] 和 [b](b.md)',
    });
    expect(changed).toBe(true);
    const out = queryOutlinks(getConnection(), projectId, 'a.md');
    expect(out.map((l) => l.to_path).sort()).toEqual(['b.md', 'c.md']);
    // meta 的 title 来自传入内容
    const meta = getConnection()
      .prepare('SELECT title FROM doc_meta WHERE project_id = ? AND file_path = ?')
      .get(projectId, 'a.md') as { title: string };
    expect(meta.title).toBe('传入新内容');
  });

  it('mtime+size 前置短路：索引后无 content 再次调用不读文件不重写', async () => {
    await fullGraphIndex(projectId, projectDir);
    await new Promise((r) => setTimeout(r, 1100));
    const before = getConnection()
      .prepare('SELECT indexed_at FROM doc_meta WHERE project_id = ? AND file_path = ?')
      .get(projectId, 'a.md') as { indexed_at: string };
    // 无 content（watcher 兜底路径）→ mtime+size 相同 → 直接短路
    const changed = indexFileLinks(projectId, projectDir, 'a.md', getConnection());
    expect(changed).toBe(false);
    const after = getConnection()
      .prepare('SELECT indexed_at FROM doc_meta WHERE project_id = ? AND file_path = ?')
      .get(projectId, 'a.md') as { indexed_at: string };
    expect(after.indexed_at).toBe(before.indexed_at);
  });

  it('事务包裹：replaceFileLinks 失败时 doc_meta 一并回滚', async () => {
    // 基线：先成功索引一次（a.md 的 meta title = A）
    indexFileLinks(projectId, projectDir, 'a.md', getConnection(), {
      content: '# A\n\n参见 [[b]]',
    });
    // 注入失败：验证 upsertDocMeta + replaceFileLinks 在同一事务内——
    // 失败后 doc_meta 保持旧值（不残留部分写入）
    vi.mocked(replaceFileLinks).mockImplementationOnce(() => {
      throw new Error('injected failure');
    });
    expect(() =>
      indexFileLinks(projectId, projectDir, 'a.md', getConnection(), {
        content: '# 新标题\n\n[[b]]',
      }),
    ).toThrow('injected failure');
    const meta = getConnection()
      .prepare('SELECT title FROM doc_meta WHERE project_id = ? AND file_path = ?')
      .get(projectId, 'a.md') as { title: string };
    expect(meta.title).toBe('A'); // 回滚：保持旧值
    vi.mocked(replaceFileLinks).mockClear();
  });
});

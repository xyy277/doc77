import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, getConnection } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { registerProject } from '../db/projects.js';
import { fullGraphIndex } from './indexer.js';
import {
  queryGraphNodes,
  queryGraphEdges,
  getGraphStatsMulti,
  queryOrphans,
  queryBrokenLinks,
  getGraphStats,
  deleteFileGraph,
} from './repository.js';

/**
 * 多项目查询层测试（二阶段：可视化 + 洞察的查询基础）。
 *
 * fixture：
 * - projA：a.md → [[b]]/[c](c.md)/[[不存在]](broken)、b.md → [[a]]、c.md → [[a]]、
 *   z.md（无链接 → 孤儿）、dangling.md（仅断链 [[ghost]] → 不算孤儿）、
 *   meta.md（frontmatter tags、无链接 → 孤儿）
 * - projB：d.md → [[e]]、e.md → [[d]]
 *
 * projA 期望：nodes 6 / edges 4 / broken 2 / orphans 2
 * projB 期望：nodes 2 / edges 2 / broken 0 / orphans 0
 */
describe('graph repository multi-project queries', () => {
  let testDir: string;
  let projAId: number;
  let projBId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-graph-repo-'));
    const dirA = path.join(testDir, 'projA');
    const dirB = path.join(testDir, 'projB');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'a.md'), '# A\n\n参见 [[b]] 和 [c](c.md) 以及 [[不存在]]');
    fs.writeFileSync(path.join(dirA, 'b.md'), '# B\n\n回链 [[a]]');
    fs.writeFileSync(path.join(dirA, 'c.md'), '# C\n\n引用 [[a]]');
    fs.writeFileSync(path.join(dirA, 'z.md'), '# Z\n\n没有任何链接');
    fs.writeFileSync(path.join(dirA, 'dangling.md'), '# Dangling\n\n指向 [[ghost]]');
    fs.writeFileSync(
      path.join(dirA, 'meta.md'),
      '---\ntags: [tech, notes]\n---\n\n# Meta\n\n无链接',
    );
    fs.writeFileSync(path.join(dirB, 'd.md'), '# D\n\n参见 [[e]]');
    fs.writeFileSync(path.join(dirB, 'e.md'), '# E\n\n回链 [[d]]');
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projAId = registerProject('GraphRepoA', dirA).id;
    projBId = registerProject('GraphRepoB', dirB).id;
    await fullGraphIndex(projAId, dirA);
    await fullGraphIndex(projBId, dirB);
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('queryGraphNodes：单/多项目，project_id 与原始 tags JSON 正确', () => {
    const nodes = queryGraphNodes(getConnection(), [projAId, projBId]);
    expect(nodes).toHaveLength(8); // 6 + 2
    // 排序：project_id 升序，同项目内 file_path 升序
    expect(nodes[0].project_id).toBe(projAId);
    expect(nodes[0].path).toBe('a.md');
    expect(nodes[6].project_id).toBe(projBId);
    expect(nodes[6].path).toBe('d.md');
    // tags 为原始 JSON 字符串（路由层解析）
    const meta = nodes.find((n) => n.path === 'meta.md')!;
    expect(JSON.parse(meta.tags)).toEqual(['tech', 'notes']);
    // 单项目
    const onlyB = queryGraphNodes(getConnection(), [projBId]);
    expect(onlyB.map((n) => n.path).sort()).toEqual(['d.md', 'e.md']);
  });

  it('queryGraphEdges：仅 resolved、项目隔离、源文件必须存在于 doc_meta', () => {
    const edges = queryGraphEdges(getConnection(), [projAId, projBId]);
    expect(edges).toHaveLength(6); // 4 + 2，broken 边（[[不存在]]/[[ghost]]）不出现
    expect(edges.every((e) => e.project_id === projAId || e.project_id === projBId)).toBe(true);
    expect(edges.filter((e) => e.project_id === projAId)).toHaveLength(4);
    expect(edges.filter((e) => e.project_id === projBId)).toHaveLength(2);

    // 删除 meta → 该文件的出链被排除（相关子查询过滤）；
    // 且入链 a→c 被 deleteFileGraph 置为 broken → 剩 a→b、b→a + projB 2 条
    deleteFileGraph(getConnection(), projAId, 'c.md');
    const after = queryGraphEdges(getConnection(), [projAId, projBId]);
    expect(after).toHaveLength(4);
    expect(after.some((e) => e.source === 'c.md')).toBe(false);
  });

  it('getGraphStatsMulti：total = Σ perProject，孤儿谓词与单项目一致', () => {
    const stats = getGraphStatsMulti(getConnection(), [projAId, projBId]);
    expect(stats.perProject).toHaveLength(2);
    const a = stats.perProject.find((p) => p.project_id === projAId)!;
    const b = stats.perProject.find((p) => p.project_id === projBId)!;
    expect(a).toMatchObject({ nodes: 6, edges: 4, broken: 2, orphans: 2 });
    expect(b).toMatchObject({ nodes: 2, edges: 2, broken: 0, orphans: 0 });
    expect(stats.total).toMatchObject({ nodes: 8, edges: 6, broken: 2, orphans: 2 });
    // 谓词一致性：perProject 与单项目查询完全相等
    expect(a.orphans).toBe(getGraphStats(getConnection(), projAId).orphans);
    expect(b.orphans).toBe(getGraphStats(getConnection(), projBId).orphans);
    expect(b.broken).toBe(getGraphStats(getConnection(), projBId).broken);
  });

  it('queryOrphans：rows/total/stats 三值一致；仅有断链出链的节点不算孤儿', () => {
    const { rows, total } = queryOrphans(getConnection(), [projAId, projBId], { limit: 10000 });
    const stats = getGraphStatsMulti(getConnection(), [projAId, projBId]);
    expect(rows).toHaveLength(2);
    expect(total).toBe(2);
    expect(total).toBe(stats.total.orphans);
    const paths = rows.map((r) => r.path).sort();
    expect(paths).toEqual(['meta.md', 'z.md']);
    expect(rows.every((r) => r.project_id === projAId)).toBe(true);
    // dangling.md 仅有断链出链 → 有出链（任意 status）→ 不算孤儿
    expect(paths).not.toContain('dangling.md');
    // title 存在
    expect(rows.every((r) => r.title.length > 0)).toBe(true);
  });

  it('queryOrphans：limit/offset 切片', () => {
    const page = queryOrphans(getConnection(), [projAId], { limit: 1, offset: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.rows[0].path).toBe('z.md'); // 排序后第 2 个（meta.md 在前）
  });

  it('queryBrokenLinks：仅 broken 行、字段齐全、updated_at DESC', () => {
    const stats = getGraphStatsMulti(getConnection(), [projAId, projBId]);
    const { rows, total } = queryBrokenLinks(getConnection(), [projAId, projBId], {
      limit: 500,
    });
    expect(total).toBe(2);
    expect(total).toBe(stats.total.broken);
    expect(rows).toHaveLength(2);
    // 死链行含规范化 to_path
    const aRow = rows.find((r) => r.from_path === 'a.md')!;
    expect(aRow.to_path).toBe('不存在');
    expect(aRow.display).toBeDefined();
    expect(aRow.updated_at).toBeDefined();

    // 把 a.md 的断链改为更早时间 → DESC 后 dangling.md 在前
    getConnection()
      .prepare("UPDATE doc_links SET updated_at = '2020-01-01 00:00:00' WHERE from_path = 'a.md'")
      .run();
    const ordered = queryBrokenLinks(getConnection(), [projAId], { limit: 500 });
    expect(ordered.rows[0].from_path).toBe('dangling.md');
    expect(ordered.rows[1].from_path).toBe('a.md');
  });

  it('queryBrokenLinks：limit/offset 分页', () => {
    const page = queryBrokenLinks(getConnection(), [projAId], { limit: 1, offset: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  it('空数组守卫：IN () 不抛错，返回空结果', () => {
    expect(queryGraphNodes(getConnection(), [])).toEqual([]);
    expect(queryGraphEdges(getConnection(), [])).toEqual([]);
    expect(getGraphStatsMulti(getConnection(), [])).toEqual({
      total: { nodes: 0, edges: 0, broken: 0, orphans: 0 },
      perProject: [],
    });
    expect(queryOrphans(getConnection(), [])).toEqual({ rows: [], total: 0 });
    expect(queryBrokenLinks(getConnection(), [])).toEqual({ rows: [], total: 0 });
  });
});

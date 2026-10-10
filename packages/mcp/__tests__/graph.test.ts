import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  initDatabase,
  closeConnection,
  runMigrations,
  registerProject,
  fullGraphIndex,
} from '@doc77/core';
import { graphBacklinks, graphRelated } from '../src/tools/graph.js';

/**
 * 图谱 MCP 只读工具测试（三阶段第 1 项，docs/design/knowledge-graph.md §10）。
 * 数据链路：markdown wikilink → fullGraphIndex → doc_links → 工具查询。
 */
describe('graph MCP tools', () => {
  let testDir: string;
  let projectId: number;
  let projDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-mcp-graph-${Date.now()}`);
    projDir = path.join(testDir, 'project');
    fs.mkdirSync(projDir, { recursive: true });

    // a ← b ← c 链 + 两个共同引用 a 的文档（co-citation 相关）
    fs.writeFileSync(path.join(projDir, 'a.md'), '# A\n\n链接 [[d]]');
    fs.writeFileSync(path.join(projDir, 'b.md'), '# B\n\n链接 [[a]]');
    fs.writeFileSync(path.join(projDir, 'c.md'), '# C\n\n链接 [[b]]');
    fs.writeFileSync(path.join(projDir, 'd.md'), '# D\n\n链接 [[a]]');
    fs.writeFileSync(path.join(projDir, 'lonely.md'), '# Lonely\n\n无任何链接');

    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('MCP Graph Test', projDir).id;
    await fullGraphIndex(projectId, projDir);
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('graphBacklinks 返回指向该文档的入链', () => {
    const rows = graphBacklinks(projectId, 'a.md');
    const froms = rows.map((r) => r.from_path).sort();
    expect(froms).toEqual(['b.md', 'd.md']);
    // title 来自 doc_meta（LEFT JOIN）
    expect(rows.find((r) => r.from_path === 'b.md')?.title).toBe('B');
  });

  it('graphBacklinks 对无入链文档返回空数组', () => {
    expect(graphBacklinks(projectId, 'lonely.md')).toEqual([]);
  });

  it('graphBacklinks limit clamp：上限 200、下限 1', () => {
    expect(graphBacklinks(projectId, 'a.md', { limit: 1 })).toHaveLength(1);
    // 超过上限被 clamp 到 200（本例只有 2 条入链 → 仍返回 2）
    expect(graphBacklinks(projectId, 'a.md', { limit: 9999 })).toHaveLength(2);
    // 负值/0 被 clamp 到 1
    expect(graphBacklinks(projectId, 'a.md', { limit: -5 })).toHaveLength(1);
  });

  it('graphRelated 返回相关文档（co-citation：b/d 共同引用 a，彼此相关）', () => {
    const rows = graphRelated(projectId, 'b.md', 5);
    expect(rows.length).toBeGreaterThan(0);
    // 分数降序
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score);
    }
    // d 与 b 共享出链 a → 应出现在相关列表
    expect(rows.map((r) => r.path)).toContain('d.md');
  });

  it('graphRelated limit clamp 到 20 上限', () => {
    const rows = graphRelated(projectId, 'b.md', 9999);
    expect(rows.length).toBeLessThanOrEqual(20);
  });

  it('项目不存在时抛错（不静默返回空）', () => {
    expect(() => graphBacklinks(99999, 'a.md')).toThrow(/Project not found/);
    expect(() => graphRelated(99999, 'a.md')).toThrow(/Project not found/);
  });
});

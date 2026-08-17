import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { registerProject } from '../db/projects.js';
import { renderMarkdown } from './markdown.js';

/**
 * Obsidian 模式 wikilink 渲染正确性（红队索引化后回归守卫）。
 * 渲染链修复点：每文档一次索引构建，链接解析 O(1)；node_modules 内
 * .md 不再作为 wikilink 目标（语义与图谱统一）。
 */
describe('renderMarkdown obsidian wikilink', () => {
  let testDir: string;
  let projectRoot: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-md-'));
    projectRoot = path.join(testDir, 'vault');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'Note A.md'), '# Note A');
    fs.mkdirSync(path.join(projectRoot, 'sub'));
    fs.writeFileSync(path.join(projectRoot, 'sub', 'Deep.md'), '# Deep');
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('MDTest', projectRoot).id;
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    // 每个测试重建 DB 后 projectId 复用（都是 1），必须清文件列表缓存
    // 防跨测试串扰（真实世界 projectId 唯一无此问题）
    const { clearWikilinkCache } = await import('./wikilink.js');
    clearWikilinkCache(projectId);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('obsidian 模式：wikilink 解析为 api 链接', () => {
    const html = renderMarkdown('见 [[Note A]]', {
      projectId,
      filePath: 'doc.md',
      obsidianMode: true,
    });
    expect(html).toContain(
      `href="/api/content/${projectId}?path=${encodeURIComponent('Note A.md')}"`,
    );
    expect(html).toContain('class="wikilink"');
  });

  it('obsidian 模式：死链渲染为 wikilink-dead span', () => {
    const html = renderMarkdown('见 [[不存在]]', {
      projectId,
      filePath: 'doc.md',
      obsidianMode: true,
    });
    expect(html).toContain('class="wikilink-dead"');
    expect(html).toContain('[[不存在]]');
  });

  it('obsidian 模式：子目录链接解析', () => {
    const html = renderMarkdown('见 [[Deep]]', {
      projectId,
      filePath: 'doc.md',
      obsidianMode: true,
    });
    expect(html).toContain(
      `href="/api/content/${projectId}?path=${encodeURIComponent('sub/Deep.md')}"`,
    );
  });

  it('非 obsidian 模式：wikilink 保持字面文本', () => {
    const html = renderMarkdown('见 [[Note A]]', { projectId, filePath: 'doc.md' });
    expect(html).not.toContain('class="wikilink"');
    expect(html).toContain('[[Note A]]');
  });

  it('node_modules 内 .md 不作为 wikilink 目标（语义与图谱统一）', () => {
    fs.mkdirSync(path.join(projectRoot, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'node_modules', 'pkg', 'Note A.md'), '# fake');
    const html = renderMarkdown('见 [[Note A]]', {
      projectId,
      filePath: 'doc.md',
      obsidianMode: true,
    });
    // 命中项目根的 Note A.md（非 node_modules 副本）——若解析到 node_modules
    // 会生成指向 node_modules 的 api URL
    expect(html).toContain(`path=${encodeURIComponent('Note A.md')}`);
    expect(html).not.toContain('node_modules');
  });
});

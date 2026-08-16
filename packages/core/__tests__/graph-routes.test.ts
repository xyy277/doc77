import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';
import { registerProject } from '../src/db/projects.js';
import { fullGraphIndex } from '../src/graph/indexer.js';

async function withServer(
  app: ReturnType<typeof createApp>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
  }
}

describe('Graph API', () => {
  let testDir: string;
  let projectDir: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-graph-api-'));
    projectDir = path.join(testDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a.md'), '# A\n\n参见 [[b]]');
    fs.writeFileSync(path.join(projectDir, 'b.md'), '# B\n\n回链 [[a]] 和 [c](c.md)');
    fs.writeFileSync(path.join(projectDir, 'c.md'), '# C\n\n引用 [[a]]');
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('GraphAPI', projectDir).id;
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('backlinks 返回入链（含 title）', async () => {
    await fullGraphIndex(projectId, projectDir);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${projectId}/backlinks?path=a.md`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as { backlinks: Array<{ from_path: string; title: string }> };
      expect(d.backlinks.map((b) => b.from_path).sort()).toEqual(['b.md', 'c.md']);
      expect(d.backlinks[0].title).toBeTruthy();
    });
  });

  it('related 返回 co-citation 邻居', async () => {
    await fullGraphIndex(projectId, projectDir);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${projectId}/related?path=b.md`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as { related: Array<{ path: string; score: number }> };
      // b 与 c 共享引用 a
      expect(d.related.map((r) => r.path)).toContain('c.md');
      expect(d.related[0].score).toBeGreaterThan(0);
    });
  });

  it('stats 返回节点/边/死链统计', async () => {
    await fullGraphIndex(projectId, projectDir);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${projectId}/stats`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as { nodes: number; edges: number; broken: number };
      expect(d.nodes).toBe(3);
      expect(d.edges).toBeGreaterThanOrEqual(3);
      expect(d.broken).toBeGreaterThanOrEqual(0);
    });
  });

  it('路径逃逸返回 403，非法项目返回 404', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const escape = await fetch(
        `${baseUrl}/api/graph/${projectId}/backlinks?path=${encodeURIComponent('../../etc/passwd')}`,
      );
      expect(escape.status).toBe(403);
      const missing = await fetch(`${baseUrl}/api/graph/99999/stats`);
      expect(missing.status).toBe(404);
      const badId = await fetch(`${baseUrl}/api/graph/abc/stats`);
      expect(badId.status).toBe(404);
    });
  });

  it('POST index 触发后台全量重建', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${projectId}/index`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('indexing');
      // 等待后台重建完成（walkDir 小项目秒级）
      await new Promise((r) => setTimeout(r, 500));
      const stats = (await (await fetch(`${baseUrl}/api/graph/${projectId}/stats`)).json()) as {
        nodes: number;
      };
      expect(stats.nodes).toBe(3);
    });
  });

  it('GET /api/graph/:id 返回节点与边（子图）', async () => {
    await fullGraphIndex(projectId, projectDir);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${projectId}?path=a.md`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as {
        nodes: Array<{ path: string }>;
        edges: Array<{ source: string; target: string }>;
      };
      expect(d.nodes.some((n) => n.path === 'a.md')).toBe(true);
      // 子图边只连接子图内节点
      const nodeSet = new Set(d.nodes.map((n) => n.path));
      expect(d.edges.every((e) => nodeSet.has(e.source) && nodeSet.has(e.target))).toBe(true);
    });
  });
});

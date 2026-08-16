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

  it('GET /api/graph/:id?mode=full 返回全部节点与边（可视化全量数据）', async () => {
    await fullGraphIndex(projectId, projectDir);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${projectId}?mode=full`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as {
        nodes: Array<{ path: string; title: string; tags: string[] }>;
        edges: Array<{ source: string; target: string }>;
        truncated: boolean;
      };
      expect(d.nodes).toHaveLength(3); // 全量：不受子图/limit 截断
      expect(d.truncated).toBe(false);
      expect(d.nodes.every((n) => Array.isArray(n.tags))).toBe(true);
      // 全量边只含 resolved，两端都在节点集内
      const nodeSet = new Set(d.nodes.map((n) => n.path));
      expect(d.edges.length).toBeGreaterThanOrEqual(3);
      expect(d.edges.every((e) => nodeSet.has(e.source) && nodeSet.has(e.target))).toBe(true);
      // mode=full 忽略 limit
      const fullWithLimit = await fetch(`${baseUrl}/api/graph/${projectId}?mode=full&limit=1`);
      const d2 = (await fullWithLimit.json()) as { nodes: Array<{ path: string }> };
      expect(d2.nodes).toHaveLength(3);
    });
  });
});

describe('Graph API — aggregate (multi-project)', () => {
  let testDir: string;
  let projADir: string;
  let projBDir: string;
  let projAId: number;
  let projBId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-graph-agg-'));
    projADir = path.join(testDir, 'projA');
    projBDir = path.join(testDir, 'projB');
    fs.mkdirSync(projADir, { recursive: true });
    fs.mkdirSync(projBDir, { recursive: true });
    // projA：a↔b 互链 + z 孤立页 + 断链 [[不存在]]
    fs.writeFileSync(path.join(projADir, 'a.md'), '# A\n\n参见 [[b]] 和 [[不存在]]');
    fs.writeFileSync(path.join(projADir, 'b.md'), '# B\n\n回链 [[a]]');
    fs.writeFileSync(path.join(projADir, 'z.md'), '# Z\n\n无链接');
    // projB：d↔e 互链
    fs.writeFileSync(path.join(projBDir, 'd.md'), '# D\n\n参见 [[e]]');
    fs.writeFileSync(path.join(projBDir, 'e.md'), '# E\n\n回链 [[d]]');
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projAId = registerProject('GraphAggA', projADir).id;
    projBId = registerProject('GraphAggB', projBDir).id;
    await fullGraphIndex(projAId, projADir);
    await fullGraphIndex(projBId, projBDir);
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('GET /api/graph?projects= 聚合两项目节点与边', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph?projects=${projAId},${projBId}`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as {
        projects: number[];
        nodes: Array<{ project_id: number; path: string; tags: string[] }>;
        edges: Array<{ project_id: number; source: string; target: string }>;
        truncated: boolean;
      };
      expect(d.projects).toEqual([projAId, projBId]);
      expect(d.nodes).toHaveLength(5); // 3 + 2
      expect(d.nodes.every((n) => Array.isArray(n.tags))).toBe(true);
      // 边带 project_id，计数 = 两项目求和（a↔b 2 条 + d↔e 2 条，断链不出现）
      expect(d.edges).toHaveLength(4);
      expect(d.edges.filter((e) => e.project_id === projAId)).toHaveLength(2);
      expect(d.edges.filter((e) => e.project_id === projBId)).toHaveLength(2);
      expect(d.truncated).toBe(false);
      // 两端都在节点集内（跨项目不得误连：source/target 同 project_id）
      const nodeSet = new Set(d.nodes.map((n) => `${n.project_id}:${n.path}`));
      expect(
        d.edges.every(
          (e) =>
            nodeSet.has(`${e.project_id}:${e.source}`) &&
            nodeSet.has(`${e.project_id}:${e.target}`),
        ),
      ).toBe(true);
    });
  });

  it('GET /api/graph?projects= 单项目只返回自身节点', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph?projects=${projBId}`);
      const d = (await res.json()) as { nodes: Array<{ path: string }> };
      expect(d.nodes.map((n) => n.path).sort()).toEqual(['d.md', 'e.md']);
    });
  });

  it('聚合守卫：缺参 400、格式非法 400/404、不存在项目 404', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      // 缺 projects → 400
      const missing = await fetch(`${baseUrl}/api/graph`);
      expect(missing.status).toBe(400);
      // 非法格式 → 404（空列表）
      const bad = await fetch(`${baseUrl}/api/graph?projects=abc`);
      expect(bad.status).toBe(404);
      // 含不存在项目 → 404
      const ghost = await fetch(`${baseUrl}/api/graph?projects=${projAId},99999`);
      expect(ghost.status).toBe(404);
      // 聚合 stats 无参 → 400（证明聚合路由注册在 :id 之前，未被吞掉）
      const statsMissing = await fetch(`${baseUrl}/api/graph/stats`);
      expect(statsMissing.status).toBe(400);
    });
  });

  it('GET /api/graph/stats?projects= total = 分项求和，与单项目 stats 一致', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/stats?projects=${projAId},${projBId}`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as {
        projects: number[];
        total: { nodes: number; edges: number; broken: number; orphans: number };
        perProject: Array<{ project_id: number } & typeof d.total>;
      };
      expect(d.total).toMatchObject({ nodes: 5, edges: 4, broken: 1, orphans: 1 });
      expect(d.perProject).toHaveLength(2);
      const a = d.perProject.find((p) => p.project_id === projAId)!;
      expect(a).toMatchObject({ nodes: 3, edges: 2, broken: 1, orphans: 1 });
      // 与单项目 stats 端点一致
      const single = (await (await fetch(`${baseUrl}/api/graph/${projAId}/stats`)).json()) as {
        orphans: number;
      };
      expect(a.orphans).toBe(single.orphans);
    });
  });

  it('GET /api/graph/orphans?projects= 列表与 stats 计数一致', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/orphans?projects=${projAId}`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as {
        orphans: Array<{ project_id: number; path: string; title: string }>;
        total: number;
      };
      expect(d.total).toBe(1);
      expect(d.orphans).toHaveLength(1);
      expect(d.orphans[0].path).toBe('z.md');
      expect(d.orphans[0].title).toBeTruthy();
      const stats = (await (await fetch(`${baseUrl}/api/graph/${projAId}/stats`)).json()) as {
        orphans: number;
      };
      expect(d.total).toBe(stats.orphans);
      // limit/offset 切片生效（total 仍为全量计数）
      const limited = await fetch(
        `${baseUrl}/api/graph/orphans?projects=${projAId}&limit=1&offset=1`,
      );
      const d2 = (await limited.json()) as { orphans: Array<unknown>; total: number };
      expect(d2.orphans).toHaveLength(0);
      expect(d2.total).toBe(1);
    });
  });

  it('GET /api/graph/broken?projects= 列表与 stats 计数一致', async () => {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/broken?projects=${projAId},${projBId}`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as {
        broken: Array<{ from_path: string; to_path: string; display: string; anchor: string }>;
        total: number;
      };
      expect(d.total).toBe(1);
      expect(d.broken).toHaveLength(1);
      expect(d.broken[0].from_path).toBe('a.md');
      expect(d.broken[0].to_path).toBe('不存在');
      const stats = (await (
        await fetch(`${baseUrl}/api/graph/stats?projects=${projAId},${projBId}`)
      ).json()) as { total: { broken: number } };
      expect(d.total).toBe(stats.total.broken);
    });
  });
});

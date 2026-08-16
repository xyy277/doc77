import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, getConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';
import { registerProject } from '../src/db/projects.js';

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

/**
 * 图谱全量模式上限（FULL_NODE_CAP=20000 / FULL_EDGE_CAP=200000）与
 * limit 参数加固的回归测试（独立验证 Phase 2）。
 * 大 fixture 用 raw SQL 单事务插入（不用 fullGraphIndex，20k 节点 ~1-2s）。
 */
describe('graph truncation (FULL caps) + limit hardening', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-graph-cap-'));
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** raw SQL 造节点（仅 doc0.md 有真实磁盘文件，供 backlinks 等 path 校验路由）；返回 project id */
  function seedNodes(nNodes: number, edgesPerNode: number): number {
    const dir = path.join(testDir, `raw-${nNodes}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'doc0.md'), '# Doc 0\n');
    const pid = registerProject(`Raw${nNodes}`, dir).id;
    const conn = getConnection();
    const tx = conn.transaction(() => {
      const insNode = conn.prepare(
        'INSERT INTO doc_meta (project_id, file_path, title, tags) VALUES (?, ?, ?, ?)',
      );
      for (let i = 0; i < nNodes; i++) insNode.run(pid, `doc${i}.md`, `Doc ${i}`, '["tag-a"]');
      if (edgesPerNode > 0) {
        const insEdge = conn.prepare(
          `INSERT INTO doc_links (project_id, from_path, to_path, link_type, anchor, status, display)
           VALUES (?, ?, ?, 'wikilink', '', 'resolved', '')`,
        );
        for (let i = 0; i < nNodes; i++) {
          for (let j = 1; j <= edgesPerNode; j++) {
            insEdge.run(pid, `doc${i}.md`, `doc${(i + j * 7) % nNodes}.md`);
          }
        }
      }
    });
    tx();
    return pid;
  }

  it('mode=full：节点数截断于 20000 并置 truncated=true', async () => {
    const pid = seedNodes(20001, 1);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${pid}?mode=full`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as { nodes: unknown[]; truncated: boolean };
      expect(d.nodes).toHaveLength(20000);
      expect(d.truncated).toBe(true);
    });
  });

  it('mode=full：边数截断于 200000（节点未超限）', async () => {
    const pid = seedNodes(20000, 11); // 220k 边
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${pid}?mode=full`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as { nodes: unknown[]; edges: unknown[]; truncated: boolean };
      expect(d.nodes).toHaveLength(20000); // 节点未截断
      expect(d.edges).toHaveLength(200000);
      expect(d.truncated).toBe(true);
    });
  });

  it('聚合路由：节点数同样受 FULL 上限约束（truncated 有意义）', async () => {
    const pid = seedNodes(20001, 1);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph?projects=${pid}`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as { nodes: unknown[]; truncated: boolean };
      // 修复前：无 LIMIT → 20001 全量返回（truncated=true 无意义）；修复后：截断于 20000
      expect(d.nodes.length).toBeLessThanOrEqual(20000);
      expect(d.truncated).toBe(true);
    });
  });

  it('恰好 20000 节点不误报 truncated（>= vs >）', async () => {
    const pid = seedNodes(20000, 1);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${pid}?mode=full`);
      const d = (await res.json()) as { nodes: unknown[]; truncated: boolean };
      expect(d.nodes).toHaveLength(20000);
      expect(d.truncated).toBe(false);
    });
  });

  it('5000 节点 × 2 边：payload < 5MB 且均摊 < 400B/节点', async () => {
    const pid = seedNodes(5000, 2);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph?projects=${pid}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      const bytes = Buffer.byteLength(text, 'utf-8');
      const d = JSON.parse(text) as { nodes: unknown[] };
      expect(bytes).toBeLessThan(5 * 1024 * 1024);
      expect(bytes / d.nodes.length).toBeLessThan(400);
      console.log(
        `[graph-cap] 5000-node payload: ${(bytes / 1024).toFixed(0)}KB, ${(bytes / d.nodes.length).toFixed(0)}B/node`,
      );
    });
  });

  // ── limit 加固回归（修复前红）：负 limit 不得绕过上限 ──

  it('limit=-1 不得绕过子图 2000 上限', async () => {
    const pid = seedNodes(3000, 2);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/graph/${pid}?limit=-1`);
      expect(res.status).toBe(200);
      const d = (await res.json()) as { nodes: unknown[] };
      expect(d.nodes.length).toBeLessThanOrEqual(2000);
    });
  });

  it('负 limit 不得绕过 orphans/broken/backlinks/related 上限', async () => {
    const pid = seedNodes(500, 2);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const orphans = await fetch(`${baseUrl}/api/graph/orphans?projects=${pid}&limit=-5`);
      const o = (await orphans.json()) as { orphans: unknown[] };
      expect(o.orphans.length).toBeLessThanOrEqual(200);

      const broken = await fetch(`${baseUrl}/api/graph/broken?projects=${pid}&limit=-5`);
      const b = (await broken.json()) as { broken: unknown[] };
      expect(b.broken.length).toBeLessThanOrEqual(100);

      const backlinks = await fetch(`${baseUrl}/api/graph/${pid}/backlinks?path=doc0.md&limit=-5`);
      const bl = (await backlinks.json()) as { backlinks: unknown[] };
      expect(bl.backlinks.length).toBeLessThanOrEqual(200);

      const related = await fetch(`${baseUrl}/api/graph/${pid}/related?path=doc0.md&limit=-5`);
      const r = (await related.json()) as { related: unknown[] };
      expect(r.related.length).toBeLessThanOrEqual(20);
    });
  });

  it('limit=0 / limit=abc 回退默认上限（回归守卫）', async () => {
    const pid = seedNodes(500, 2);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const zero = await fetch(`${baseUrl}/api/graph/orphans?projects=${pid}&limit=0`);
      expect(((await zero.json()) as { orphans: unknown[] }).orphans.length).toBeLessThanOrEqual(
        200,
      );
      const garbage = await fetch(`${baseUrl}/api/graph/orphans?projects=${pid}&limit=abc`);
      expect(((await garbage.json()) as { orphans: unknown[] }).orphans.length).toBeLessThanOrEqual(
        200,
      );
    });
  });

  it('projects 参数严格整数：1.5 / 1e2 不得静默截断', async () => {
    const pid = seedNodes(10, 1);
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      // 修复前 parseInt('1.5')=1 → 静默返回项目 1；修复后应 404
      const dot = await fetch(`${baseUrl}/api/graph/${pid}.5/stats`);
      expect(dot.status).toBe(404);
      const sci = await fetch(`${baseUrl}/api/graph?projects=${pid}e2`);
      expect(sci.status).toBe(404);
    });
  });
});

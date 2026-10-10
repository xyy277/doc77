import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { registerProject } from '../src/db/projects.js';
import { createApp } from '../src/server/app.js';

/**
 * 离线缓存清单 `/api/offline/manifest`（spec 01 Phase 2）。
 */
async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

interface Manifest {
  generated_at: string;
  total: number;
  total_bytes: number;
  truncated: boolean;
  projects: Array<{ id: number; name: string; documents: number }>;
  documents: Array<{
    project_id: number;
    path: string;
    title: string;
    size: number;
    modified: string;
  }>;
}

describe('GET /api/offline/manifest', () => {
  let testDir: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-offline-'));
    const projDir = path.join(testDir, 'vault');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'a.md'), '# A\n\nhello');
    fs.writeFileSync(path.join(projDir, 'b.txt'), 'plain text');
    fs.writeFileSync(path.join(projDir, 'code.ts'), 'export const x = 1;');
    // 不支持的二进制格式 → 不应出现在清单
    fs.writeFileSync(path.join(projDir, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    fs.mkdirSync(path.join(projDir, 'sub'));
    fs.writeFileSync(path.join(projDir, 'sub', 'c.md'), '# C');

    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('Offline Test', projDir).id;
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('返回可缓存文档清单（含子目录、含大小与修改时间）', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/offline/manifest?projectId=${projectId}`);
      expect(res.status).toBe(200);
      const m = (await res.json()) as Manifest;
      const paths = m.documents.map((d) => d.path).sort();
      expect(paths).toContain('a.md');
      expect(paths).toContain('b.txt');
      expect(paths).toContain('code.ts');
      expect(paths).toContain('sub/c.md');
      expect(m.total).toBe(m.documents.length);
      expect(m.total_bytes).toBeGreaterThan(0);
      expect(m.truncated).toBe(false);
      const a = m.documents.find((d) => d.path === 'a.md')!;
      expect(a.project_id).toBe(projectId);
      expect(a.title).toBe('a');
      expect(a.size).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(a.modified))).toBe(false);
    });
  });

  it('排除不支持的格式（zip 不在清单内）', async () => {
    await withServer(async (base) => {
      const m = (await (
        await fetch(`${base}/api/offline/manifest?projectId=${projectId}`)
      ).json()) as Manifest;
      expect(m.documents.map((d) => d.path)).not.toContain('archive.zip');
    });
  });

  it('limit 生效并置 truncated', async () => {
    await withServer(async (base) => {
      const m = (await (
        await fetch(`${base}/api/offline/manifest?projectId=${projectId}&limit=2`)
      ).json()) as Manifest;
      expect(m.documents).toHaveLength(2);
      expect(m.truncated).toBe(true);
      // limit 非法值 → 回落默认（不 500）
      const m2 = (await (
        await fetch(`${base}/api/offline/manifest?projectId=${projectId}&limit=abc`)
      ).json()) as Manifest;
      expect(m2.documents.length).toBeGreaterThan(0);
    });
  });

  it('非法 / 不存在的 projectId 返回 400 / 404', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/offline/manifest?projectId=abc`)).status).toBe(400);
      expect((await fetch(`${base}/api/offline/manifest?projectId=999999`)).status).toBe(404);
    });
  });

  it('不带 projectId → 汇总全部项目', async () => {
    await withServer(async (base) => {
      const m = (await (await fetch(`${base}/api/offline/manifest`)).json()) as Manifest;
      expect(m.projects.length).toBe(1);
      expect(m.projects[0].id).toBe(projectId);
      expect(m.projects[0].documents).toBeGreaterThan(0);
      expect(Date.parse(m.generated_at)).not.toBeNaN();
    });
  });
});

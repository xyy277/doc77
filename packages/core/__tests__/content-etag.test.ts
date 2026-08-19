import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as http from 'node:http';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { registerProject } from '../src/db/projects.js';
import { createApp } from '../src/server/app.js';
import { stopFileWatcher } from '../src/server/watcher.js';

/**
 * /api/content markdown 分支 ETag/304（红队修复：重复打开文档免全量渲染）。
 */
async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
  }
}

describe('GET /api/content/:id ETag/304', () => {
  let testDir: string;
  let projectDir: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-etag-'));
    projectDir = path.join(testDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a.md'), '# A\n\n[[不存在]]', 'utf-8');
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('EtagTest', projectDir).id;
  });

  afterEach(async () => {
    try {
      stopFileWatcher();
    } catch {
      /* ignore */
    }
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('首次 200 + ETag 头；带 If-None-Match 二次请求 304', async () => {
    await withServer(async (baseUrl) => {
      const url = `${baseUrl}/api/content/${projectId}?path=${encodeURIComponent('a.md')}`;
      const first = await fetch(url);
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag');
      expect(etag).toBeTruthy();
      expect(first.headers.get('cache-control')).toContain('must-revalidate');

      const second = await fetch(url, { headers: { 'if-none-match': etag! } });
      expect(second.status).toBe(304);
      expect(await second.text()).toBe('');
    });
  });

  it('文件保存后 etag 失效：再次请求 200 新内容', async () => {
    await withServer(async (baseUrl) => {
      const url = `${baseUrl}/api/content/${projectId}?path=${encodeURIComponent('a.md')}`;
      const first = await fetch(url);
      const etag = first.headers.get('etag')!;

      // 修改文件（mtime 变化 → etag 变化）
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(path.join(projectDir, 'a.md'), '# A 更新\n\n新内容', 'utf-8');

      const second = await fetch(url, { headers: { 'if-none-match': etag } });
      expect(second.status).toBe(200);
      const d = (await second.json()) as { content: string };
      expect(d.content).toContain('A 更新');
      expect(second.headers.get('etag')).not.toBe(etag);
    });
  });

  it('ETag 保留 mtime 小数精度（同秒内修改不与旧 etag 碰撞）', async () => {
    await withServer(async (baseUrl) => {
      const file = path.join(projectDir, 'a.md');
      const t = 1700000000.123; // 亚秒小数 mtime
      fs.utimesSync(file, t, t);
      const st = fs.statSync(file);

      const url = `${baseUrl}/api/content/${projectId}?path=${encodeURIComponent('a.md')}`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBe(`"${st.size}-${st.mtimeMs}"`);
      // 说明：支持亚毫秒精度 mtime 的文件系统（ext4/tmpfs）上，旧 Math.round 实现
      // 会把 1700000000.123 截断成 1700000000，etag 断言必然失败 → 捕获精度回归；
      // 粗粒度文件系统（FAT/drvfs）stat 本身即整数，两种实现等价（文档化局限）。
    });
  });
});

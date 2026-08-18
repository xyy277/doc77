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
 * 保存原子写（tmp+rename 替换 shadow）的 route 级验证。
 * 修复前每次保存整文件复制到 shadow 后立即删除（成功路径白做）；
 * 原子写失败时原文件从未被触碰。
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

describe('PUT /api/content/:id 原子写', () => {
  let testDir: string;
  let projectDir: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-save-'));
    projectDir = path.join(testDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a.md'), '# A\n\n旧内容', 'utf-8');
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('SaveTest', projectDir).id;
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

  it('保存成功：内容正确写入、无 tmp 残留、响应带新 mtime', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/content/${projectId}?path=${encodeURIComponent('a.md')}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: '# A\n\n新内容' }),
        },
      );
      expect(res.status).toBe(200);
      const d = (await res.json()) as { ok: boolean; modified: string };
      expect(d.ok).toBe(true);
      expect(new Date(d.modified).getTime()).toBeGreaterThan(0);
      // 内容正确写入
      expect(fs.readFileSync(path.join(projectDir, 'a.md'), 'utf-8')).toBe('# A\n\n新内容');
      // 无 tmp 残留
      const leftovers = fs.readdirSync(projectDir).filter((f) => f.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    });
  });

  it('写失败（目标是目录）：500 且原内容保持、无 tmp 残留', async () => {
    fs.mkdirSync(path.join(projectDir, 'dir.md'));
    await withServer(async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/content/${projectId}?path=${encodeURIComponent('dir.md')}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: '写入到目录会失败' }),
        },
      );
      expect(res.status).toBe(500);
      // 目标仍是目录（原内容未被触碰）
      expect(fs.statSync(path.join(projectDir, 'dir.md')).isDirectory()).toBe(true);
      // 无 tmp 残留
      const leftovers = fs.readdirSync(projectDir).filter((f) => f.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';
import { registerProject } from '../src/db/projects.js';
import { getEventBus, resetEventBus } from '../src/server/event-bus.js';

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

describe('API Endpoints', () => {
  let testDir: string;
  let dbPath: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-api-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');

    projectDir = path.join(testDir, 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hello\nWorld');
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'plain text');
    fs.mkdirSync(path.join(projectDir, 'docs'));
    fs.writeFileSync(path.join(projectDir, 'docs', 'api.md'), '## API Docs');

    await initDatabase(dbPath);
    runMigrations();
    resetEventBus(); // 隔离全局事件总线，避免测试间事件串扰
  });

  // 订阅一次写操作事件并断言 payload（projectId/path/opType/paths）
  function expectTreeEvent(
    projectId: number,
    predicate: (p: { projectId: number; opType: string; path: string; paths: string[] }) => boolean,
  ): Promise<{ opType: string; path: string; paths: string[] }> {
    return new Promise((resolve, reject) => {
      const bus = getEventBus();
      const timer = setTimeout(() => {
        bus.off('file-tree:changed', listener);
        reject(new Error('timed out waiting for file-tree:changed event'));
      }, 3000);
      const listener = (p: unknown) => {
        const payload = p as { projectId: number; opType: string; path: string; paths: string[] };
        if (payload.projectId === projectId && predicate(payload)) {
          clearTimeout(timer);
          bus.off('file-tree:changed', listener);
          resolve(payload);
        }
      };
      bus.on('file-tree:changed', listener);
    });
  }

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Project API', () => {
    it('POST /api/projects should register a project', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test', path: projectDir }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as any;
        expect(body.id).toBeGreaterThan(0);
        expect(body.name).toBe('Test');
      });
    });

    it('POST /api/projects should reject missing fields', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
      });
    });

    it('GET /api/projects should list projects', async () => {
      registerProject('A', projectDir);
      const dir2 = path.join(testDir, 'proj-b');
      fs.mkdirSync(dir2);
      registerProject('B', dir2);

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/projects`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body).toHaveLength(2);
      });
    });

    it('DELETE /api/projects/:id should remove a project', async () => {
      const p = registerProject('ToDelete', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/projects/${p.id}`, {
          method: 'DELETE',
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.removed).toBe(true);
      });
    });
  });

  describe('Tree API', () => {
    it('GET /api/tree/:id should return directory listing', async () => {
      const p = registerProject('TreeTest', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/tree/${p.id}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.path).toBe('');
        expect(body.entries.length).toBeGreaterThan(0);
        expect(body.entries.some((e: { name: string }) => e.name === 'README.md')).toBe(true);
      });
    });

    it('GET /api/tree/:id?path= should support subdirectory', async () => {
      const p = registerProject('SubTree', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/tree/${p.id}?path=docs`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.path).toBe('docs');
        expect(body.entries.some((e: { name: string }) => e.name === 'api.md')).toBe(true);
      });
    });

    it('GET /api/tree/:id should return 404 for invalid project', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/tree/99999`);
        expect(res.status).toBe(404);
      });
    });
  });

  describe('Content API', () => {
    it('GET /api/content/:id should return rendered markdown', async () => {
      const p = registerProject('ContentTest', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/content/${p.id}?path=README.md`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.type).toBe('markdown');
        expect(body.content).toContain('<h1');
      });
    });

    it('GET /api/content/:id should return code for .txt files', async () => {
      const p = registerProject('CodeTest', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/content/${p.id}?path=notes.txt`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.type).toBeDefined();
      });
    });

    it('GET /api/content/:id should return 404 for missing file', async () => {
      const p = registerProject('NoFile', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/content/${p.id}?path=nope.missing`);
        expect(res.status).toBe(404);
      });
    });
  });

  describe('Raw API', () => {
    it('GET /api/raw/:id should return markdown source with text/markdown', async () => {
      const p = registerProject('RawTest', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/raw/${p.id}?path=README.md`);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('text/markdown');
        const body = await res.text();
        expect(body).toBe('# Hello\nWorld'); // 源码原样，非渲染 HTML
      });
    });

    it('GET /api/raw/:id should return image bytes for binary files', async () => {
      const p = registerProject('RawImg', projectDir);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      fs.writeFileSync(path.join(projectDir, 'pixel.png'), png);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/raw/${p.id}?path=pixel.png`);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/png');
        const body = Buffer.from(await res.arrayBuffer());
        expect(body).toEqual(png);
      });
    });

    it('GET /api/raw/:id should 404 on path traversal', async () => {
      const p = registerProject('RawTrav', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/api/raw/${p.id}?path=${encodeURIComponent('../../etc/passwd')}`,
        );
        expect(res.status).toBe(404);
      });
    });
  });

  describe('Tree Write API (POST/PUT/DELETE — SW 修复回归覆盖)', () => {
    it('POST /api/tree/:id/file creates a file and emits file-tree:changed', async () => {
      const p = registerProject('TreeCreate', projectDir);
      const app = createApp();
      const eventPromise = expectTreeEvent(p.id, (x) => x.opType === 'create_file');
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/tree/${p.id}/file?path=`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'fresh.md' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.path).toBe('fresh.md');
        expect(body.type).toBe('file');
        expect(fs.existsSync(path.join(projectDir, 'fresh.md'))).toBe(true);
      });
      const ev = await eventPromise;
      expect(ev.path).toBe('');
      expect(ev.paths).toEqual(['fresh.md']);
    });

    it('POST file in subdirectory — event path 为相对目录', async () => {
      const p = registerProject('TreeCreateSub', projectDir);
      const app = createApp();
      const eventPromise = expectTreeEvent(p.id, (x) => x.opType === 'create_file');
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/tree/${p.id}/file?path=docs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'sub.md' }),
        });
        expect(res.status).toBe(200);
      });
      const ev = await eventPromise;
      expect(ev.path).toBe('docs');
      expect(ev.paths).toEqual(['docs/sub.md']);
    });

    it('POST file duplicate returns 409, invalid name returns 400', async () => {
      const p = registerProject('TreeCreateErr', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const dup = await fetch(`${baseUrl}/api/tree/${p.id}/file?path=`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'README.md' }),
        });
        expect(dup.status).toBe(409);

        const bad = await fetch(`${baseUrl}/api/tree/${p.id}/file?path=`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'a/b.md' }),
        });
        expect(bad.status).toBe(400);
      });
    });

    it('POST /api/tree/:id/folder creates a folder and emits event', async () => {
      const p = registerProject('TreeMkdir', projectDir);
      const app = createApp();
      const eventPromise = expectTreeEvent(p.id, (x) => x.opType === 'create_folder');
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/tree/${p.id}/folder?path=`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'newdir' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.path).toBe('newdir');
        expect(fs.statSync(path.join(projectDir, 'newdir')).isDirectory()).toBe(true);
      });
      const ev = await eventPromise;
      expect(ev.paths).toEqual(['newdir']);
    });

    it('POST folder with traversal name returns 400', async () => {
      const p = registerProject('TreeMkdirBad', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/tree/${p.id}/folder?path=`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '..' }),
        });
        expect(res.status).toBe(400);
      });
    });

    it('PUT /api/tree/:id/rename renames on disk and emits event with old+new paths', async () => {
      const p = registerProject('TreeRename', projectDir);
      const app = createApp();
      const eventPromise = expectTreeEvent(p.id, (x) => x.opType === 'rename');
      await withServer(app, async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/api/tree/${p.id}/rename?path=${encodeURIComponent('notes.txt')}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName: 'renamed.txt' }),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.oldPath).toBe('notes.txt');
        expect(body.newPath).toBe('renamed.txt');
        expect(fs.existsSync(path.join(projectDir, 'renamed.txt'))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'notes.txt'))).toBe(false);
      });
      const ev = await eventPromise;
      expect(ev.paths).toEqual(['notes.txt', 'renamed.txt']);
    });

    it('PUT rename missing target 404, target conflict 409', async () => {
      const p = registerProject('TreeRenameErr', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const missing = await fetch(
          `${baseUrl}/api/tree/${p.id}/rename?path=${encodeURIComponent('nope.md')}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName: 'x.md' }),
          },
        );
        expect(missing.status).toBe(404);

        const conflict = await fetch(
          `${baseUrl}/api/tree/${p.id}/rename?path=${encodeURIComponent('README.md')}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName: 'notes.txt' }),
          },
        );
        expect(conflict.status).toBe(409);
      });
    });

    it('DELETE /api/tree/:id moves file to .doc77-trash and emits event', async () => {
      const p = registerProject('TreeDelete', projectDir);
      const app = createApp();
      const eventPromise = expectTreeEvent(p.id, (x) => x.opType === 'delete');
      await withServer(app, async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/api/tree/${p.id}?path=${encodeURIComponent('notes.txt')}`,
          { method: 'DELETE' },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.movedToTrash).toBe(true);
        expect(fs.existsSync(path.join(projectDir, 'notes.txt'))).toBe(false);
        const trash = fs.readdirSync(path.join(projectDir, '.doc77-trash'));
        expect(trash.length).toBe(1);
        expect(trash[0].endsWith('-notes.txt')).toBe(true);
      });
      const ev = await eventPromise;
      expect(ev.paths).toEqual(['notes.txt']);
    });

    it('DELETE missing 404, non-empty directory 400', async () => {
      const p = registerProject('TreeDeleteErr', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const missing = await fetch(
          `${baseUrl}/api/tree/${p.id}?path=${encodeURIComponent('nope.md')}`,
          { method: 'DELETE' },
        );
        expect(missing.status).toBe(404);

        const nonEmpty = await fetch(
          `${baseUrl}/api/tree/${p.id}?path=${encodeURIComponent('docs')}`,
          { method: 'DELETE' },
        );
        expect(nonEmpty.status).toBe(400);
      });
    });

    it('POST /api/tree/:id/refresh 强制清缓存（外部写入后 GET 反映磁盘状态）', async () => {
      const p = registerProject('TreeRefresh', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const before = (await (await fetch(`${baseUrl}/api/tree/${p.id}`)).json()) as any;
        expect(before.entries.some((e: { name: string }) => e.name === 'added.md')).toBe(false);
        // 外部（不经 API）写文件后，显式刷新缓存
        fs.writeFileSync(path.join(projectDir, 'added.md'), 'x');
        const refresh = await fetch(`${baseUrl}/api/tree/${p.id}/refresh`, { method: 'POST' });
        expect(refresh.status).toBe(200);
        const after = (await (await fetch(`${baseUrl}/api/tree/${p.id}`)).json()) as any;
        expect(after.entries.some((e: { name: string }) => e.name === 'added.md')).toBe(true);
      });
    });

    it('GET /api/events streams file-tree:changed unconditionally (no MCP needed)', async () => {
      const p = registerProject('TreeSSE', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/events`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        // 在连接打开后触发事件，读取流应包含该事件
        const controller = new AbortController();
        const readPromise = (async () => {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let acc = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            acc += decoder.decode(value, { stream: true });
            if (acc.includes('file-tree:changed')) return acc;
          }
          return acc;
        })();
        getEventBus().emit('file-tree:changed', {
          projectId: p.id,
          path: '',
          opType: 'modify',
          paths: ['README.md'],
        });
        const streamed = await Promise.race([
          readPromise,
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('SSE stream timeout')), 3000),
          ),
        ]);
        expect(streamed).toContain('file-tree:changed');
        expect(streamed).toContain('README.md');
        controller.abort();
      });
    });
  });

  describe('Reveal API', () => {
    it('GET /api/reveal/:id should return ok for valid file', async () => {
      const p = registerProject('RevealTest', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/reveal/${p.id}?path=README.md&action=reveal`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.ok).toBe(true);
        expect(body.action).toBe('reveal');
      });
    });

    it('GET /api/reveal/:id should require path parameter', async () => {
      const p = registerProject('Reveal2', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/reveal/${p.id}`);
        expect(res.status).toBe(400);
      });
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
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
  });

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
        const body = await res.json();
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
        const body = await res.json();
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
        const body = await res.json();
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
        const body = await res.json();
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
        const body = await res.json();
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
        const body = await res.json();
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
        const body = await res.json();
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

  describe('Reveal API', () => {
    it('GET /api/reveal/:id should return ok for valid file', async () => {
      const p = registerProject('RevealTest', projectDir);
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/reveal/${p.id}?path=README.md&action=reveal`);
        expect(res.status).toBe(200);
        const body = await res.json();
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

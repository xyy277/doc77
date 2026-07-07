import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';

/**
 * Helper: start server on random port, run test, then close.
 */
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

describe('Express Server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `doc77-server-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    initDatabase(dbPath);
    runMigrations();
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('GET /api/health', () => {
    it('should return status ok with DB connection info', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/health`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
        expect(body.db).toBe('connected');
        expect(body.timestamp).toBeDefined();
      });
    });

    it('should include version info', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/health`);
        const body = await res.json();
        expect(body.version).toBeDefined();
      });
    });
  });

  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/health`, {
          headers: { Origin: 'http://localhost:3000' },
        });
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
      });
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown API routes', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/nonexistent`);
        expect(res.status).toBe(404);
      });
    });
  });

  describe('Server stability', () => {
    it('should handle concurrent requests', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const results = await Promise.all([
          fetch(`${baseUrl}/api/health`),
          fetch(`${baseUrl}/api/health`),
          fetch(`${baseUrl}/api/health`),
        ]);
        for (const res of results) {
          expect(res.status).toBe(200);
        }
      });
    });
  });
});

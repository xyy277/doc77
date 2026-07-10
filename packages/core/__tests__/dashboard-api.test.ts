import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';

const TEST_DB = path.join(os.tmpdir(), 'doc77-test-dashboard-' + Date.now() + '.db');

beforeAll(async () => {
  await initDatabase(TEST_DB);
  runMigrations();
});

afterAll(() => {
  closeConnection();
  try { fs.unlinkSync(TEST_DB); } catch {}
});

describe('Schema migrations for Dashboard 2.0', () => {
  it('creates favorites table', () => {
    const db = getConnection();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='favorites'"
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe('favorites');
  });

  it('creates recent_files table', () => {
    const db = getConnection();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recent_files'"
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe('recent_files');
  });

  it('favorites has ON DELETE CASCADE', () => {
    const db = getConnection();
    // Insert a project, favorite it, delete project, verify favorite is gone
    db.prepare("INSERT INTO projects (name, path) VALUES ('test-proj', '/tmp/test-proj')").run();
    const proj = db.prepare("SELECT id FROM projects WHERE name = 'test-proj'").get() as { id: number };
    db.prepare('INSERT INTO favorites (project_id) VALUES (?)').run(proj.id);
    let fav = db.prepare('SELECT * FROM favorites WHERE project_id = ?').get(proj.id);
    expect(fav).toBeTruthy();
    db.prepare('DELETE FROM projects WHERE id = ?').run(proj.id);
    fav = db.prepare('SELECT * FROM favorites WHERE project_id = ?').get(proj.id);
    expect(fav).toBeUndefined();
  });

  it('recent_files has ON DELETE CASCADE', () => {
    const db = getConnection();
    db.prepare("INSERT INTO projects (name, path) VALUES ('test-proj2', '/tmp/test-proj2')").run();
    const proj = db.prepare("SELECT id FROM projects WHERE name = 'test-proj2'").get() as { id: number };
    db.prepare('INSERT INTO recent_files (project_id, file_name, file_path) VALUES (?, ?, ?)').run(proj.id, 'test.md', 'docs/test.md');
    let rf = db.prepare('SELECT * FROM recent_files WHERE project_id = ?').get(proj.id);
    expect(rf).toBeTruthy();
    db.prepare('DELETE FROM projects WHERE id = ?').run(proj.id);
    rf = db.prepare('SELECT * FROM recent_files WHERE project_id = ?').get(proj.id);
    expect(rf).toBeUndefined();
  });
});

describe('Dashboard 2.0 API endpoints', () => {
  let app: ReturnType<typeof createApp>;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = createApp();
    // Seed test data
    const db = getConnection();
    db.prepare("INSERT OR REPLACE INTO projects (id, name, path, created_at, last_opened) VALUES (1, 'Project A', '/tmp/proj-a', '2026-07-01T00:00:00Z', '2026-07-10T08:30:00Z')").run();
    db.prepare("INSERT OR REPLACE INTO projects (id, name, path, created_at) VALUES (2, 'Project B', '/tmp/proj-b', '2026-06-15T00:00:00Z')").run();
    db.prepare('INSERT OR REPLACE INTO favorites (project_id, created_at) VALUES (1, ?)').run(new Date().toISOString());
    db.prepare("INSERT INTO recent_files (project_id, file_name, file_path, viewed_at) VALUES (1, 'README.md', 'README.md', '2026-07-10T08:00:00Z')").run();

    // Start a test server
    await new Promise<void>((resolve) => {
      server = http.createServer(app).listen(0, () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  it('GET /api/stats returns project count, lastActive, favoriteCount', async () => {
    const res = await fetch(`${baseUrl}/api/stats`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.projects).toBe(2);
    expect(data.favoriteCount).toBe(1);
    expect(data.lastActive).toBeTruthy(); // ISO 8601 string
  });

  it('POST /api/recent-files records a file view', async () => {
    const res = await fetch(`${baseUrl}/api/recent-files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 2, fileName: 'notes.md', filePath: 'docs/notes.md' }),
    });
    expect(res.status).toBe(201);

    // Verify it was stored
    const db = getConnection();
    const row = db.prepare('SELECT * FROM recent_files WHERE project_id = 2 ORDER BY viewed_at DESC').get() as any;
    expect(row.file_name).toBe('notes.md');
  });

  it('POST /api/recent-files rejects invalid projectId', async () => {
    const res = await fetch(`${baseUrl}/api/recent-files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 999, fileName: 'x.md', filePath: 'x.md' }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/recent-files returns recent files with project names', async () => {
    const res = await fetch(`${baseUrl}/api/recent-files?limit=5`);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].fileName).toBeTruthy();
    expect(data[0].projectName).toBeTruthy();
    expect(data[0].viewedAt).toBeTruthy();
  });

  it('GET /api/recent-files respects limit', async () => {
    const res = await fetch(`${baseUrl}/api/recent-files?limit=1`);
    const data = await res.json() as any[];
    expect(data.length).toBeLessThanOrEqual(1);
  });

  it('POST /api/recent-files enforces max 50 records', async () => {
    const db = getConnection();
    // Insert 55 records to trigger cleanup
    for (let i = 0; i < 55; i++) {
      db.prepare("INSERT INTO recent_files (project_id, file_name, file_path, viewed_at) VALUES (1, ?, ?, datetime('now', ? || ' seconds'))")
        .run('file' + i + '.md', 'path/file' + i + '.md', String(-i * 60));
    }
    // Trigger cleanup via POST
    await fetch(`${baseUrl}/api/recent-files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 1, fileName: 'cleanup.md', filePath: 'cleanup.md' }),
    });
    const count = (db.prepare('SELECT COUNT(*) as c FROM recent_files').get() as { c: number }).c;
    expect(count).toBeLessThanOrEqual(50);
  });
});

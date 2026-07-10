import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';

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

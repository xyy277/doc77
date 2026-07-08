import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Database initialization', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
  });

  afterEach(async () => {
    try { closeConnection(); } catch { /* ignore */ }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should create a database connection', async () => {
    const db = await initDatabase(dbPath);
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('should create all 7 tables after migration', async () => {
    const db = await initDatabase(dbPath);
    runMigrations();

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('config');
    expect(tableNames).toContain('filetree_cache');
    expect(tableNames).toContain('operation_queue');
    expect(tableNames).toContain('audit_log');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('project_locks');
  });

  it('should create all required indexes', async () => {
    const db = await initDatabase(dbPath);
    runMigrations();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_projects_path');
    expect(indexNames).toContain('idx_projects_name');
    expect(indexNames).toContain('idx_queue_project_id');
    expect(indexNames).toContain('idx_queue_status');
    expect(indexNames).toContain('idx_queue_session');
    expect(indexNames).toContain('idx_audit_project_id');
    expect(indexNames).toContain('idx_audit_created_at');
  });

  it('should be idempotent', async () => {
    const db = await initDatabase(dbPath);
    runMigrations();
    expect(() => runMigrations()).not.toThrow();
  });

  it('should reuse existing connection via getConnection', async () => {
    const db = await initDatabase(dbPath);
    const conn = getConnection();
    expect(conn).toBe(db);
  });

  it('should throw when getConnection called before init', async () => {
    try { closeConnection(); } catch {}
    expect(() => getConnection()).toThrow();
  });

  it('should close connection', async () => {
    const db = await initDatabase(dbPath);
    closeConnection();
    expect(db.open).toBe(false);
  });
});

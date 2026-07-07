import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Database initialization', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `doc77-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should create a database connection', () => {
    const db = initDatabase(dbPath);
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('should create all 7 tables after migration', () => {
    const db = initDatabase(dbPath);
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('config');
    expect(tableNames).toContain('filetree_cache');
    expect(tableNames).toContain('operation_queue');
    expect(tableNames).toContain('audit_log');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('project_locks');
  });

  it('should create all required indexes', () => {
    const db = initDatabase(dbPath);
    runMigrations(db);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_projects_path');
    expect(indexNames).toContain('idx_projects_name');
    expect(indexNames).toContain('idx_queue_project_id');
    expect(indexNames).toContain('idx_queue_status');
    expect(indexNames).toContain('idx_queue_session');
    expect(indexNames).toContain('idx_audit_project_id');
    expect(indexNames).toContain('idx_audit_created_at');
  });

  it('should be idempotent — running migration twice does not error', () => {
    const db = initDatabase(dbPath);
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('should reuse existing connection via getConnection', () => {
    const db = initDatabase(dbPath);
    const conn = getConnection();
    expect(conn).toBe(db);
  });

  it('should throw when getConnection called before init', () => {
    // Force close first to test the error case
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    expect(() => getConnection()).toThrow();
  });

  it('should close connection', () => {
    const db = initDatabase(dbPath);
    closeConnection();
    expect(db.open).toBe(false);
  });

  it('should set WAL journal mode and foreign keys pragma', () => {
    const db = initDatabase(dbPath);

    const journalMode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(journalMode.journal_mode).toBe('wal');

    const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(foreignKeys.foreign_keys).toBe(1);
  });
});

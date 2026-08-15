import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  initDatabase,
  closeConnection,
  getConnection,
  flushDatabase,
} from '../src/db/connection.js';
import { runMigrations, fts5Available } from '../src/db/migrations.js';
import { registerProject } from '../src/db/projects.js';
import { indexFile } from '../src/search/indexer.js';
import { searchProject } from '../src/search/query.js';

/**
 * DB 持久化回归测试（P-A：sql.js → better-sqlite3 迁移）。
 *
 * sql.js 时代的 export 节流测试（v1.1.4 Part 1-B）语义已随迁移消失：
 * better-sqlite3 WAL 模式下每次写语句即落盘，无需去抖 + 整库序列化。
 * 本文件改写为验证迁移承诺的行为：
 *   1. WAL journal 模式生效
 *   2. 写 → 关 → 重开，数据在（崩溃不丢数据的基线）
 *   3. flushDatabase 保持可调用（API 兼容 no-op）
 *   4. FTS5 搜索端到端（此前 sql.js 无 FTS5，该路径从未被测过）
 */
describe('DB persistence (better-sqlite3, WAL)', () => {
  let testDir: string;
  let dbPath: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-persist-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    await initDatabase(dbPath);
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

  it('runs in WAL journal mode', () => {
    const row = getConnection().prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(row.journal_mode).toBe('wal');
  });

  it('writes persist immediately and survive close + reopen', async () => {
    getConnection()
      .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
      .run('survive-me', 'v');
    // 无需 flushDatabase：WAL 下每条写语句已落盘
    closeConnection();

    await initDatabase(dbPath);
    const row = getConnection()
      .prepare("SELECT value FROM config WHERE key = 'survive-me'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('v');
  });

  it('flushDatabase is a callable no-op (API compat)', () => {
    expect(() => flushDatabase()).not.toThrow();
  });

  it('FTS5 search end-to-end: indexFile → searchProject MATCH hit', () => {
    expect(fts5Available).toBe(true);
    const p = registerProject('FTS5 Test', projectDir);
    fs.writeFileSync(path.join(projectDir, 'hello.md'), '# Hello World\n\nfoo bar baz qux');

    expect(indexFile(p.id, projectDir, 'hello.md')).toBe(true);

    const res = searchProject(p.id, 'qux');
    expect(res.total).toBe(1);
    expect(res.results[0].file_path).toBe('hello.md');
    expect(res.results[0].snippets.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, getConnection } from './connection.js';

describe('db connection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-db-conn-'));
    await initDatabase(path.join(testDir, 'data.db'));
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('busy_timeout 已设 5000ms（WAL 多连接并发写防 SQLITE_BUSY）', () => {
    // SQLite 对该 PRAGMA 返回列名为 timeout（非 busy_timeout）
    const row = getConnection().prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(5000);
  });
});

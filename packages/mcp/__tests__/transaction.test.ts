import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, getConnection } from '@doc77/core';
import { runMigrations } from '@doc77/core';
import { registerProject } from '@doc77/core';
import { createSession } from '../src/session.js';
import { enqueueOperation, getPendingTasks, getTaskById } from '../src/queue/index.js';
import { runPreflightCheck } from '../src/transaction/preflight.js';
import { safeMove } from '../src/transaction/safeMove.js';
import { acquireProjectLock, releaseProjectLock, getActiveLock } from '../src/transaction/lock.js';
import {
  performShadowBackup,
  rollbackFromShadow,
  type UndoLog,
} from '../src/transaction/shadow.js';
import { runShadowGC } from '../src/transaction/shadowGC.js';
import { checkFileSize, writeAuditLog } from '../src/transaction/audit.js';

describe('Operation Queue', () => {
  let testDir: string;
  let dbPath: string;
  let projectId: number;
  let sessionId: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-tx-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    const projDir = path.join(testDir, 'proj');
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, 'test.txt'), 'hello');

    await initDatabase(dbPath);
    runMigrations();
    const proj = registerProject('TxTest', projDir);
    projectId = proj.id;
    const session = createSession();
    sessionId = session.id;
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('enqueueOperation', () => {
    it('should enqueue an operation with pending status', () => {
      const task = enqueueOperation(projectId, sessionId, 'write_file', {
        file_path: 'test.txt',
      });
      expect(task.task_id).toBeDefined();
      expect(task.status).toBe('pending');
    });

    it('should persist to operation_queue table', () => {
      const task = enqueueOperation(projectId, sessionId, 'create_folder', {
        folder_path: 'new-dir',
      });
      const db = getConnection();
      const row = db.prepare('SELECT * FROM operation_queue WHERE id = ?').get(task.task_id) as {
        status: string;
      };
      expect(row).toBeDefined();
      expect(row.status).toBe('pending');
    });
  });

  describe('getPendingTasks', () => {
    it('should return pending tasks for a project', () => {
      enqueueOperation(projectId, sessionId, 'write_file', { file_path: 'a.txt' });
      enqueueOperation(projectId, sessionId, 'delete_file', { file_path: 'b.txt' });
      const tasks = getPendingTasks(projectId);
      expect(tasks.length).toBe(2);
    });

    it('should return empty array when no tasks', () => {
      const tasks = getPendingTasks(projectId);
      expect(tasks).toEqual([]);
    });
  });

  describe('getTaskById', () => {
    it('should return a specific task', () => {
      const task = enqueueOperation(projectId, sessionId, 'move_file', {
        source: 'a.txt',
        target: 'b.txt',
      });
      const found = getTaskById(task.task_id);
      expect(found).toBeDefined();
      expect(found!.operation_type).toBe('move_file');
    });

    it('should return null for non-existent task', () => {
      expect(getTaskById('nonexistent')).toBeNull();
    });
  });
});

describe('Pre-flight Check', () => {
  let testDir: string;
  let dbPath: string;
  let projDir: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-pf-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    projDir = path.join(testDir, 'proj');
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, 'existing.txt'), 'data');

    await initDatabase(dbPath);
    runMigrations();
    projectId = registerProject('PfTest', projDir).id;
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should pass for valid operations', () => {
    const result = runPreflightCheck(projectId, [
      { type: 'create_folder', folder_path: 'new-folder' },
    ]);
    expect(result.passed).toBe(true);
  });

  it('should fail for path traversal', () => {
    const result = runPreflightCheck(projectId, [
      { type: 'write_file', file_path: '../outside.txt' },
    ]);
    expect(result.passed).toBe(false);
  });

  it('should fail if all operations fail', () => {
    const result = runPreflightCheck(projectId, [
      { type: 'write_file', file_path: '../escape.txt' },
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('safeMove', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-sm-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should rename a file within the same directory', async () => {
    const src = path.join(testDir, 'source.txt');
    const dest = path.join(testDir, 'target.txt');
    fs.writeFileSync(src, 'content');

    await safeMove(src, dest);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('content');
  });

  it('should move between subdirectories', async () => {
    const subDir = path.join(testDir, 'sub');
    fs.mkdirSync(subDir);
    const src = path.join(testDir, 'file.txt');
    const dest = path.join(subDir, 'file.txt');
    fs.writeFileSync(src, 'data');

    await safeMove(src, dest);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('should clean up temp file on failure', async () => {
    const src = path.join(testDir, 'nonexistent.txt');
    const dest = path.join(testDir, 'dest.txt');
    // src doesn't exist, so rename will fail
    await expect(safeMove(src, dest)).rejects.toThrow();
    // No .doc77tmp files should remain
    const files = fs.readdirSync(testDir);
    const tmpFiles = files.filter((f) => f.endsWith('.doc77tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('Project Lock', () => {
  let testDir: string;
  let dbPath: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-lock-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    await initDatabase(dbPath);
    runMigrations();
    projectId = registerProject('LockTest', testDir).id;
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should acquire a lock on a project', async () => {
    const acquired = await acquireProjectLock(projectId, 'task_1');
    expect(acquired).toBe(true);
  });

  it('should not double-lock the same project', async () => {
    await acquireProjectLock(projectId, 'task_1');
    const second = await acquireProjectLock(projectId, 'task_2');
    expect(second).toBe(false);
  });

  it('should release a lock', async () => {
    await acquireProjectLock(projectId, 'task_1');
    releaseProjectLock(projectId);
    const lock = getActiveLock(projectId);
    expect(lock).toBeNull();
  });
});

describe('Shadow Backup & Rollback', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-shadow-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should backup a file before overwriting', () => {
    const file = path.join(testDir, 'important.txt');
    fs.writeFileSync(file, 'original content');

    const shadowDir = path.join(testDir, '.shadow');
    const undoLog: UndoLog[] = performShadowBackup(
      [{ type: 'write_file', file_path: 'important.txt', content: 'new' }],
      testDir,
      shadowDir,
    );

    expect(undoLog.length).toBe(1);
    expect(undoLog[0].type).toBe('write_file');
    // Original file should be backed up to shadow
    const shadowFiles = fs.readdirSync(shadowDir);
    expect(shadowFiles.length).toBeGreaterThan(0);
  });

  it('should rollback by restoring from shadow', () => {
    const file = path.join(testDir, 'data.txt');
    fs.writeFileSync(file, 'original');

    const shadowDir = path.join(testDir, '.shadow');
    const undoLog: UndoLog[] = performShadowBackup(
      [{ type: 'write_file', file_path: 'data.txt', content: 'modified' }],
      testDir,
      shadowDir,
    );

    // Simulate the write (modify file)
    fs.writeFileSync(file, 'modified');

    // Rollback
    rollbackFromShadow(undoLog, testDir, shadowDir);
    expect(fs.readFileSync(file, 'utf-8')).toBe('original');

    // Shadow should be cleaned up
    expect(fs.existsSync(shadowDir)).toBe(false);
  });
});

describe('Volume Circuit Breaker', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-cb-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should warn for files over threshold', () => {
    const result = checkFileSize(60000000, 50); // 60MB, threshold 50MB
    expect(result.overThreshold).toBe(true);
    expect(result.needsConfirmation).toBe(true);
  });

  it('should not warn for files under threshold', () => {
    const result = checkFileSize(1000000, 50);
    expect(result.overThreshold).toBe(false);
  });
});

describe('Audit Log', () => {
  let testDir: string;
  let dbPath: string;
  let projectId: number;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-audit-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    await initDatabase(dbPath);
    runMigrations();
    projectId = registerProject('AuditTest', testDir).id;
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should write an audit log entry', () => {
    writeAuditLog({
      project_id: projectId,
      operation_type: 'write_file',
      operation_data: { file_path: 'test.txt' },
      source: 'ai',
      approved_by: 'user',
      status: 'executed',
    });

    const db = getConnection();
    const rows = db.prepare('SELECT * FROM audit_log WHERE project_id = ?').all(projectId);
    expect(rows.length).toBe(1);
  });
});

describe('Shadow GC', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-gc-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should clean up orphan .doc77tmp files', () => {
    const tmpFile = path.join(testDir, 'orphan.doc77tmp');
    fs.writeFileSync(tmpFile, 'garbage');

    runShadowGC(testDir);

    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('should not remove non-tmp files', () => {
    const regularFile = path.join(testDir, 'keep.txt');
    fs.writeFileSync(regularFile, 'important');

    runShadowGC(testDir);

    expect(fs.existsSync(regularFile)).toBe(true);
  });
});

describe('copy_file — Shadow Backup', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-copy-shadow-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should backup target file before copy overwrite and rollback', () => {
    const src = path.join(testDir, 'source.txt');
    const dest = path.join(testDir, 'dest.txt');
    fs.writeFileSync(src, 'source content');
    fs.writeFileSync(dest, 'original target');

    const shadowDir = path.join(testDir, '.shadow');
    const undoLog: UndoLog = performShadowBackup(
      [{ type: 'copy_file', source: 'source.txt', target: 'dest.txt' }],
      testDir,
      shadowDir,
    );

    expect(undoLog.length).toBe(1);
    expect(undoLog[0].type).toBe('copy_file');

    // Simulate the copy (overwrite target)
    fs.copyFileSync(src, dest);

    // Rollback
    rollbackFromShadow(undoLog, testDir, shadowDir);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('original target');
    expect(fs.existsSync(shadowDir)).toBe(false);
  });

  it('should handle copy_file to new target (no backup) and rollback deletes it', () => {
    const src = path.join(testDir, 'source.txt');
    fs.writeFileSync(src, 'source content');

    const shadowDir = path.join(testDir, '.shadow');
    const undoLog: UndoLog = performShadowBackup(
      [{ type: 'copy_file', source: 'source.txt', target: 'new.txt' }],
      testDir,
      shadowDir,
    );

    expect(undoLog.length).toBe(1);
    expect(undoLog[0].type).toBe('copy_file');

    // Simulate the copy
    fs.copyFileSync(src, path.join(testDir, 'new.txt'));

    // Rollback — should delete new.txt
    rollbackFromShadow(undoLog, testDir, shadowDir);
    expect(fs.existsSync(path.join(testDir, 'new.txt'))).toBe(false);
  });
});

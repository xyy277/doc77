import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, registerProject, runMigrations } from '@doc77/core';
import { createSession } from '../src/session.js';
import { writeFile, moveFile, deleteFile, copyFile, batchOperations } from '../src/tools/write.js';

describe('MCP write tools — sensitive file guarding', () => {
  let testDir: string;
  let projectId: number;
  let sessionId: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-writeguard-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    const projDir = path.join(testDir, 'proj');
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, 'notes.md'), 'hello');
    fs.writeFileSync(path.join(projDir, '.env'), 'SECRET=1');

    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('WriteGuard', projDir).id;
    sessionId = createSession().id;
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('enqueues a normal file operation as pending_approval', async () => {
    const task = await writeFile(projectId, sessionId, 'notes.md', 'new content');
    expect(task.status).toBe('pending_approval');
    expect(task.task_id).toBeDefined();
  });

  it('rejects writing a sensitive file (.env) before enqueue', async () => {
    await expect(writeFile(projectId, sessionId, '.env', 'x')).rejects.toThrow(/sensitive/i);
  });

  it('rejects deleting a sensitive file', async () => {
    await expect(deleteFile(projectId, sessionId, '.env')).rejects.toThrow(/sensitive/i);
  });

  it('rejects moving TO a sensitive target path', async () => {
    await expect(moveFile(projectId, sessionId, 'notes.md', '.env')).rejects.toThrow(/sensitive/i);
  });

  it('copyFile enqueues a copy to new target as pending_approval', async () => {
    const task = await copyFile(projectId, sessionId, 'notes.md', 'notes_copy.md');
    expect(task.status).toBe('pending_approval');
    expect(task.task_id).toBeDefined();
  });

  it('copyFile rejects copying FROM a sensitive file', async () => {
    await expect(copyFile(projectId, sessionId, '.env', 'safe.env')).rejects.toThrow(/sensitive/i);
  });

  it('copyFile rejects copying TO a sensitive target', async () => {
    await expect(copyFile(projectId, sessionId, 'notes.md', '.env')).rejects.toThrow(/sensitive/i);
  });

  it('copyFile throws when target exists and overwrite is false', async () => {
    await expect(copyFile(projectId, sessionId, 'notes.md', 'notes.md', false)).rejects.toThrow(
      /exists|already exists/i,
    );
  });

  it('batch_operations enqueues valid ops and rejects a sensitive op', async () => {
    const ok = await batchOperations(projectId, sessionId, [
      { type: 'create_folder', folder_path: 'archive' },
    ]);
    expect(ok.status).toBe('pending_approval');

    await expect(
      batchOperations(projectId, sessionId, [{ type: 'delete_file', file_path: '.env' }]),
    ).rejects.toThrow(/sensitive/i);
  });
});

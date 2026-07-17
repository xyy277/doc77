import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  initDatabase,
  closeConnection,
  registerProject,
  runMigrations,
  isSensitiveFile,
  executeAiWriteTool,
  initI18n,
} from '@doc77/core';

beforeAll(() => initI18n('zh-CN'));
import { createSession } from '../src/session.js';
import { getPendingTasks, updateTaskStatus } from '../src/queue/index.js';
import { moveFile, createFolder, deleteFile, batchOperations } from '../src/tools/write.js';
import { executeApprovedTasks } from '../src/transaction/executor.js';

/**
 * End-to-end verification of the AI → MCP write seam:
 *   executeAiWriteTool (AI proposal) → pending queue task → approve →
 *   executeApprovedTasks (transactional executor) → real filesystem change.
 * Only the LLM is out of scope; everything the LLM would trigger is exercised.
 */
describe('AI → MCP write integration', () => {
  let testDir: string;
  let projDir: string;
  let projectId: number;
  let deps: Parameters<typeof executeAiWriteTool>[3];
  let ctx: { projectId: number; sessionId: string };

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-aiwrite-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    projDir = path.join(testDir, 'proj');
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, 'a.md'), 'hello');

    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('AiWrite', projDir).id;
    const sessionId = createSession().id;
    ctx = { projectId, sessionId };
    deps = {
      writeFns: { moveFile, createFolder, deleteFile, batchOperations },
      isSensitiveFile,
      getRiskLevel: () => 'high',
    };
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('enqueues an AI-proposed rename, and approval actually moves the file', async () => {
    const res = await executeAiWriteTool(
      'move_file',
      { source: 'a.md', target: 'renamed.md' },
      ctx,
      deps,
    );
    // Proposal returns a pending message, and the file has NOT moved yet.
    expect(res).toMatch(/待审批/);
    expect(fs.existsSync(path.join(projDir, 'a.md'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, 'renamed.md'))).toBe(false);

    const pending = getPendingTasks(projectId);
    expect(pending).toHaveLength(1);
    const taskId = String(pending[0].task_id);

    // Approve + execute the transactional pipeline.
    updateTaskStatus(taskId, 'approved');
    await executeApprovedTasks(projectId, [taskId]);

    // Filesystem actually changed.
    expect(fs.existsSync(path.join(projDir, 'a.md'))).toBe(false);
    expect(fs.readFileSync(path.join(projDir, 'renamed.md'), 'utf-8')).toBe('hello');
  });

  it('a sensitive target is rejected and never reaches the queue', async () => {
    const res = await executeAiWriteTool(
      'move_file',
      { source: 'a.md', target: '.env' },
      ctx,
      deps,
    );
    expect(res).toMatch(/敏感|sensitive/i);
    expect(getPendingTasks(projectId)).toHaveLength(0);
  });
});

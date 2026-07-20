import * as path from 'node:path';
import * as fs from 'node:fs';
import { getConnection } from '@doc77/core';
import { runPreflightCheck } from './preflight.js';
import { performShadowBackup, rollbackFromShadow, type UndoLog } from './shadow.js';
import { acquireProjectLock, releaseProjectLock } from './lock.js';
import { safeMove } from './safeMove.js';
import { checkFileSize, writeAuditLog } from './audit.js';
import { getEventBus } from '../event-bus.js';

/**
 * Execute a batch of approved tasks for a project.
 *
 * Three-phase pipeline:
 * 1. Preflight — validate all operations
 * 2. Shadow — backup files before modification
 * 3. Execute — perform operations in order, rollback on failure
 *
 * Emits task lifecycle events via EventBus.
 */
export async function executeApprovedTasks(
  projectId: number,
  taskIds: string[],
): Promise<{ success: boolean; errors: string[] }> {
  const db = getConnection();
  const eventBus = getEventBus();
  const errors: string[] = [];

  // Get project path
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;
  if (!project) return { success: false, errors: ['Project not found'] };

  // Load tasks
  const tasks = taskIds
    .map((id) =>
      db.prepare('SELECT * FROM operation_queue WHERE id = ? AND status = ?').get(id, 'approved'),
    )
    .filter(Boolean) as Array<{
    id: number;
    operation_type: string;
    operation_data: string;
  }>;

  if (tasks.length === 0) {
    return { success: false, errors: ['No approved tasks to execute'] };
  }

  // Parse operations
  const operations = tasks.map((t) => ({
    taskId: t.id,
    type: t.operation_type,
    ...JSON.parse(t.operation_data),
  }));

  // Phase 1: Preflight
  const preflight = runPreflightCheck(projectId, operations);
  if (!preflight.passed) {
    for (const t of tasks) {
      db.prepare(
        "UPDATE operation_queue SET status = 'failed', updated_at = datetime('now') WHERE id = ?",
      ).run(t.id);
      eventBus.emit('task:failed', {
        task_id: String(t.id),
        project_id: projectId,
        error_message: preflight.errors.join('; '),
        rolled_back: false,
      });
      writeAuditLog({
        project_id: projectId,
        operation_type: t.operation_type,
        operation_data: JSON.parse(t.operation_data),
        source: 'ai',
        status: 'failed',
        error_message: preflight.errors.join('; '),
      });
    }
    return { success: false, errors: preflight.errors };
  }

  // Acquire project lock
  const lockAcquired = await acquireProjectLock(projectId, taskIds.join(','));
  if (!lockAcquired) {
    return { success: false, errors: ['Project is locked by another process'] };
  }

  // Phase 2: Shadow backup
  const shadowDir = path.join(project.path, '.doc77-shadow-' + Date.now());
  let undoLog: UndoLog = [];

  try {
    undoLog = performShadowBackup(operations, project.path, shadowDir);

    // Phase 3: Execute operations in order
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const taskId = String(op.taskId);

      db.prepare(
        "UPDATE operation_queue SET status = 'executing', updated_at = datetime('now') WHERE id = ?",
      ).run(op.taskId);
      eventBus.emit('task:executing', { task_id: taskId, project_id: projectId });

      try {
        await executeSingleOperation(op, project.path);
        db.prepare(
          "UPDATE operation_queue SET status = 'executed', updated_at = datetime('now'), executed_at = datetime('now') WHERE id = ?",
        ).run(op.taskId);
        eventBus.emit('task:executed', {
          task_id: taskId,
          project_id: projectId,
          result: 'success',
        });
        writeAuditLog({
          project_id: projectId,
          operation_type: op.type,
          operation_data: op,
          source: 'ai',
          approved_by: 'user',
          status: 'executed',
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Operation ${i + 1} failed: ${msg}`);

        // Rollback all previous operations
        try {
          rollbackFromShadow(undoLog.slice(0, i + 1), project.path, shadowDir);
          db.prepare(
            "UPDATE operation_queue SET status = 'failed_and_rolled_back', updated_at = datetime('now'), executed_at = datetime('now') WHERE id = ?",
          ).run(op.taskId);
          eventBus.emit('task:failed', {
            task_id: taskId,
            project_id: projectId,
            error_message: msg,
            rolled_back: true,
          });
        } catch {
          db.prepare(
            "UPDATE operation_queue SET status = 'failed', updated_at = datetime('now') WHERE id = ?",
          ).run(op.taskId);
        }

        writeAuditLog({
          project_id: projectId,
          operation_type: op.type,
          operation_data: op,
          source: 'ai',
          status: 'failed_and_rolled_back',
          error_message: msg,
        });
        return { success: false, errors };
      }
    }

    // All succeeded — clean shadow
    try {
      fs.rmSync(shadowDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { success: true, errors: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    // Attempt rollback of everything
    try {
      rollbackFromShadow(undoLog, project.path, shadowDir);
    } catch {
      /* ignore */
    }
    return { success: false, errors: [msg] };
  } finally {
    releaseProjectLock(projectId);
  }
}

/**
 * Execute a single file operation.
 */
async function executeSingleOperation(
  op: {
    type: string;
    file_path?: string;
    folder_path?: string;
    source?: string;
    target?: string;
    content?: string;
    [key: string]: unknown;
  },
  projectRoot: string,
): Promise<void> {
  switch (op.type) {
    case 'write_file': {
      if (!op.file_path) throw new Error('file_path required');
      const absPath = path.join(projectRoot, op.file_path);
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, op.content || '', 'utf-8');
      break;
    }
    case 'create_folder': {
      if (!op.folder_path) throw new Error('folder_path required');
      const absPath = path.join(projectRoot, op.folder_path);
      fs.mkdirSync(absPath, { recursive: true });
      break;
    }
    case 'move_file': {
      if (!op.source || !op.target) throw new Error('source and target required');
      const src = path.join(projectRoot, op.source);
      const dest = path.join(projectRoot, op.target);
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      await safeMove(src, dest);
      break;
    }
    case 'delete_file': {
      if (!op.file_path) throw new Error('file_path required');
      const absPath = path.join(projectRoot, op.file_path);
      const stats = fs.statSync(absPath);
      if (stats.isDirectory()) {
        fs.rmdirSync(absPath); // only empty dirs
      } else {
        fs.unlinkSync(absPath);
      }
      break;
    }
    case 'copy_file': {
      if (!op.source || !op.target) throw new Error('source and target required');
      const srcAbs = path.join(projectRoot, op.source as string);
      const tgtAbs = path.join(projectRoot, op.target as string);
      const tgtDir = path.dirname(tgtAbs);
      if (!fs.existsSync(tgtDir)) fs.mkdirSync(tgtDir, { recursive: true });
      const srcStat = fs.statSync(srcAbs);
      if (srcStat.isDirectory()) {
        fs.cpSync(srcAbs, tgtAbs, { recursive: true });
      } else {
        fs.copyFileSync(srcAbs, tgtAbs);
      }
      break;
    }
    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}

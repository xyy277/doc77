import { getConnection } from '@doc77/core';

export interface QueuedTask {
  task_id: string;
  project_id: number;
  session_id: string;
  operation_type: string;
  operation_data: Record<string, unknown>;
  status: string;
  created_at: string;
}

/**
 * Enqueue a new operation for approval.
 */
export function enqueueOperation(
  projectId: number,
  sessionId: string,
  opType: string,
  opData: Record<string, unknown>,
): QueuedTask {
  const db = getConnection();
  const result = db
    .prepare(
      `INSERT INTO operation_queue (project_id, session_id, operation_type, operation_data, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    )
    .run(projectId, sessionId, opType, JSON.stringify(opData));

  return {
    task_id: String(result.lastInsertRowid),
    project_id: projectId,
    session_id: sessionId,
    operation_type: opType,
    operation_data: opData,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}

/**
 * Get all pending tasks for a project.
 */
export function getPendingTasks(projectId: number): QueuedTask[] {
  const db = getConnection();
  return db
    .prepare(
      'SELECT id as task_id, project_id, session_id, operation_type, operation_data, status, created_at FROM operation_queue WHERE project_id = ? AND status = ? ORDER BY id',
    )
    .all(projectId, 'pending') as QueuedTask[];
}

/**
 * Get a task by its ID.
 */
export function getTaskById(taskId: string): QueuedTask | null {
  const db = getConnection();
  const row = db
    .prepare(
      'SELECT id as task_id, project_id, session_id, operation_type, operation_data, status, created_at FROM operation_queue WHERE id = ?',
    )
    .get(taskId) as QueuedTask | undefined;
  return row || null;
}

/**
 * Update the status of a task.
 */
export function updateTaskStatus(
  taskId: string,
  status: string,
  undoLog?: Record<string, unknown>,
): void {
  const db = getConnection();
  if (undoLog) {
    db.prepare(
      "UPDATE operation_queue SET status = ?, undo_log = ?, updated_at = datetime('now'), executed_at = datetime('now') WHERE id = ?",
    ).run(status, JSON.stringify(undoLog), taskId);
  } else {
    db.prepare(
      "UPDATE operation_queue SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(status, taskId);
  }
}

/**
 * Auto-reject tasks that have been pending for longer than the timeout (default 30 min).
 */
export function rejectExpiredTasks(timeoutMinutes: number = 30): number {
  const db = getConnection();
  const result = db
    .prepare(
      `UPDATE operation_queue SET status = 'rejected', updated_at = datetime('now')
     WHERE status = 'pending'
     AND datetime(created_at, '+' || ? || ' minutes') < datetime('now')`,
    )
    .run(timeoutMinutes);
  return result.changes;
}

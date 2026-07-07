import { getConnection } from '@doc77/core';

/**
 * Try to acquire a project-level lock.
 * Returns true if the lock was acquired, false if the project is already locked.
 * Uses SQLite INSERT OR IGNORE for atomicity.
 */
export async function acquireProjectLock(
  projectId: number,
  taskId: string,
  lockTimeoutMinutes: number = 10,
): Promise<boolean> {
  const db = getConnection();

  // Check for existing active lock
  const existing = db
    .prepare(
      `SELECT * FROM project_locks
     WHERE project_id = ?
     AND datetime(heartbeat_at, '+' || ? || ' minutes') > datetime('now')`,
    )
    .get(projectId, lockTimeoutMinutes) as unknown;

  if (existing) {
    return false; // Already locked
  }

  // Clean stale lock if any
  db.prepare('DELETE FROM project_locks WHERE project_id = ?').run(projectId);

  // Insert new lock
  try {
    db.prepare(
      `INSERT INTO project_locks (project_id, locked_at, locked_by, heartbeat_at)
     VALUES (?, datetime('now'), ?, datetime('now'))`,
    ).run(projectId, taskId);
    return true;
  } catch {
    return false; // Race condition — another process got the lock
  }
}

/**
 * Release a project lock.
 */
export function releaseProjectLock(projectId: number): void {
  const db = getConnection();
  db.prepare('DELETE FROM project_locks WHERE project_id = ?').run(projectId);
}

/**
 * Get the active lock for a project, or null if not locked.
 */
export function getActiveLock(projectId: number): {
  locked_by: string;
  locked_at: string;
} | null {
  const db = getConnection();
  const row = db
    .prepare('SELECT locked_by, locked_at FROM project_locks WHERE project_id = ?')
    .get(projectId) as { locked_by: string; locked_at: string } | undefined;
  return row || null;
}

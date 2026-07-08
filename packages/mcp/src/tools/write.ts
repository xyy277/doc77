import { checkPathAccess } from '../security/guard.js';
import { enqueueOperation as enqueue } from '../queue/index.js';
import type { QueuedTask } from '../queue/index.js';

/**
 * Task returned by write operations.
 */
export interface WriteTask {
  task_id: string;
  status: 'pending_approval' | 'executed' | 'rejected' | 'failed' | 'failed_and_rolled_back';
  message: string;
  details?: Record<string, unknown>;
}

/** Convert QueuedTask from queue module to WriteTask */
function toWriteTask(q: QueuedTask, opType: string): WriteTask {
  return {
    task_id: q.task_id,
    status: 'pending_approval',
    message: `Operation "${opType}" queued for approval.`,
    details: { project_id: q.project_id, operation_type: opType, ...q.operation_data },
  };
}

/**
 * write_file — create or overwrite a file.
 */
export async function writeFile(
  projectId: number, sessionId: string, filePath: string, content: string,
): Promise<WriteTask> {
  const access = checkPathAccess(projectId, filePath);
  if (!access.allowed) throw new Error(access.reason);
  return toWriteTask(enqueue(projectId, sessionId, 'write_file', { file_path: filePath, content_length: content.length }), 'write_file');
}

export async function createFolder(
  projectId: number, sessionId: string, folderPath: string,
): Promise<WriteTask> {
  const access = checkPathAccess(projectId, folderPath);
  if (!access.allowed) throw new Error(access.reason);
  return toWriteTask(enqueue(projectId, sessionId, 'create_folder', { folder_path: folderPath }), 'create_folder');
}

export async function moveFile(
  projectId: number, sessionId: string, source: string, target: string,
): Promise<WriteTask> {
  if (!checkPathAccess(projectId, source).allowed) throw new Error(checkPathAccess(projectId, source).reason);
  if (!checkPathAccess(projectId, target).allowed) throw new Error(checkPathAccess(projectId, target).reason);
  return toWriteTask(enqueue(projectId, sessionId, 'move_file', { source, target }), 'move_file');
}

export async function deleteFile(
  projectId: number, sessionId: string, filePath: string,
): Promise<WriteTask> {
  const access = checkPathAccess(projectId, filePath);
  if (!access.allowed) throw new Error(access.reason);
  return toWriteTask(enqueue(projectId, sessionId, 'delete_file', { file_path: filePath }), 'delete_file');
}

/**
 * batch_operations — execute multiple operations as a batch.
 */
export async function batchOperations(
  projectId: number,
  sessionId: string,
  operations: Array<{ type: string } & Record<string, unknown>>,
): Promise<WriteTask> {
  for (const op of operations) {
    const opPath = (op.file_path || op.folder_path || op.source) as string;
    if (opPath) {
      const access = checkPathAccess(projectId, opPath);
      if (!access.allowed) throw new Error(`Batch operation "${op.type}": ${access.reason}`);
    }
  }

  return enqueueOperation(projectId, sessionId, 'batch_operations', {
    operations,
    count: operations.length,
  });
}

/**
 * get_task_status — query the status of a previously submitted task.
 */
export async function getTaskStatus(taskId: string): Promise<WriteTask | null> {
  const db = getConnection();
  const row = db
    .prepare(
      'SELECT id, project_id, operation_type, operation_data, status FROM operation_queue WHERE id = ?',
    )
    .get(taskId) as
    | {
        id: number;
        project_id: number;
        operation_type: string;
        operation_data: string;
        status: string;
      }
    | undefined;

  if (!row) return null;

  return {
    task_id: String(row.id),
    status: row.status as WriteTask['status'],
    message: `Task ${row.id} status: ${row.status}`,
    details: {
      project_id: row.project_id,
      operation_type: row.operation_type,
    },
  };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkPathAccess, checkSensitiveFile } from '../security/guard.js';
import { enqueueOperation as enqueue } from '../queue/index.js';
import type { QueuedTask } from '../queue/index.js';
import { getConnection, t } from '@doc77/core';

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
 * Assert a path is inside the project boundary AND is not a sensitive file.
 * Throws on either failure. Sensitive-file blocking previously applied only to
 * reads (readonly.ts); writes went through checkPathAccess (sandbox only), so a
 * write/move/delete targeting .env / *.key was not blocked. This closes that gap.
 */
function assertPathAllowed(projectId: number, filePath: string): void {
  const access = checkPathAccess(projectId, filePath);
  if (!access.allowed) throw new Error(access.reason);
  const fileName = filePath.split('/').pop() || filePath;
  const sensitive = checkSensitiveFile(fileName);
  if (!sensitive.allowed) throw new Error(sensitive.reason);
}

/**
 * write_file — create or overwrite a file.
 */
export async function writeFile(
  projectId: number,
  sessionId: string,
  filePath: string,
  content: string,
): Promise<WriteTask> {
  assertPathAllowed(projectId, filePath);
  return toWriteTask(
    enqueue(projectId, sessionId, 'write_file', {
      file_path: filePath,
      content_length: content.length,
    }),
    'write_file',
  );
}

export async function createFolder(
  projectId: number,
  sessionId: string,
  folderPath: string,
): Promise<WriteTask> {
  assertPathAllowed(projectId, folderPath);
  return toWriteTask(
    enqueue(projectId, sessionId, 'create_folder', { folder_path: folderPath }),
    'create_folder',
  );
}

export async function moveFile(
  projectId: number,
  sessionId: string,
  source: string,
  target: string,
): Promise<WriteTask> {
  assertPathAllowed(projectId, source);
  assertPathAllowed(projectId, target);
  return toWriteTask(enqueue(projectId, sessionId, 'move_file', { source, target }), 'move_file');
}

export async function deleteFile(
  projectId: number,
  sessionId: string,
  filePath: string,
): Promise<WriteTask> {
  assertPathAllowed(projectId, filePath);
  return toWriteTask(
    enqueue(projectId, sessionId, 'delete_file', { file_path: filePath }),
    'delete_file',
  );
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
    if (opPath) assertPathAllowed(projectId, opPath);
    // move_file carries a second path (target) that must also be validated.
    if (op.target) assertPathAllowed(projectId, op.target as string);
  }

  return toWriteTask(
    enqueue(projectId, sessionId, 'batch_operations', {
      operations,
      count: operations.length,
    }),
    'batch_operations',
  );
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

/**
 * Register write MCP tools on the given server.
 * -- write_file, create_folder, move_file, delete_file, batch_operations, get_task_status
 */
export function registerWriteTools(server: McpServer): void {
  const writeTools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> = [
    {
      name: 'write_file',
      description: t('mcp.tool.writeFile.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_path: z.string().describe(t('mcp.param.filePath')),
        content: z.string().describe(t('mcp.param.content')),
      },
    },
    {
      name: 'create_folder',
      description: t('mcp.tool.createFolder.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        folder_path: z.string().describe(t('mcp.param.folderPath')),
      },
    },
    {
      name: 'move_file',
      description: t('mcp.tool.moveFile.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        source: z.string().describe(t('mcp.param.sourcePath')),
        target: z.string().describe(t('mcp.param.targetPath')),
      },
    },
    {
      name: 'delete_file',
      description: t('mcp.tool.deleteFile.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_path: z.string().describe(t('mcp.param.filePathToDelete')),
      },
    },
    {
      name: 'batch_operations',
      description: t('mcp.tool.batchOperations.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        operations: z.array(z.record(z.unknown())).describe(t('mcp.param.operations')),
      },
    },
    {
      name: 'get_task_status',
      description: t('mcp.tool.getTaskStatus.desc'),
      inputSchema: {
        task_id: z.string().describe(t('mcp.param.taskId')),
      },
    },
  ];

  for (const tool of writeTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, z.ZodTypeAny>,
      },
      async (args) => {
        // Dynamic session import (kept as-is from original server.ts)
        const { createSession } = await import('../session.js');
        const session = createSession();
        const sessionId = session.id;

        let result;
        switch (tool.name) {
          case 'write_file':
            result = await writeFile(
              args.project_id as number,
              sessionId,
              args.file_path as string,
              args.content as string,
            );
            break;
          case 'create_folder':
            result = await createFolder(
              args.project_id as number,
              sessionId,
              args.folder_path as string,
            );
            break;
          case 'move_file':
            result = await moveFile(
              args.project_id as number,
              sessionId,
              args.source as string,
              args.target as string,
            );
            break;
          case 'delete_file':
            result = await deleteFile(
              args.project_id as number,
              sessionId,
              args.file_path as string,
            );
            break;
          case 'batch_operations':
            result = await batchOperations(
              args.project_id as number,
              sessionId,
              args.operations as Array<{ type: string } & Record<string, unknown>>,
            );
            break;
          case 'get_task_status':
            result = await getTaskStatus(args.task_id as string);
            break;
          default:
            throw new Error(`Unknown tool: ${tool.name}`);
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }
}

/**
 * AI write-tool executor — the seam between the AI agent and the MCP
 * write/approval pipeline.
 *
 * The AI agent proposes file mutations by calling the WRITE_TOOLS
 * (move_file / create_folder / delete_file / batch_operations). This module
 * turns such a proposal into a *pending* task in the approval queue — it never
 * executes anything itself. Actual filesystem changes only happen after the
 * user approves the task in the UI, which runs the MCP transactional executor.
 *
 * All external effects are injected (AiWriteDeps) so the gating/routing logic
 * is unit-testable without a live database.
 */

import { t } from '../i18n/index.js';

/** MCP write functions (each enqueues a pending task and returns its id). */
export interface AiWriteFns {
  writeFile: (pid: number, sid: string, filePath: string, content: string) => Promise<{ task_id: string }>;
  moveFile: (
    pid: number,
    sid: string,
    source: string,
    target: string,
  ) => Promise<{ task_id: string }>;
  createFolder: (pid: number, sid: string, folderPath: string) => Promise<{ task_id: string }>;
  deleteFile: (pid: number, sid: string, filePath: string) => Promise<{ task_id: string }>;
  batchOperations: (
    pid: number,
    sid: string,
    operations: Array<Record<string, unknown>>,
  ) => Promise<{ task_id: string }>;
}

export interface AiWriteDeps {
  writeFns: AiWriteFns;
  isSensitiveFile: (name: string) => boolean;
  /** Reads ai.risk_level from config: 'low' | 'medium' | 'high'. */
  getRiskLevel: () => string;
}

export interface AiWriteCtx {
  projectId: number;
  sessionId: string;
}

const WRITE_TOOL_NAMES = ['write_file', 'move_file', 'create_folder', 'delete_file', 'batch_operations'] as const;

/**
 * Which operation *types* each risk level permits. Higher levels are supersets.
 * batch_operations is gated per contained op type, not as a whole.
 */
const RISK_ALLOWED: Record<string, ReadonlySet<string>> = {
  low: new Set(['create_folder']),
  medium: new Set(['create_folder', 'move_file']),
  high: new Set(['create_folder', 'move_file', 'delete_file', 'write_file']),
};

export function isAiWriteTool(name: string): boolean {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

function basename(p: string): string {
  return p.split('/').pop() || p;
}

/** Paths a single operation touches (for sandbox + sensitive checks). */
function pathsForOp(type: string, data: Record<string, unknown>): string[] {
  switch (type) {
    case 'write_file':
      return [data.file_path].filter(Boolean) as string[];
    case 'move_file':
      return [data.source, data.target].filter(Boolean) as string[];
    case 'create_folder':
      return [data.folder_path].filter(Boolean) as string[];
    case 'delete_file':
      return [data.file_path].filter(Boolean) as string[];
    default:
      return [];
  }
}

/**
 * Execute (enqueue) a single AI write-tool call. Returns a human-readable
 * string that becomes the tool result the model sees. On any gate failure it
 * returns an "Error: …" string WITHOUT enqueuing.
 */
export async function executeAiWriteTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AiWriteCtx,
  deps: AiWriteDeps,
): Promise<string> {
  const allowed = RISK_ALLOWED[deps.getRiskLevel()] ?? RISK_ALLOWED.medium;
  const { projectId: pid, sessionId: sid } = ctx;

  // Gate: risk level must permit every op type involved.
  const opTypes =
    name === 'batch_operations'
      ? ((args.operations as Array<{ type: string }>) || []).map((o) => o.type)
      : [name];
  for (const opType of opTypes) {
    if (!allowed.has(opType)) {
      return t('ai.runtime.riskLevelDenied', { riskLevel: deps.getRiskLevel(), opType });
    }
  }

  // Gate: no operation may touch a sensitive file (.env / *.key / …).
  const allPaths =
    name === 'batch_operations'
      ? ((args.operations as Array<Record<string, unknown>>) || []).flatMap((o) =>
          pathsForOp(o.type as string, o),
        )
      : pathsForOp(name, args);
  for (const p of allPaths) {
    if (deps.isSensitiveFile(basename(p))) {
      return t('ai.runtime.sensitiveRejected', { filePath: p });
    }
  }

  // Enqueue via the MCP write functions (which return a pending task id).
  let task: { task_id: string };
  let desc: string;
  switch (name) {
    case 'write_file':
      task = await deps.writeFns.writeFile(pid, sid, args.file_path as string, args.content as string);
      desc = t('ai.runtime.descWrite', { filePath: args.file_path as string });
      break;
    case 'move_file':
      task = await deps.writeFns.moveFile(pid, sid, args.source as string, args.target as string);
      desc = t('ai.runtime.descMove', {
        source: args.source as string,
        target: args.target as string,
      });
      break;
    case 'create_folder':
      task = await deps.writeFns.createFolder(pid, sid, args.folder_path as string);
      desc = t('ai.runtime.descCreateFolder', { folderPath: args.folder_path as string });
      break;
    case 'delete_file':
      task = await deps.writeFns.deleteFile(pid, sid, args.file_path as string);
      desc = t('ai.runtime.descDelete', { filePath: args.file_path as string });
      break;
    case 'batch_operations': {
      const ops = (args.operations as Array<Record<string, unknown>>) || [];
      task = await deps.writeFns.batchOperations(pid, sid, ops);
      desc = t('ai.runtime.descBatch', { count: ops.length });
      break;
    }
    default:
      return t('ai.runtime.unknownTool', { name });
  }

  return t('ai.runtime.queuedForApproval', { taskId: task.task_id, desc });
}

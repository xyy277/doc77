/**
 * ToolRouter factory — wires the ToolRouter (from @doc77/mcp) to the
 * concrete tool handlers that live in @doc77/core.
 *
 * This module exists to break what would otherwise be a circular import:
 *   - @doc77/mcp exports ToolRouter (generic, no core deps)
 *   - @doc77/core needs ToolRouter but also provides the handlers
 *
 * The factory accepts all core-side dependencies as parameters and returns
 * a single `executeTool(name, args)` function — the same shape the
 * AgentLoop expects. The ToolRouter handles permission gating (risk level,
 * sensitive files); the handlers handle the actual work.
 *
 * Tool handler mapping:
 *   list_files / read_file / get_file_info / list_projects / search_files
 *     → inline read handlers (scanDirectory, readFile, etc.)
 *   write_file / move_file / create_folder / delete_file / batch_operations
 *     → executeAiWriteTool (enqueues to approval queue, never executes directly)
 */

import { executeAiWriteTool, type AiWriteFns } from './ai-tools.js';
import { statSync } from 'node:fs';

/** Type alias for the i18n translation function. */
type TFn = (key: string, params?: Record<string, unknown>) => string;

/** A minimal DB handle shape the handlers need. */
interface DbLike {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
}

/** All dependencies the factory needs to build the router + handlers. */
export interface ToolRouterFactoryDeps {
  /** Default project id (from the chat request). */
  project_id?: number;
  /** Session id for the approval queue. */
  toolSessionId: string;
  /** Write-tool functions (optional — if absent, write tools are disabled). */
  writeFns?: AiWriteFns;
  /** Sensitive-file predicate (e.g. .env, *.key). */
  isSensitiveFile: (name: string) => boolean;
  /** Reads ai.risk_level from config. */
  getRiskLevel: () => string;
  /** scanDirectory from @doc77/core scanner. */
  scanDirectory: (
    pid: number,
    dirPath: string,
  ) => { entries: Array<{ type: string; name: string; size?: number }> };
  /** readProjectFileContent closure (reads + truncates to 4000 chars). */
  readProjectFileContent: (pid: number, filePath: string) => string;
  /** validatePath from @doc77/core security. */
  validatePath: (root: string, rel: string) => string;
  /** SQLite connection (for project path lookups). */
  db: DbLike;
  /** i18n translation function. */
  t: TFn;
}

/**
 * Build a ToolRouter-backed executeTool function.
 *
 * Returns `(name, args) => Promise<string>` — the exact signature the
 * AgentLoop's StreamingToolExecutor expects. Each call flows through:
 *
 *   ToolRouter.execute()
 *     → permission gate (risk level + sensitive file)
 *     → handler dispatch
 *     → result.output (string the LLM sees)
 */
export async function createToolRouterExecutor(
  deps: ToolRouterFactoryDeps,
): Promise<(name: string, args: Record<string, unknown>) => Promise<string>> {
  // Dynamic import — @doc77/mcp is an optional peer dep. In the AI-enabled
  // build it's always present, but the lazy import keeps the non-AI build
  // working without the mcp package installed.
  const { ToolRouter } = await import('@doc77/mcp');
  type ToolHandler = (
    args: Record<string, unknown>,
    ctx: { projectId: number; sessionId: string },
  ) => Promise<string>;
  type ToolRouterInstance = InstanceType<typeof ToolRouter>;

  const router = new ToolRouter({
    isSensitiveFile: deps.isSensitiveFile,
    getRiskLevel: () => deps.getRiskLevel() as 'low' | 'medium' | 'high',
    formatMessage: (key: string, params?: Record<string, unknown>) => deps.t(key, params),
  }) as ToolRouterInstance;

  // ── Register read-tool handlers ──
  // These are pure functions over the project filesystem — no side effects,
  // safe to run concurrently.
  const readHandlers: Record<string, ToolHandler> = {
    list_files: async (args, ctx) => {
      const dirPath = (args.dir_path as string) || '';
      const result = deps.scanDirectory(ctx.projectId, dirPath);
      const entries = result.entries.slice(0, 50);
      if (entries.length === 0) {
        return deps.t('ai.context.dirEmpty', { dirPath: dirPath || '/' });
      }
      return entries
        .map(
          (e) =>
            `${e.type === 'directory' ? '📁' : '📄'} ${e.name} (${e.type}, ${e.size ?? 'N/A'} bytes)`,
        )
        .join('\n');
    },
    read_file: async (args, ctx) => {
      return deps.readProjectFileContent(ctx.projectId, args.file_path as string);
    },
    get_file_info: async (args, ctx) => {
      const filePath = args.file_path as string;
      if (!filePath) return 'Error: file_path is required';
      try {
        const project = deps.db
          .prepare('SELECT path FROM projects WHERE id = ?')
          .get(ctx.projectId) as { path: string } | undefined;
        if (!project) return 'Error: Project not found';
        const absPath = deps.validatePath(project.path, filePath);
        const stats = statSync(absPath);
        return `File: ${filePath}\nType: ${stats.isDirectory() ? 'directory' : 'file'}\nSize: ${stats.size} bytes\nModified: ${stats.mtime.toISOString()}`;
      } catch (e: unknown) {
        return `Error: ${e instanceof Error ? e.message : 'Unknown'}`;
      }
    },
    list_projects: async () => {
      const { listProjects } = await import('@doc77/mcp');
      return JSON.stringify(listProjects());
    },
    search_files: async (args, ctx) => {
      const { searchFiles } = await import('@doc77/mcp');
      const results = searchFiles(ctx.projectId, args.query as string, {
        searchPath: args.path as string | undefined,
        glob: args.glob as string | undefined,
      });
      return JSON.stringify(results);
    },
  };
  (router as unknown as { registerAll: (h: Record<string, ToolHandler>) => void }).registerAll(
    readHandlers,
  );

  // ── Register write-tool handlers ──
  // These delegate to executeAiWriteTool, which enqueues a pending task in
  // the approval queue. The ToolRouter's permission gate runs first — if
  // the risk level is too low or a sensitive file is touched, the call is
  // denied before reaching executeAiWriteTool.
  if (deps.writeFns) {
    const writeDeps = {
      writeFns: deps.writeFns,
      isSensitiveFile: deps.isSensitiveFile,
      getRiskLevel: deps.getRiskLevel,
    };
    const writeHandlers: Record<string, ToolHandler> = {
      write_file: async (args, ctx) => executeAiWriteTool('write_file', args, ctx, writeDeps),
      move_file: async (args, ctx) => executeAiWriteTool('move_file', args, ctx, writeDeps),
      create_folder: async (args, ctx) => executeAiWriteTool('create_folder', args, ctx, writeDeps),
      delete_file: async (args, ctx) => executeAiWriteTool('delete_file', args, ctx, writeDeps),
      batch_operations: async (args, ctx) =>
        executeAiWriteTool('batch_operations', args, ctx, writeDeps),
    };
    (router as unknown as { registerAll: (h: Record<string, ToolHandler>) => void }).registerAll(
      writeHandlers,
    );
  }

  // ── Return the executeTool closure ──
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const pid = (args.project_id as number) || deps.project_id;
    console.error(`[ai-loop] executeTool: "${name}" pid=${pid}`, args);
    if (!pid) return 'Error: project_id is required';

    const result = await (
      router as unknown as {
        execute: (
          name: string,
          args: Record<string, unknown>,
          ctx: { projectId: number; sessionId: string },
        ) => Promise<{ output: string; success: boolean; denied: boolean; denialReason?: string }>;
      }
    ).execute(name, args, { projectId: pid, sessionId: deps.toolSessionId });

    if (!result.success && result.denied) {
      console.error(`[ai-loop] tool "${name}" denied: ${result.denialReason}`);
    }
    return result.output;
  };
}

/**
 * Tool permission annotations — declarative metadata for every tool the AI
 * agent can invoke.
 *
 * Each annotation captures three orthogonal concerns:
 *
 *   1. **permission** — the safety classification:
 *        - 'read'        — no side effects, safe to run concurrently
 *        - 'write'       — mutates the filesystem, requires approval
 *        - 'destructive' — irreversible (delete), requires approval + extra UI confirm
 *
 *   2. **concurrency** — how the StreamingToolExecutor may schedule it:
 *        - 'concurrent' — may run in parallel with other read tools
 *        - 'serial'     — must run alone, in arrival order (all writes)
 *
 *   3. **riskLevelRequired** — the minimum `ai.risk_level` config that
 *      permits this tool. The ToolRouter's permission gate checks this
 *      before dispatching to the handler.
 *
 * This metadata is the single source of truth for tool safety. The
 * StreamingToolExecutor reads `concurrency` to decide scheduling; the
 * ToolRouter reads `permission` + `riskLevelRequired` to decide gating;
 * the frontend reads `permission` to render the right indicator color.
 */

export type ToolPermission = 'read' | 'write' | 'destructive';
export type ToolConcurrency = 'concurrent' | 'serial';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ToolAnnotation {
  /** Tool name (matches the OpenAI function-calling `name` field). */
  name: string;
  /** Safety classification — drives UI indicator color and approval flow. */
  permission: ToolPermission;
  /** Scheduling hint for StreamingToolExecutor. */
  concurrency: ToolConcurrency;
  /** Minimum risk level required to permit this tool. */
  riskLevelRequired: RiskLevel;
  /** Human-readable summary shown in audit logs and the UI. */
  summary: string;
}

/**
 * The canonical annotation table. Keys are tool names.
 *
 * Risk level hierarchy (each level permits the previous level's tools):
 *   low    → create_folder only
 *   medium → + move_file, batch_operations (move/create only)
 *   high   → + write_file, delete_file
 *
 * `delete_file` is classified as 'destructive' (not just 'write') so the
 * UI can render an extra confirmation step and the audit log can flag it.
 */
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotation> = {
  // ── Read tools (concurrent, no risk gate) ──
  list_files: {
    name: 'list_files',
    permission: 'read',
    concurrency: 'concurrent',
    riskLevelRequired: 'low',
    summary: 'List directory contents',
  },
  read_file: {
    name: 'read_file',
    permission: 'read',
    concurrency: 'concurrent',
    riskLevelRequired: 'low',
    summary: 'Read file content',
  },
  get_file_info: {
    name: 'get_file_info',
    permission: 'read',
    concurrency: 'concurrent',
    riskLevelRequired: 'low',
    summary: 'Get file metadata',
  },
  list_projects: {
    name: 'list_projects',
    permission: 'read',
    concurrency: 'concurrent',
    riskLevelRequired: 'low',
    summary: 'List all projects',
  },
  search_files: {
    name: 'search_files',
    permission: 'read',
    concurrency: 'concurrent',
    riskLevelRequired: 'low',
    summary: 'Search files by name or content',
  },

  // ── Write tools (serial, risk-gated, approval required) ──
  write_file: {
    name: 'write_file',
    permission: 'write',
    concurrency: 'serial',
    riskLevelRequired: 'high',
    summary: 'Write file content (approval required)',
  },
  move_file: {
    name: 'move_file',
    permission: 'write',
    concurrency: 'serial',
    riskLevelRequired: 'medium',
    summary: 'Move or rename file (approval required)',
  },
  create_folder: {
    name: 'create_folder',
    permission: 'write',
    concurrency: 'serial',
    riskLevelRequired: 'low',
    summary: 'Create folder (approval required)',
  },
  delete_file: {
    name: 'delete_file',
    permission: 'destructive',
    concurrency: 'serial',
    riskLevelRequired: 'high',
    summary: 'Delete file (approval required, irreversible)',
  },
  batch_operations: {
    name: 'batch_operations',
    permission: 'write',
    concurrency: 'serial',
    riskLevelRequired: 'medium',
    summary: 'Batch file operations (approval required)',
  },
};

/** Risk level rank — higher number permits more tools. */
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/**
 * Check whether a given risk level satisfies the tool's requirement.
 * `medium` satisfies tools requiring `low` or `medium`; `high` satisfies all.
 */
export function riskLevelPermits(
  current: RiskLevel,
  required: RiskLevel,
): boolean {
  return RISK_RANK[current] >= RISK_RANK[required];
}

/** Look up an annotation by tool name. Returns undefined for unknown tools. */
export function getAnnotation(name: string): ToolAnnotation | undefined {
  return TOOL_ANNOTATIONS[name];
}

/** True if the tool is read-only (safe to run concurrently). */
export function isReadOnlyTool(name: string): boolean {
  const ann = TOOL_ANNOTATIONS[name];
  return ann?.permission === 'read';
}

/** True if the tool requires approval (write or destructive). */
export function requiresApproval(name: string): boolean {
  const ann = TOOL_ANNOTATIONS[name];
  return ann?.permission === 'write' || ann?.permission === 'destructive';
}

/** True if the tool is irreversible (destructive). */
export function isDestructive(name: string): boolean {
  return TOOL_ANNOTATIONS[name]?.permission === 'destructive';
}

/**
 * For batch_operations, determine the effective permission based on the
 * contained operation types. A batch containing any delete_file op is
 * classified as 'destructive'; otherwise 'write'.
 */
export function classifyBatchOps(
  ops: Array<{ type?: string }>,
): ToolPermission {
  if (!Array.isArray(ops)) return 'write';
  for (const op of ops) {
    if (op?.type === 'delete_file') return 'destructive';
  }
  return 'write';
}

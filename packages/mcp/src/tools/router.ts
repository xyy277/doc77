/**
 * ToolRouter — the single permission gateway between the AI agent and all
 * tool handlers.
 *
 * Responsibilities:
 *   1. **Permission gate** — check risk level + sensitive-file protection
 *      before dispatching any tool. Rejects early with a human-readable
 *      error string (which becomes the tool result the LLM sees).
 *   2. **Handler registry** — tools are registered with their handler fn;
 *      the router looks up by name and invokes. Unknown tools return an
 *      error instead of throwing.
 *   3. **Batch execution** — `executeBatch()` groups calls by concurrency
 *      annotation: read tools run concurrently (Promise.all), write tools
 *      run serially in arrival order. This complements the
 *      StreamingToolExecutor (which handles streaming arrival) with a
 *      synchronous batch API for non-streaming callers.
 *   4. **Audit metadata** — every result carries `permission`, `elapsedMs`,
 *      `success` so the caller can log to `ai_tool_logs` without re-deriving
 *      the classification.
 *
 * Design notes:
 *   - Handlers are injected (not imported) so the router is unit-testable
 *     without a live database or filesystem. app.ts wires the real handlers.
 *   - The router does NOT own the approval queue — write handlers enqueue
 *     pending tasks themselves and return the task id. The router only
 *     checks permissions before the handler runs.
 *   - Sensitive-file protection is delegated to the injected
 *     `isSensitiveFile` predicate so the router stays policy-agnostic.
 */

import {
  TOOL_ANNOTATIONS,
  riskLevelPermits,
  classifyBatchOps,
  type ToolAnnotation,
  type RiskLevel,
  type ToolPermission,
} from './annotations.js';

/** A single tool handler function. Returns the string the LLM sees. */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string>;

/** Per-invocation context passed to every handler. */
export interface ToolContext {
  projectId: number;
  sessionId: string;
}

/** Dependencies injected at construction — keep the router pure/testable. */
export interface ToolRouterDeps {
  /** Predicate: does this filename look sensitive (.env / *.key / …)? */
  isSensitiveFile: (name: string) => boolean;
  /** Reads `ai.risk_level` from config: 'low' | 'medium' | 'high'. */
  getRiskLevel: () => RiskLevel;
  /**
   * Optional i18n message formatter. When omitted, messages fall back to
   * hardcoded English so the router works in unit tests without i18n setup.
   */
  formatMessage?: (key: string, params?: Record<string, unknown>) => string;
}

/** The structured result of a single tool execution. */
export interface ToolRouteResult {
  toolName: string;
  /** The string the LLM sees as the tool result. */
  output: string;
  success: boolean;
  permission: ToolPermission;
  elapsedMs: number;
  errorMessage?: string;
  /** True if the call was rejected by the permission gate (never dispatched). */
  denied: boolean;
  /** Reason for denial, if denied. */
  denialReason?: 'risk_level' | 'sensitive_file' | 'unknown_tool';
}

/** A pending tool call awaiting execution. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export class ToolRouter {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly deps: ToolRouterDeps;

  constructor(deps: ToolRouterDeps) {
    this.deps = deps;
  }

  /** Register a handler for a tool name. Overwrites any prior registration. */
  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  /** Register multiple handlers at once. */
  registerAll(handlers: Record<string, ToolHandler>): void {
    for (const [name, handler] of Object.entries(handlers)) {
      this.register(name, handler);
    }
  }

  /** Look up the annotation for a tool. */
  getAnnotation(name: string): ToolAnnotation | undefined {
    return TOOL_ANNOTATIONS[name];
  }

  /** True if the tool is read-only (safe for concurrent execution). */
  isReadOnly(name: string): boolean {
    return TOOL_ANNOTATIONS[name]?.permission === 'read';
  }

  /** True if a handler has been registered for this tool. */
  hasHandler(name: string): boolean {
    return this.handlers.has(name);
  }

  /**
   * Execute a single tool call through the full permission pipeline.
   *
   * Pipeline:
   *   1. Look up annotation → unknown tool → deny
   *   2. Check risk level → insufficient → deny
   *   3. Check sensitive files → matches → deny
   *   4. Dispatch to handler → catch errors → return result
   *
   * Denials return a result with `success=false, denied=true` and a
   * human-readable error string as `output` (so the LLM sees why it was
   * rejected). Denials never throw.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolRouteResult> {
    const t0 = Date.now();
    const annotation = TOOL_ANNOTATIONS[name];

    // ── Gate 1: unknown tool ──
    if (!annotation) {
      return this.deny(name, t0, 'unknown_tool', `Error: Unknown tool "${name}"`);
    }

    // ── Gate 2: risk level ──
    // For batch_operations, the effective permission depends on the
    // contained op types — a batch with delete_file requires 'high'.
    const currentRisk = this.deps.getRiskLevel();
    let requiredRisk = annotation.riskLevelRequired;
    if (name === 'batch_operations') {
      const ops = (args.operations as Array<{ type?: string }>) || [];
      const effective = classifyBatchOps(ops);
      if (effective === 'destructive') requiredRisk = 'high';
    }
    if (!riskLevelPermits(currentRisk, requiredRisk)) {
      const msg = this.fmt('ai.runtime.riskLevelDenied', {
        riskLevel: currentRisk,
        opType: name,
      });
      return this.deny(name, t0, 'risk_level', msg);
    }

    // ── Gate 3: sensitive files ──
    const sensitivePath = this.findSensitivePath(name, args);
    if (sensitivePath) {
      const msg = this.fmt('ai.runtime.sensitiveRejected', {
        filePath: sensitivePath,
      });
      return this.deny(name, t0, 'sensitive_file', msg);
    }

    // ── Dispatch ──
    const handler = this.handlers.get(name);
    if (!handler) {
      return this.deny(name, t0, 'unknown_tool', `Error: No handler registered for "${name}"`);
    }

    try {
      const output = await handler(args, ctx);
      return {
        toolName: name,
        output,
        success: true,
        permission: annotation.permission,
        elapsedMs: Date.now() - t0,
        denied: false,
      };
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'Unknown error';
      return {
        toolName: name,
        output: `Error: ${errMsg}`,
        success: false,
        permission: annotation.permission,
        elapsedMs: Date.now() - t0,
        denied: false,
        errorMessage: errMsg,
      };
    }
  }

  /**
   * Execute a batch of tool calls. Read tools run concurrently (up to
   * `maxConcurrency` at a time); write tools run serially in arrival order.
   * Results are returned in the same order as the input calls.
   *
   * This is the synchronous-callers' counterpart to StreamingToolExecutor:
   * use this when you have all tool calls up front (e.g. a non-streaming
   * completion), and StreamingToolExecutor when calls arrive incrementally.
   */
  async executeBatch(
    calls: ToolCall[],
    ctx: ToolContext,
    opts: { maxConcurrency?: number } = {},
  ): Promise<ToolRouteResult[]> {
    const maxConcurrency = opts.maxConcurrency ?? 4;
    const results: ToolRouteResult[] = new Array(calls.length);

    // Partition by concurrency class while preserving arrival order
    const readIndices: number[] = [];
    const writeIndices: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      if (this.isReadOnly(calls[i].name)) readIndices.push(i);
      else writeIndices.push(i);
    }

    // Run read tools concurrently (bounded), write tools serially.
    // Both pipelines write into the shared `results` array at their
    // original indices, so order is preserved on output.
    const readPromise = this.runConcurrent(
      readIndices.map((idx) => ({ idx, call: calls[idx] })),
      ctx,
      maxConcurrency,
      results,
    );
    const writePromise = this.runSerial(
      writeIndices.map((idx) => ({ idx, call: calls[idx] })),
      ctx,
      results,
    );

    await Promise.all([readPromise, writePromise]);
    return results;
  }

  /** Run a list of read tools concurrently, bounded by maxConcurrency. */
  private async runConcurrent(
    items: Array<{ idx: number; call: ToolCall }>,
    ctx: ToolContext,
    maxConcurrency: number,
    results: ToolRouteResult[],
  ): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const worker = async () => {
      while (cursor < items.length) {
        const current = items[cursor++];
        results[current.idx] = await this.execute(
          current.call.name,
          current.call.args,
          ctx,
        );
      }
    };
    const workerCount = Math.min(maxConcurrency, items.length);
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);
  }

  /** Run a list of write tools strictly serially, in arrival order. */
  private async runSerial(
    items: Array<{ idx: number; call: ToolCall }>,
    ctx: ToolContext,
    results: ToolRouteResult[],
  ): Promise<void> {
    for (const item of items) {
      results[item.idx] = await this.execute(item.call.name, item.call.args, ctx);
    }
  }

  // ── Helpers ──

  /**
   * Check whether any path in the tool args matches the sensitive-file
   * predicate. Returns the first sensitive path found, or null.
   */
  private findSensitivePath(
    name: string,
    args: Record<string, unknown>,
  ): string | null {
    const paths = this.extractPaths(name, args);
    for (const p of paths) {
      if (p && this.deps.isSensitiveFile(this.basename(p))) {
        return p;
      }
    }
    return null;
  }

  /** Extract all filesystem paths a tool call touches. */
  private extractPaths(
    name: string,
    args: Record<string, unknown>,
  ): string[] {
    if (name === 'batch_operations') {
      const ops = (args.operations as Array<Record<string, unknown>>) || [];
      return ops.flatMap((op) => this.extractPaths(op.type as string, op));
    }
    const fields: string[] = [];
    if (name === 'write_file' || name === 'delete_file' || name === 'get_file_info' || name === 'read_file') {
      fields.push('file_path');
    } else if (name === 'move_file') {
      fields.push('source', 'target');
    } else if (name === 'create_folder') {
      fields.push('folder_path');
    }
    return fields.map((f) => args[f] as string).filter(Boolean);
  }

  private basename(p: string): string {
    return p.split('/').pop() || p;
  }

  private fmt(key: string, params?: Record<string, unknown>): string {
    if (this.deps.formatMessage) return this.deps.formatMessage(key, params);
    // Fallback English messages (for unit tests without i18n)
    const fallbacks: Record<string, string> = {
      'ai.runtime.riskLevelDenied': `Risk level "${params?.riskLevel || ''}" does not permit "${params?.opType || ''}"`,
      'ai.runtime.sensitiveRejected': `Rejected: "${params?.filePath || ''}" is a sensitive file`,
    };
    return fallbacks[key] || key;
  }

  private deny(
    name: string,
    t0: number,
    reason: NonNullable<ToolRouteResult['denialReason']>,
    message: string,
  ): ToolRouteResult {
    return {
      toolName: name,
      output: message,
      success: false,
      permission: TOOL_ANNOTATIONS[name]?.permission ?? 'read',
      elapsedMs: Date.now() - t0,
      denied: true,
      denialReason: reason,
    };
  }
}

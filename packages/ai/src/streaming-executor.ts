/**
 * StreamingToolExecutor — executes tool calls as they arrive from the stream.
 *
 * Unlike the old DocAgent which waited for the full LLM response before
 * executing any tools, this executor enqueues each tool_call the moment it
 * is parsed from the SSE stream. This means read-only tools (list_files,
 * read_file, etc.) can start running while the model is still generating
 * text or additional tool calls — cutting end-to-end latency for multi-tool
 * turns.
 *
 * Concurrency model:
 *   - Read-only tools run concurrently (up to `maxConcurrency` at a time)
 *   - Write tools run serially (one at a time, in arrival order)
 *   - Write tools are never reordered ahead of reads that arrived earlier
 *
 * The `results()` async generator yields completed tool results in **arrival
 * order** (not completion order) so the caller can persist them predictably
 * and the resulting message tree matches the LLM's tool_call ordering.
 */

export interface ToolCallRequest {
  id: string;
  name: string;
  argsStr: string;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  argsStr: string;
  output: string;
  success: boolean;
  elapsedMs: number;
  errorMessage?: string;
}

export type ToolExecutorFn = (name: string, args: Record<string, unknown>) => Promise<string>;

/**
 * Set of tool names that are read-only and safe to run concurrently.
 * Everything else is treated as a write tool and serialized.
 */
export const READ_ONLY_TOOLS = new Set([
  'list_files',
  'read_file',
  'get_file_info',
  'list_projects',
  'search_files',
  'search_content',
]);

export interface StreamingExecutorOptions {
  maxConcurrency?: number;
  /** Predicate override for read-only classification. */
  isReadOnly?: (toolName: string) => boolean;
}

interface PendingEntry {
  call: ToolCallRequest;
  arrivalIndex: number;
}

export class StreamingToolExecutor {
  private readonly executeTool: ToolExecutorFn;
  private readonly maxConcurrency: number;
  private readonly isReadOnly: (toolName: string) => boolean;

  private pending: PendingEntry[] = [];
  /** Completed results keyed by arrival index for ordered yielding. */
  private completed: Map<number, ToolResult> = new Map();
  private runningCount = 0;
  private allEnqueued = false;
  private totalEnqueued = 0;
  private resolveResults?: () => void;

  constructor(executeTool: ToolExecutorFn, opts: StreamingExecutorOptions = {}) {
    this.executeTool = executeTool;
    this.maxConcurrency = opts.maxConcurrency ?? 4;
    this.isReadOnly = opts.isReadOnly ?? ((name) => READ_ONLY_TOOLS.has(name));
  }

  /**
   * Enqueue a tool call for execution. Starts processing immediately if
   * a concurrency slot is available.
   */
  enqueue(call: ToolCallRequest): void {
    const arrivalIndex = this.totalEnqueued++;
    this.pending.push({ call, arrivalIndex });
    this.pump();
  }

  /** Signal that no more tool calls will arrive (stream ended). */
  seal(): void {
    this.allEnqueued = true;
    this.pump();
  }

  /**
   * Async generator yielding results in **arrival order**. Blocks until all
   * enqueued tools have completed and been yielded.
   *
   * If tool B (arrival 1) finishes before tool A (arrival 0), B's result is
   * buffered until A completes — guaranteeing the caller sees results in the
   * same order the LLM emitted the tool_calls.
   */
  async *results(): AsyncGenerator<ToolResult> {
    let nextYield = 0;
    while (true) {
      // Yield any completed results that are next in arrival order
      while (this.completed.has(nextYield)) {
        yield this.completed.get(nextYield)!;
        this.completed.delete(nextYield);
        nextYield++;
      }
      // Termination: all enqueued tools have been yielded
      if (this.allEnqueued && nextYield >= this.totalEnqueued) {
        break;
      }
      // Wait for more results to complete
      await new Promise<void>((resolve) => {
        this.resolveResults = resolve;
      });
    }
  }

  /**
   * Try to dispatch pending tool calls, respecting the concurrency limit
   * and read/write classification. Completed results are stored in
   * `completed` keyed by arrival index.
   */
  private pump(): void {
    while (this.pending.length > 0 && this.runningCount < this.maxConcurrency) {
      const entry = this.pending[0];

      // If the next tool is a write tool, only dispatch it when nothing
      // else is running (serial execution for writes).
      if (!this.isReadOnly(entry.call.name)) {
        if (this.runningCount > 0) break; // wait for running tools to finish
      }

      this.pending.shift();
      this.runningCount++;
      this.executeOne(entry.call, entry.arrivalIndex);
    }

    // If sealed and everything is done, wake up the results generator
    if (this.allEnqueued && this.pending.length === 0 && this.runningCount === 0) {
      this.resolveResults?.();
      this.resolveResults = undefined;
    }
  }

  private async executeOne(call: ToolCallRequest, arrivalIndex: number): Promise<void> {
    const t0 = Date.now();
    let args: Record<string, unknown> = {};
    try {
      args = call.argsStr ? JSON.parse(call.argsStr) : {};
    } catch {
      args = {};
    }

    let result: ToolResult;
    try {
      const output = await this.executeTool(call.name, args);
      const elapsed = Date.now() - t0;
      result = {
        toolCallId: call.id,
        toolName: call.name,
        argsStr: call.argsStr,
        output,
        success: true,
        elapsedMs: elapsed,
      };
    } catch (e: unknown) {
      const elapsed = Date.now() - t0;
      const errMsg = e instanceof Error ? e.message : 'Unknown error';
      result = {
        toolCallId: call.id,
        toolName: call.name,
        argsStr: call.argsStr,
        output: `Error: ${errMsg}`,
        success: false,
        elapsedMs: elapsed,
        errorMessage: errMsg,
      };
    }

    this.completed.set(arrivalIndex, result);
    this.runningCount--;
    this.pump();

    // Wake up the results generator
    this.resolveResults?.();
    this.resolveResults = undefined;
  }
}

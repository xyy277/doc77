/**
 * AgentLoop — the five-layer agent harness (Phase 3 redesign).
 *
 * Replaces DocAgent with a production-grade agent loop inspired by Claude
 * Code's harness pattern. The five layers run in order each iteration:
 *
 *   Layer 1: ContextManager.compact()  — compress context before API call
 *   Layer 2: provider.chatStream()      — stream tokens + execute tools on arrival
 *   Layer 3: Error recovery             — tool errors are results, not exceptions
 *   Layer 4: Termination                — no tool_use / maxSteps / user cancel
 *   Layer 5: Persistence                — write messages + tool logs after each step
 *
 * Key improvements over DocAgent:
 *   - Tree-structured message persistence (via PersistenceAdapter)
 *   - Context compression (prevents long-conversation crashes)
 *   - Streaming tool execution (tools start running as they arrive)
 *   - Real-time steering (cancel / inject mid-stream)
 *   - Tool error isolation (errors become results for the LLM to handle)
 *   - Token tracking (input + output per step)
 *
 * The loop is agnostic to the persistence layer — it accepts a
 * PersistenceAdapter interface that @doc77/core's SessionStore satisfies.
 * This keeps @doc77/ai testable without a database.
 */

import {
  AiProvider,
  normalizeMessages,
  type AiMessage,
  type ToolDefinition,
  type StreamChunk,
} from '../provider/index.js';
import { ContextManager, estimateMessagesTokens } from '../context-manager.js';
import { StreamingToolExecutor, type ToolExecutorFn } from '../streaming-executor.js';
import { InterruptQueue, type UserInterrupt } from '../interrupt-queue.js';

// ── Types ────────────────────────────────────────────────────

/** Events emitted by the agent loop, consumed by the SSE handler. */
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'token'; content: string }
  | { type: 'tool_call_start'; name: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; toolName: string; output: string; success: boolean; elapsedMs: number }
  | { type: 'context_compacted'; summary: string; compactedCount: number }
  | { type: 'skill_activated'; name: string }
  | {
      type: 'done';
      finishReason: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    }
  | { type: 'error'; message: string };

/**
 * Persistence adapter — bridges AgentLoop to SessionStore without a hard
 * dependency on @doc77/core. The caller (createAIChatHandler) wires this
 * to the real SessionStore functions.
 */
export interface PersistenceAdapter {
  /** Append a message to the session's message tree. Returns the new message ID. */
  appendMessage(
    sessionId: string,
    msg: {
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      parentId?: string | null;
      toolCalls?: unknown[] | null;
      toolCallId?: string | null;
      toolName?: string | null;
      tokenCount?: number | null;
      finishReason?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): string;
  /** Get the current leaf message ID for a session. */
  getCurrentLeafId(sessionId: string): string | null;
  /** Get the message path (root → leaf) as AiMessage[]. */
  getMessagePath(sessionId: string, leafId?: string | null): AiMessage[];
  /** Add token usage to the session's counters. */
  addTokenUsage(sessionId: string, inputTokens: number, outputTokens: number): void;
  /** Log a tool call to the audit table. */
  logToolCall(entry: {
    sessionId: string;
    messageId?: string | null;
    toolName: string;
    input?: unknown;
    output?: unknown;
    elapsedMs?: number;
    success?: boolean;
    errorMessage?: string | null;
  }): void;
}

export interface AgentLoopConfig {
  provider: AiProvider;
  model: string;
  tools: ToolDefinition[];
  executeTool: ToolExecutorFn;
  maxSteps?: number;
  /** System prompt (static portion). If omitted, uses a minimal default. */
  systemPrompt?: string;
  /** Persistence adapter. If omitted, the loop runs stateless (no DB writes). */
  persistence?: PersistenceAdapter;
  /** Context manager. If omitted, a default one is created. */
  contextManager?: ContextManager;
  /** Model context window in tokens. Default 8192. */
  contextWindow?: number;
  /** Disable tools for this loop (e.g. when context is pre-injected). */
  noTools?: boolean;
}

// ── AgentLoop ────────────────────────────────────────────────

export class AgentLoop {
  private provider: AiProvider;
  private model: string;
  private tools: ToolDefinition[];
  private executeTool: ToolExecutorFn;
  private maxSteps: number;
  private systemPrompt: string;
  private persistence: PersistenceAdapter | null;
  private contextManager: ContextManager;
  private contextWindow: number;
  private noTools: boolean;
  private interruptQueue: InterruptQueue;

  constructor(config: AgentLoopConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.tools = config.tools;
    this.executeTool = config.executeTool;
    this.maxSteps = config.maxSteps ?? 10;
    this.systemPrompt = config.systemPrompt ?? '';
    this.persistence = config.persistence ?? null;
    this.contextManager = config.contextManager ?? new ContextManager();
    this.contextWindow = config.contextWindow ?? 8192;
    this.noTools = config.noTools ?? false;
    this.interruptQueue = new InterruptQueue();
  }

  /** Get the interrupt queue (for cancel/inject from the SSE handler). */
  get interrupts(): InterruptQueue {
    return this.interruptQueue;
  }

  /**
   * Run the agent loop for a single user message within a session.
   *
   * Yields AgentEvent chunks for SSE streaming. The loop persists every
   * message (user, assistant, tool) to the SessionStore via the
   * persistence adapter, building a tree-structured conversation history.
   *
   * @param sessionId  Session ID (must already exist in the store)
   * @param userMessage  The user's input text
   * @param opts.noTools  Override: disable tools for this turn only
   * @param opts.skipAppendUser  Skip appending the user message (used by
   *   `regenerate` — the caller has already switched the leaf to the parent
   *   user message, so the history already contains it; we only want to
   *   generate a new assistant sibling without duplicating the user turn).
   *   When true, `userMessage` is ignored.
   */
  async *run(
    sessionId: string,
    userMessage: string,
    opts: { noTools?: boolean; skipAppendUser?: boolean } = {},
  ): AsyncGenerator<AgentEvent> {
    yield { type: 'session', sessionId };

    const useTools = !opts.noTools && !this.noTools && this.tools.length > 0;

    // ── Load conversation history from the store (or start fresh) ──
    let messages: AiMessage[] = [];
    if (this.persistence) {
      messages = this.persistence.getMessagePath(sessionId);
    }

    // Ensure there's a system prompt at the start
    if (messages.length === 0 || messages[0].role !== 'system') {
      messages.unshift({
        role: 'system',
        content: this.systemPrompt || 'You are a helpful assistant.',
      });
    }

    // ── Append the user message (skipped for regenerate) ──
    // For regenerate, the caller switched the leaf to the parent user
    // message, so the path already ends with that user message. We must
    // NOT append a duplicate — we only want a new assistant sibling.
    const parentId = this.persistence?.getCurrentLeafId(sessionId) ?? null;
    let userMsgId: string | null = null;
    if (opts.skipAppendUser) {
      // The leaf IS the user message we're responding to.
      userMsgId = parentId;
    } else if (this.persistence) {
      userMsgId = this.persistence.appendMessage(sessionId, {
        role: 'user',
        content: userMessage,
        parentId,
      });
      messages.push({ role: 'user', content: userMessage });
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    let step = 0;
    let lastMsgId = userMsgId; // for linking the next assistant message
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    while (step < this.maxSteps) {
      step++;

      // ── Layer 1: Context compression ──
      const compactResult = await this.contextManager.compact(messages, {
        maxTokens: this.contextWindow,
        threshold: 0.7,
        keepLastN: 10,
      });
      if (compactResult.compacted) {
        messages = compactResult.messages;
        if (compactResult.summary) {
          yield {
            type: 'context_compacted',
            summary: compactResult.summary.slice(0, 200),
            compactedCount: compactResult.compactedCount,
          };
        }
      }

      // ── Prepare API messages (normalize system messages) ──
      const apiMessages = normalizeMessages(messages);

      // ── Layer 2: Stream + execute tools ──
      const toolExecutor = new StreamingToolExecutor(this.executeTool);
      let assistantContent = '';
      const toolCalls: Array<{ id: string; name: string; argsStr: string }> = [];
      let streamUsage: { prompt_tokens: number; completion_tokens: number } | undefined;
      let streamError: string | null = null;

      for await (const chunk of this.provider.chatStream({
        model: this.model,
        messages: apiMessages,
        tools: useTools ? this.tools : undefined,
      })) {
        // ── Check interrupt queue between chunks ──
        if (this.interruptQueue.cancelPending) {
          this.interruptQueue.clear();
          streamError = 'Cancelled by user';
          break;
        }
        // Process inject interrupts (append to messages without stopping)
        const injects = this.interruptQueue.drain().filter((i) => i.type === 'inject');
        for (const inj of injects) {
          if (inj.message) {
            messages.push({ role: 'user', content: inj.message });
          }
        }

        switch (chunk.type) {
          case 'token':
            assistantContent += chunk.content;
            yield { type: 'token', content: chunk.content };
            break;
          case 'tool_call_start':
            yield { type: 'tool_call_start', name: chunk.name };
            break;
          case 'tool_call':
            toolCalls.push({ id: chunk.id, name: chunk.name, argsStr: chunk.arguments });
            yield { type: 'tool_call', id: chunk.id, name: chunk.name, arguments: chunk.arguments };
            // Enqueue for immediate execution (doesn't wait for stream end)
            toolExecutor.enqueue({ id: chunk.id, name: chunk.name, argsStr: chunk.arguments });
            break;
          case 'done':
            if (chunk.usage) {
              streamUsage = chunk.usage;
              totalInputTokens += chunk.usage.prompt_tokens || 0;
              totalOutputTokens += chunk.usage.completion_tokens || 0;
            }
            yield { type: 'done', finishReason: 'step_complete', usage: chunk.usage };
            break;
          case 'error':
            streamError = chunk.message;
            break;
        }
        if (streamError) break;
      }

      // ── Layer 3: Error recovery ──
      if (streamError) {
        // If we got partial content, persist it before reporting the error
        if (assistantContent && this.persistence) {
          lastMsgId = this.persistence.appendMessage(sessionId, {
            role: 'assistant',
            content: assistantContent,
            parentId: lastMsgId,
            finishReason: 'error',
            metadata: { error: streamError },
          });
        }
        yield { type: 'error', message: streamError };
        break;
      }

      // ── Seal the tool executor (no more tool calls will arrive) ──
      toolExecutor.seal();

      // ── Persist the assistant message ──
      const assistantTokenCount = estimateMessagesTokens([
        { role: 'assistant', content: assistantContent },
      ]);
      if (this.persistence) {
        const assistantMsgPayload: Parameters<PersistenceAdapter['appendMessage']>[1] = {
          role: 'assistant',
          content: assistantContent,
          parentId: lastMsgId,
          tokenCount: assistantTokenCount,
          finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        };
        if (toolCalls.length > 0) {
          assistantMsgPayload.toolCalls = toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.argsStr },
          }));
        }
        lastMsgId = this.persistence.appendMessage(sessionId, assistantMsgPayload);
        if (streamUsage) {
          this.persistence.addTokenUsage(
            sessionId,
            streamUsage.prompt_tokens || 0,
            streamUsage.completion_tokens || 0,
          );
        }
      }

      // ── Layer 4: Termination — no tool calls means we're done ──
      if (toolCalls.length === 0) {
        break;
      }

      // ── Wait for tool execution results + persist them ──
      for await (const result of toolExecutor.results()) {
        // ── Layer 5: Persist tool results ──
        if (this.persistence) {
          this.persistence.appendMessage(sessionId, {
            role: 'tool',
            content: result.output,
            parentId: lastMsgId,
            toolCallId: result.toolCallId,
            toolName: result.toolName,
          });
          this.persistence.logToolCall({
            sessionId,
            toolName: result.toolName,
            input: (() => {
              try {
                return JSON.parse(result.argsStr);
              } catch {
                return result.argsStr;
              }
            })(),
            output: result.output.slice(0, 1000),
            elapsedMs: result.elapsedMs,
            success: result.success,
            errorMessage: result.errorMessage ?? null,
          });
        }

        yield {
          type: 'tool_result',
          toolName: result.toolName,
          output: result.output,
          success: result.success,
          elapsedMs: result.elapsedMs,
        };

        // Add tool result to local message array for the next iteration
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: result.output,
        });
      }

      // Add assistant message with tool_calls to local history
      // (must be before the tool messages for the API to accept them)
      // This is already in messages via the streaming, but we need to
      // ensure the structure is correct for the next API call.
      // The assistant message with tool_calls was NOT added during streaming
      // (only content was captured). Add it now.
      const assistantMsgForHistory: AiMessage = {
        role: 'assistant',
        content: assistantContent,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argsStr },
        })),
      };

      // Insert the assistant message before the tool results we just added
      // (messages array currently ends with tool results; insert assistant before them)
      const toolResultCount = toolCalls.length;
      messages.splice(messages.length - toolResultCount, 0, assistantMsgForHistory);
    }

    // ── Final token tracking ──
    if (this.persistence && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      // Already added per-step, but ensure totals are reflected
    }
  }
}

/**
 * Create a minimal persistence adapter from SessionStore-style functions.
 * This is the bridge between @doc77/ai (AgentLoop) and @doc77/core (SessionStore).
 *
 * The caller passes the actual SessionStore functions; this wrapper adapts
 * the signatures to the PersistenceAdapter interface.
 */
export function createPersistenceAdapter(fns: {
  appendMessage: (sessionId: string, msg: Record<string, unknown>) => { id: string };
  getCurrentLeafId: (sessionId: string) => string | null;
  getMessagePath: (
    sessionId: string,
    leafId?: string | null,
  ) => Array<{
    id: string;
    role: string;
    content: string;
    toolCalls?: string | null;
    toolCallId?: string | null;
    toolName?: string | null;
    parentId?: string | null;
  }>;
  addTokenUsage: (sessionId: string, inputTokens: number, outputTokens: number) => void;
  logToolCall: (entry: Record<string, unknown>) => number;
}): PersistenceAdapter {
  return {
    appendMessage(sessionId, msg) {
      return fns.appendMessage(sessionId, msg).id;
    },
    getCurrentLeafId: fns.getCurrentLeafId,
    getMessagePath(sessionId, leafId) {
      return fns.getMessagePath(sessionId, leafId).map((m) => {
        const toolCalls = m.toolCalls ? JSON.parse(m.toolCalls) : undefined;
        return {
          role: m.role as AiMessage['role'],
          content: m.content,
          tool_call_id: m.toolCallId ?? undefined,
          tool_calls: toolCalls,
        } as AiMessage;
      });
    },
    addTokenUsage: fns.addTokenUsage,
    logToolCall: fns.logToolCall,
  };
}

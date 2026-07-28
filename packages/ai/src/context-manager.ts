/**
 * ContextManager — four-layer context compression pipeline.
 *
 * Borrowed from Claude Code's approach to keeping long conversations within
 * the model's context window without losing critical information. The
 * pipeline runs before each LLM API call:
 *
 *   Layer 1: Tool Result Budget — truncate individual tool outputs that
 *            exceed a token budget (prevents one huge file read from
 *            blowing the entire context).
 *
 *   Layer 2: Snip Compact — remove stale middle history, keeping only the
 *            system prompt, the most recent N messages, and a summary of
 *            what was removed. This is a structural trim (no LLM call).
 *
 *   Layer 3: Microcompact — compress verbose tool outputs (e.g. directory
 *            listings with 200 entries) into compact representations.
 *            Also a structural transform (no LLM call).
 *
 *   Layer 4: Auto-Compact — when the total token count exceeds a threshold
 *            (default 70% of maxTokens), invoke a lightweight LLM call to
 *            generate a summary of the older conversation, replacing the
 *            raw history with the summary. This is the only layer that
 *            makes an LLM call, so it's gated behind the threshold check.
 *
 * Each layer is idempotent — if the input is already compact enough, it
 * passes through unchanged. This lets us always run the full pipeline
 * without worrying about over-compression.
 */

import type { AiMessage, AiProvider } from './provider/index.js';

export interface CompactOptions {
  /** Model context window in tokens. Default 8192. */
  maxTokens?: number;
  /** Auto-compact trigger threshold (0-1). Default 0.7. */
  threshold?: number;
  /** Number of recent messages to always keep (never compacted). Default 10. */
  keepLastN?: number;
  /** Max tokens per tool result before truncation. Default 2000. */
  maxToolResultTokens?: number;
  /** Called when auto-compact runs, for SSE notification. */
  onCompact?: (summary: string, compactedCount: number) => void;
}

export interface CompactResult {
  messages: AiMessage[];
  /** True if any compression occurred. */
  compacted: boolean;
  /** Summary text if auto-compact ran, null otherwise. */
  summary: string | null;
  /** Number of messages removed/replaced. */
  compactedCount: number;
}

/** Rough token estimate: ~4 chars per token for mixed CJK/English. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // CJK characters are ~1 token each; ASCII is ~4 chars/token.
  // This is a heuristic — exact counts require the model's tokenizer.
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherChars = text.length - cjkCount;
  return Math.ceil(cjkCount + otherChars / 4);
}

/** Estimate total tokens for a message array. */
export function estimateMessagesTokens(messages: AiMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || '');
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.arguments || '');
      }
    }
  }
  return total;
}

export class ContextManager {
  private provider: AiProvider | null = null;
  private compactModel: string | null = null;

  /**
   * @param provider Optional AiProvider for LLM-driven auto-compact (Layer 4).
   *                 If null, auto-compact degrades to a structural summary.
   */
  constructor(provider?: AiProvider, compactModel?: string) {
    if (provider) {
      this.provider = provider;
      this.compactModel = compactModel || null;
    }
  }

  /**
   * Run the full four-layer compression pipeline.
   */
  async compact(messages: AiMessage[], opts: CompactOptions = {}): Promise<CompactResult> {
    const maxTokens = opts.maxTokens ?? 8192;
    const threshold = opts.threshold ?? 0.7;
    const keepLastN = opts.keepLastN ?? 10;
    const maxToolResultTokens = opts.maxToolResultTokens ?? 2000;

    let result = [...messages];
    let compactedCount = 0;
    let summary: string | null = null;

    // ── Layer 1: Tool Result Budget ──
    const before1 = estimateMessagesTokens(result);
    result = this.applyToolResultBudget(result, maxToolResultTokens);
    const after1 = estimateMessagesTokens(result);

    // ── Layer 2: Snip Compact ──
    if (result.length > keepLastN + 2) {
      // +2 for system + summary slot
      const snipped = this.snipCompact(result, keepLastN);
      compactedCount += snipped.removed;
      result = snipped.messages;
    }

    // ── Layer 3: Microcompact ──
    result = this.microcompact(result);

    // ── Layer 4: Auto-Compact (LLM-driven) ──
    const tokenCount = estimateMessagesTokens(result);
    if (tokenCount > maxTokens * threshold) {
      const autoResult = await this.autoCompact(result, {
        maxTokens,
        keepLastN,
        onCompact: opts.onCompact,
      });
      summary = autoResult.summary;
      compactedCount += autoResult.compactedCount;
      result = autoResult.messages;
    }

    const compacted = before1 > after1 || compactedCount > 0 || summary !== null;
    return { messages: result, compacted, summary, compactedCount };
  }

  /**
   * Layer 1: Truncate tool result messages that exceed the token budget.
   * Appends a truncation notice so the LLM knows content was cut.
   */
  applyToolResultBudget(messages: AiMessage[], maxTokens: number): AiMessage[] {
    const maxChars = maxTokens * 4; // rough chars-per-token
    return messages.map((msg) => {
      if (msg.role === 'tool' && estimateTokens(msg.content) > maxTokens) {
        return {
          ...msg,
          content:
            msg.content.slice(0, maxChars) +
            `\n\n[... truncated by context manager, original ${msg.content.length} chars]`,
        };
      }
      return msg;
    });
  }

  /**
   * Layer 2: Remove stale middle messages, keeping system + last N.
   * Returns the trimmed array and a count of removed messages.
   */
  snipCompact(
    messages: AiMessage[],
    keepLastN: number,
  ): { messages: AiMessage[]; removed: number } {
    if (messages.length <= keepLastN + 1) {
      return { messages, removed: 0 };
    }

    const systemMsgs = messages.filter((m) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

    if (nonSystemMsgs.length <= keepLastN) {
      return { messages, removed: 0 };
    }

    const removed = nonSystemMsgs.length - keepLastN;
    const recentMsgs = nonSystemMsgs.slice(-keepLastN);

    // Build a structural placeholder for removed content
    const snipNotice: AiMessage = {
      role: 'system',
      content: `[Context Snip] ${removed} earlier message(s) removed to save context. ` +
        `Key topics from removed messages: ${this.extractTopics(nonSystemMsgs.slice(0, removed))}`,
    };

    return {
      messages: [...systemMsgs, snipNotice, ...recentMsgs],
      removed,
    };
  }

  /**
   * Layer 3: Compress verbose tool outputs structurally (no LLM call).
   * Examples: long directory listings, large file contents with many
   * repeated lines, etc.
   */
  microcompact(messages: AiMessage[]): AiMessage[] {
    return messages.map((msg) => {
      if (msg.role !== 'tool') return msg;

      const content = msg.content || '';

      // Compress repeated directory listing lines
      // (e.g. "📄 file1.txt\n📄 file2.txt\n..." → summary)
      if (content.match(/^(📁|📄|📄)/m) && content.split('\n').length > 50) {
        const lines = content.split('\n');
        const fileCount = lines.filter((l) => l.includes('📄')).length;
        const dirCount = lines.filter((l) => l.includes('📁')).length;
        return {
          ...msg,
          content: `[Directory listing: ${fileCount} files, ${dirCount} directories]\n` +
            lines.slice(0, 20).join('\n') +
            `\n... ${lines.length - 20} more entries omitted`,
        };
      }

      // Compress files with many repeated blank lines or whitespace
      if (content.length > 10000) {
        const compressed = content.replace(/\n{3,}/g, '\n\n\n');
        if (compressed.length < content.length * 0.8) {
          return {
            ...msg,
            content: compressed + `\n\n[... whitespace compacted, ${content.length - compressed.length} chars saved]`,
          };
        }
      }

      return msg;
    });
  }

  /**
   * Layer 4: LLM-driven auto-compact. Generates a summary of older
   * messages, replacing them with the summary. Uses a lightweight model
   * if configured, otherwise falls back to a structural summary.
   */
  async autoCompact(
    messages: AiMessage[],
    opts: { maxTokens: number; keepLastN: number; onCompact?: (s: string, n: number) => void },
  ): Promise<{ messages: AiMessage[]; summary: string; compactedCount: number }> {
    const systemMsgs = messages.filter((m) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
    const keepN = Math.min(opts.keepLastN, nonSystemMsgs.length);
    const oldMsgs = nonSystemMsgs.slice(0, -keepN);
    const recentMsgs = nonSystemMsgs.slice(-keepN);

    if (oldMsgs.length === 0) {
      return { messages, summary: '', compactedCount: 0 };
    }

    let summary: string;

    if (this.provider) {
      // LLM-driven summary
      try {
        const summaryContent = oldMsgs
          .map((m) => `[${m.role}]: ${(m.content || '').slice(0, 500)}`)
          .join('\n');

        const response = await this.provider.chat({
          model: this.compactModel || '',
          messages: [
            {
              role: 'user',
              content:
                `Please compress the following conversation history into a concise summary.\n` +
                `Preserve:\n1. Decisions made\n2. File operations committed\n` +
                `3. Confirmed facts\n4. Unresolved questions\n\n` +
                `Conversation:\n${summaryContent}`,
            },
          ],
        });
        summary = response.message.content || '';
      } catch {
        // LLM call failed — fall back to structural summary
        summary = this.structuralSummary(oldMsgs);
      }
    } else {
      // No provider — structural summary only
      summary = this.structuralSummary(oldMsgs);
    }

    const summaryMsg: AiMessage = {
      role: 'system',
      content: `[Conversation Summary]\n${summary}`,
    };

    opts.onCompact?.(summary, oldMsgs.length);

    return {
      messages: [...systemMsgs, summaryMsg, ...recentMsgs],
      summary,
      compactedCount: oldMsgs.length,
    };
  }

  /**
   * Extract a brief topic list from removed messages (for snip notice).
   */
  private extractTopics(messages: AiMessage[]): string {
    const userMsgs = messages.filter((m) => m.role === 'user');
    return userMsgs
      .map((m) => (m.content || '').slice(0, 80))
      .filter(Boolean)
      .slice(0, 5)
      .join(' | ');
  }

  /**
   * Build a structural summary without an LLM call.
   * Used as a fallback when no provider is available.
   */
  private structuralSummary(messages: AiMessage[]): string {
    const userMsgs = messages.filter((m) => m.role === 'user');
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');

    const parts: string[] = [];
    parts.push(`User asked ${userMsgs.length} question(s).`);
    if (toolMsgs.length > 0) {
      parts.push(`${toolMsgs.length} tool call(s) were made.`);
    }
    if (assistantMsgs.length > 0) {
      parts.push(`${assistantMsgs.length} response(s) were given.`);
    }

    // Include first user message as context
    if (userMsgs.length > 0) {
      parts.push(`First question: "${(userMsgs[0].content || '').slice(0, 200)}"`);
    }

    return parts.join(' ');
  }
}

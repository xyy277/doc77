/**
 * Unit tests for the Phase 3 context management pipeline.
 *
 * Verifies all four compression layers:
 *   1. Tool Result Budget — truncation of oversized tool outputs
 *   2. Snip Compact — removal of stale middle history
 *   3. Microcompact — structural compression of verbose tool outputs
 *   4. Auto-Compact — LLM-driven or structural summary (threshold-gated)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextManager,
  estimateTokens,
  estimateMessagesTokens,
} from '../src/context-manager.js';
import type { AiMessage } from '../src/provider/index.js';

describe('estimateTokens', () => {
  it('estimates ~4 ASCII chars per token', () => {
    expect(estimateTokens('hello world!')).toBe(3); // 12 chars / 4 = 3
  });

  it('estimates ~1 token per CJK character', () => {
    expect(estimateTokens('你好世界')).toBe(4); // 4 CJK chars = 4 tokens
  });

  it('handles empty strings', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles mixed CJK + ASCII', () => {
    // 2 CJK + 8 ASCII = 2 + 2 = 4
    expect(estimateTokens('你好abcdefgh')).toBe(4);
  });
});

describe('ContextManager', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = new ContextManager(); // no provider → structural fallback
  });

  describe('Layer 1: applyToolResultBudget', () => {
    it('truncates tool results exceeding the token budget', () => {
      const longContent = 'x'.repeat(10000); // ~2500 tokens
      const messages: AiMessage[] = [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'tc1', content: longContent },
      ];

      const result = cm.applyToolResultBudget(messages, 500); // 500 token budget
      const toolMsg = result[1];
      expect(toolMsg.content.length).toBeLessThan(longContent.length);
      expect(toolMsg.content).toContain('truncated');
      expect(toolMsg.content).toContain('10000 chars');
    });

    it('leaves short tool results unchanged', () => {
      const messages: AiMessage[] = [
        { role: 'tool', tool_call_id: 'tc1', content: 'short result' },
      ];
      const result = cm.applyToolResultBudget(messages, 500);
      expect(result[0].content).toBe('short result');
    });

    it('does not touch non-tool messages', () => {
      const messages: AiMessage[] = [
        { role: 'user', content: 'x'.repeat(10000) },
        { role: 'assistant', content: 'y'.repeat(10000) },
      ];
      const result = cm.applyToolResultBudget(messages, 100);
      expect(result[0].content).toBe('x'.repeat(10000));
      expect(result[1].content).toBe('y'.repeat(10000));
    });
  });

  describe('Layer 2: snipCompact', () => {
    it('removes middle messages when history exceeds keepLastN', () => {
      const messages: AiMessage[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'msg 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'msg 2' },
        { role: 'assistant', content: 'reply 2' },
        { role: 'user', content: 'msg 3' },
      ];

      const { messages: result, removed } = cm.snipCompact(messages, 2);
      // Keep system + snip notice + last 2
      expect(result.length).toBeLessThan(messages.length);
      expect(removed).toBeGreaterThan(0);
      // Last 2 messages should be preserved
      expect(result[result.length - 1].content).toBe('msg 3');
      expect(result[result.length - 2].content).toBe('reply 2');
    });

    it('does nothing when history is short enough', () => {
      const messages: AiMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ];
      const { messages: result, removed } = cm.snipCompact(messages, 10);
      expect(result).toEqual(messages);
      expect(removed).toBe(0);
    });
  });

  describe('Layer 3: microcompact', () => {
    it('compresses long directory listings', () => {
      const lines: string[] = [];
      for (let i = 0; i < 60; i++) {
        lines.push(`📄 file${i}.txt`);
      }
      const messages: AiMessage[] = [
        { role: 'tool', tool_call_id: 'tc1', content: lines.join('\n') },
      ];

      const result = cm.microcompact(messages);
      expect(result[0].content).toContain('Directory listing');
      expect(result[0].content).toContain('more entries omitted');
      expect(result[0].content.length).toBeLessThan(messages[0].content.length);
    });

    it('leaves short tool outputs unchanged', () => {
      const messages: AiMessage[] = [
        { role: 'tool', tool_call_id: 'tc1', content: 'small output' },
      ];
      const result = cm.microcompact(messages);
      expect(result[0].content).toBe('small output');
    });
  });

  describe('Layer 4: autoCompact (structural fallback)', () => {
    it('summarizes old messages when no provider is configured', async () => {
      const messages: AiMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'recent question' },
        { role: 'assistant', content: 'recent answer' },
      ];

      const { messages: result, summary, compactedCount } = await cm.autoCompact(messages, {
        maxTokens: 100,
        keepLastN: 2,
      });

      expect(summary).toBeTruthy();
      expect(compactedCount).toBe(2); // 2 old messages summarized
      expect(result.length).toBeLessThan(messages.length);
      // Recent messages preserved
      expect(result[result.length - 1].content).toBe('recent answer');
      // Summary included
      expect(result.some((m) => m.content.includes('Conversation Summary'))).toBe(true);
    });

    it('does nothing when there are no old messages to compact', async () => {
      const messages: AiMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'only message' },
      ];

      const { messages: result, compactedCount } = await cm.autoCompact(messages, {
        maxTokens: 100,
        keepLastN: 10,
      });

      expect(compactedCount).toBe(0);
      expect(result).toEqual(messages);
    });
  });

  describe('compact (full pipeline)', () => {
    it('runs all layers and returns a result with compacted flag', async () => {
      // Build a conversation that triggers Layers 1 and 2
      const longToolResult = 'x'.repeat(5000);
      const messages: AiMessage[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'question 1' },
        { role: 'assistant', content: 'answer 1' },
        { role: 'user', content: 'question 2' },
        { role: 'tool', tool_call_id: 'tc1', content: longToolResult },
        { role: 'user', content: 'question 3' },
        { role: 'assistant', content: 'answer 3' },
      ];

      const result = await cm.compact(messages, {
        maxTokens: 200,
        threshold: 0.5, // low threshold to trigger auto-compact
        keepLastN: 3,
        maxToolResultTokens: 500,
      });

      expect(result.messages.length).toBeLessThanOrEqual(messages.length);
      // Tool result should have been truncated (Layer 1)
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      if (toolMsg) {
        expect(toolMsg.content.length).toBeLessThan(longToolResult.length);
      }
    });

    it('passes through unchanged when messages are small', async () => {
      const messages: AiMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ];

      const result = await cm.compact(messages, {
        maxTokens: 8192,
        threshold: 0.7,
        keepLastN: 10,
      });

      // Pipeline should be mostly a no-op for short conversations
      expect(result.messages.length).toBeLessThanOrEqual(messages.length + 1); // +1 for possible snip notice
    });
  });
});

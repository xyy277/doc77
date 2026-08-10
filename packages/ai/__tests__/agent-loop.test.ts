/**
 * Unit tests for the AgentLoop (Phase 3 five-layer harness).
 *
 * Uses a mock AiProvider to test the loop without a real LLM:
 *   - Basic single-turn (no tools)
 *   - Tool call → result → final answer (ReAct loop)
 *   - Error recovery (provider error)
 *   - User interrupt (cancel)
 *   - Persistence (mock adapter verifies message writes)
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop, createPersistenceAdapter, type PersistenceAdapter } from '../src/agent/loop.js';
import type { AiProvider, AiMessage, StreamChunk, ToolDefinition } from '../src/provider/index.js';

/**
 * Mock provider that plays back a scripted sequence of stream chunks.
 * Each "turn" is an array of StreamChunks that will be yielded in order.
 */
class MockProvider {
  private turns: StreamChunk[][] = [];
  private callIndex = 0;

  /** Script the next response from the LLM. */
  script(chunks: StreamChunk[]): void {
    this.turns.push(chunks);
  }

  async *chatStream(): AsyncGenerator<StreamChunk> {
    const chunks = this.turns[this.callIndex] || [{ type: 'done' }];
    this.callIndex++;
    for (const chunk of chunks) {
      // Yield asynchronously to allow interrupt checks between chunks
      await new Promise((r) => setTimeout(r, 1));
      yield chunk;
    }
  }

  get callCount(): number {
    return this.callIndex;
  }
}

/** Build a PersistenceAdapter mock that records all calls. */
function makeMockPersistence(): {
  adapter: PersistenceAdapter;
  calls: { method: string; args: unknown }[];
} {
  const calls: { method: string; args: unknown }[] = [];
  const leafMap = new Map<string, string>();
  let msgCounter = 0;

  const adapter: PersistenceAdapter = {
    appendMessage(sessionId, msg) {
      const id = `msg-${++msgCounter}`;
      calls.push({ method: 'appendMessage', args: { sessionId, msg, id } });
      leafMap.set(sessionId, id);
      return id;
    },
    getCurrentLeafId(sessionId) {
      return leafMap.get(sessionId) ?? null;
    },
    getMessagePath() {
      return [];
    },
    addTokenUsage(sessionId, input, output) {
      calls.push({ method: 'addTokenUsage', args: { sessionId, input, output } });
    },
    logToolCall(entry) {
      calls.push({ method: 'logToolCall', args: entry });
      return 0;
    },
  };

  return { adapter, calls };
}

const mockTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files',
      parameters: { type: 'object', properties: { dir_path: { type: 'string' } } },
    },
  },
];

describe('AgentLoop', () => {
  it('completes a simple single-turn conversation (no tools)', async () => {
    const provider = new MockProvider();
    provider.script([
      { type: 'token', content: 'Hello' },
      { type: 'token', content: '!' },
      { type: 'done', usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]);

    const { adapter, calls } = makeMockPersistence();
    const loop = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test-model',
      tools: mockTools,
      executeTool: async () => 'ok',
      systemPrompt: 'You are a test bot.',
      persistence: adapter,
    });

    const events = [];
    for await (const event of loop.run('session-1', 'Hi')) {
      events.push(event);
    }

    // Should emit session, tokens, done
    expect(events.find((e) => e.type === 'session')).toBeTruthy();
    expect(events.filter((e) => e.type === 'token')).toHaveLength(2);
    expect(events.find((e) => e.type === 'done')).toBeTruthy();

    // Should persist user message + assistant message
    const appendCalls = calls.filter((c) => c.method === 'appendMessage');
    expect(appendCalls).toHaveLength(2);
    expect((appendCalls[0].args as { msg: { role: string } }).msg.role).toBe('user');
    expect((appendCalls[1].args as { msg: { role: string } }).msg.role).toBe('assistant');

    // Should track token usage
    const tokenCalls = calls.filter((c) => c.method === 'addTokenUsage');
    expect(tokenCalls).toHaveLength(1);
  });

  it('runs a ReAct loop: tool call → result → final answer', async () => {
    const provider = new MockProvider();
    // Turn 1: LLM requests a tool call
    provider.script([
      { type: 'tool_call_start', name: 'list_files' },
      { type: 'tool_call', id: 'tc1', name: 'list_files', arguments: '{"dir_path":"/"}' },
      { type: 'done', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    // Turn 2: LLM sees tool result and gives final answer
    provider.script([
      { type: 'token', content: 'Found 3 files.' },
      { type: 'done', usage: { prompt_tokens: 20, completion_tokens: 3 } },
    ]);

    const executeTool = vi.fn().mockResolvedValue('file1.txt\nfile2.txt\nfile3.txt');
    const { adapter, calls } = makeMockPersistence();
    const loop = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test-model',
      tools: mockTools,
      executeTool,
      persistence: adapter,
      maxSteps: 5,
    });

    const events = [];
    for await (const event of loop.run('session-1', 'List files')) {
      events.push(event);
    }

    // Tool should have been executed
    expect(executeTool).toHaveBeenCalledWith('list_files', { dir_path: '/' });

    // Should emit tool_call + tool_result events
    expect(events.find((e) => e.type === 'tool_call')).toBeTruthy();
    expect(events.find((e) => e.type === 'tool_result')).toBeTruthy();

    // Should persist: user, assistant (with tool_calls), tool result, final assistant
    const appendCalls = calls.filter((c) => c.method === 'appendMessage');
    const roles = appendCalls.map((c) => (c.args as { msg: { role: string } }).msg.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);

    // Tool call should be logged
    const logCalls = calls.filter((c) => c.method === 'logToolCall');
    expect(logCalls).toHaveLength(1);
    expect((logCalls[0].args as { toolName: string }).toolName).toBe('list_files');
  });

  it('recovers from provider stream errors', async () => {
    const provider = new MockProvider();
    provider.script([
      { type: 'token', content: 'partial' },
      { type: 'error', message: 'API connection lost' },
    ]);

    const { adapter, calls } = makeMockPersistence();
    const loop = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test-model',
      tools: [],
      executeTool: async () => 'ok',
      persistence: adapter,
    });

    const events = [];
    for await (const event of loop.run('session-1', 'Hi')) {
      events.push(event);
    }

    // Should emit the error event
    expect(events.find((e) => e.type === 'error')).toBeTruthy();
    expect((events.find((e) => e.type === 'error') as { message: string }).message).toContain(
      'API connection lost',
    );

    // Should persist partial assistant content with error finish reason
    const appendCalls = calls.filter((c) => c.method === 'appendMessage');
    const assistantCall = appendCalls.find(
      (c) => (c.args as { msg: { role: string } }).msg.role === 'assistant',
    );
    expect(assistantCall).toBeTruthy();
    expect((assistantCall!.args as { msg: { finishReason: string } }).msg.finishReason).toBe(
      'error',
    );
  });

  it('respects maxSteps limit', async () => {
    const provider = new MockProvider();
    // LLM always requests a tool call, never gives a final answer
    for (let i = 0; i < 10; i++) {
      provider.script([
        { type: 'tool_call', id: `tc${i}`, name: 'list_files', arguments: '{}' },
        { type: 'done', usage: { prompt_tokens: 5, completion_tokens: 1 } },
      ]);
    }

    const { adapter } = makeMockPersistence();
    const loop = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test-model',
      tools: mockTools,
      executeTool: async () => 'result',
      persistence: adapter,
      maxSteps: 3,
    });

    const events = [];
    for await (const event of loop.run('session-1', 'loop')) {
      events.push(event);
    }

    // Should stop after 3 steps (3 tool calls, 3 tool results)
    const toolCallEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(3);
    expect(provider.callCount).toBe(3);
  });

  it('handles user cancel interrupt', async () => {
    const provider = new MockProvider();
    // Script a long response with many tokens
    const chunks: StreamChunk[] = [];
    for (let i = 0; i < 100; i++) {
      chunks.push({ type: 'token', content: `word${i} ` });
    }
    chunks.push({ type: 'done', usage: { prompt_tokens: 10, completion_tokens: 100 } });
    provider.script(chunks);

    const { adapter } = makeMockPersistence();
    const loop = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test-model',
      tools: [],
      executeTool: async () => 'ok',
      persistence: adapter,
    });

    const events = [];
    // Cancel after collecting a few tokens
    let tokenCount = 0;
    for await (const event of loop.run('session-1', 'generate')) {
      events.push(event);
      if (event.type === 'token') {
        tokenCount++;
        if (tokenCount === 5) {
          loop.interrupts.cancel();
        }
      }
    }

    // Should stop early — not all 100 tokens
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.length).toBeLessThan(100);

    // Should emit an error event with cancel message
    expect(events.find((e) => e.type === 'error')).toBeTruthy();
  });

  it('runs stateless when no persistence adapter is provided', async () => {
    const provider = new MockProvider();
    provider.script([
      { type: 'token', content: 'hi' },
      { type: 'done', usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ]);

    const loop = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test-model',
      tools: [],
      executeTool: async () => 'ok',
      // No persistence adapter
    });

    const events = [];
    for await (const event of loop.run('session-1', 'hello')) {
      events.push(event);
    }

    // Should still work — just without DB persistence
    expect(events.find((e) => e.type === 'token')).toBeTruthy();
    expect(events.find((e) => e.type === 'done')).toBeTruthy();
  });
});

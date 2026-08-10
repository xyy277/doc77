/**
 * Unit tests for StreamingToolExecutor and InterruptQueue (Phase 3).
 */
import { describe, it, expect, vi } from 'vitest';
import { StreamingToolExecutor } from '../src/streaming-executor.js';
import { InterruptQueue } from '../src/interrupt-queue.js';

// ── StreamingToolExecutor ──────────────────────────────────

describe('StreamingToolExecutor', () => {
  it('executes enqueued tool calls and yields results', async () => {
    const executor = new StreamingToolExecutor(async (name, args) => {
      return `${name}:${JSON.stringify(args)}`;
    });

    executor.enqueue({ id: 'tc1', name: 'list_files', argsStr: '{"dir_path":"/"}' });
    executor.seal();

    const results = [];
    for await (const r of executor.results()) {
      results.push(r);
    }

    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe('tc1');
    expect(results[0].toolName).toBe('list_files');
    expect(results[0].success).toBe(true);
    expect(results[0].output).toContain('list_files');
  });

  it('handles tool execution errors gracefully', async () => {
    const executor = new StreamingToolExecutor(async () => {
      throw new Error('Tool exploded');
    });

    executor.enqueue({ id: 'tc1', name: 'read_file', argsStr: '{}' });
    executor.seal();

    const results = [];
    for await (const r of executor.results()) {
      results.push(r);
    }

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].output).toContain('Tool exploded');
    expect(results[0].errorMessage).toBe('Tool exploded');
  });

  it('handles invalid JSON arguments', async () => {
    const executor = new StreamingToolExecutor(async (name) => `ok:${name}`);

    executor.enqueue({ id: 'tc1', name: 'list_files', argsStr: 'not valid json' });
    executor.seal();

    const results = [];
    for await (const r of executor.results()) {
      results.push(r);
    }

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('executes multiple read-only tools concurrently', async () => {
    const executionOrder: string[] = [];
    const executor = new StreamingToolExecutor(
      async (name) => {
        executionOrder.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push(`end:${name}`);
        return `done:${name}`;
      },
      { maxConcurrency: 3 },
    );

    executor.enqueue({ id: 'tc1', name: 'list_files', argsStr: '{}' });
    executor.enqueue({ id: 'tc2', name: 'read_file', argsStr: '{}' });
    executor.enqueue({ id: 'tc3', name: 'search_files', argsStr: '{}' });
    executor.seal();

    const results = [];
    for await (const r of executor.results()) {
      results.push(r);
    }

    expect(results).toHaveLength(3);
    // All three read-only tools should start before any finishes (concurrent)
    expect(executionOrder.slice(0, 3).every((s) => s.startsWith('start'))).toBe(true);
  });

  it('serializes write tools (one at a time)', async () => {
    const executionOrder: string[] = [];
    const executor = new StreamingToolExecutor(
      async (name) => {
        executionOrder.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 30));
        executionOrder.push(`end:${name}`);
        return `done:${name}`;
      },
      { maxConcurrency: 3 },
    );

    // Two write tools — should NOT run concurrently
    executor.enqueue({ id: 'tc1', name: 'write_file', argsStr: '{}' });
    executor.enqueue({ id: 'tc2', name: 'delete_file', argsStr: '{}' });
    executor.seal();

    const results = [];
    for await (const r of executor.results()) {
      results.push(r);
    }

    expect(results).toHaveLength(2);
    // First tool must finish before second starts
    expect(executionOrder).toEqual([
      'start:write_file',
      'end:write_file',
      'start:delete_file',
      'end:delete_file',
    ]);
  });

  it('yields results in arrival order', async () => {
    const executor = new StreamingToolExecutor(async (name) => {
      // Make the first tool slower so it finishes after the second
      if (name === 'list_files') await new Promise((r) => setTimeout(r, 80));
      if (name === 'read_file') await new Promise((r) => setTimeout(r, 10));
      return `done:${name}`;
    });

    executor.enqueue({ id: 'tc1', name: 'list_files', argsStr: '{}' });
    executor.enqueue({ id: 'tc2', name: 'read_file', argsStr: '{}' });
    executor.seal();

    const results = [];
    for await (const r of executor.results()) {
      results.push(r);
    }

    // Results should be in arrival order (tc1 first), not completion order
    expect(results[0].toolCallId).toBe('tc1');
    expect(results[1].toolCallId).toBe('tc2');
  });
});

// ── InterruptQueue ─────────────────────────────────────────

describe('InterruptQueue', () => {
  it('enqueues and dequeues cancel signals', () => {
    const queue = new InterruptQueue();
    expect(queue.size).toBe(0);

    queue.cancel();
    expect(queue.size).toBe(1);
    expect(queue.cancelPending).toBe(true);

    const item = queue.dequeue();
    expect(item?.type).toBe('cancel');
    expect(queue.size).toBe(0);
  });

  it('enqueues inject signals with messages', () => {
    const queue = new InterruptQueue();
    queue.inject('Follow up question');

    const item = queue.dequeue();
    expect(item?.type).toBe('inject');
    expect(item?.message).toBe('Follow up question');
  });

  it('ignores empty inject messages', () => {
    const queue = new InterruptQueue();
    queue.inject('   ');
    expect(queue.size).toBe(0);
  });

  it('drains all pending interrupts', () => {
    const queue = new InterruptQueue();
    queue.cancel();
    queue.inject('msg1');
    queue.inject('msg2');

    const items = queue.drain();
    expect(items).toHaveLength(3);
    expect(queue.size).toBe(0);
  });

  it('peek returns first item without removing', () => {
    const queue = new InterruptQueue();
    queue.cancel();
    queue.inject('msg');

    const peeked = queue.peek();
    expect(peeked?.type).toBe('cancel');
    expect(queue.size).toBe(2); // not removed
  });

  it('clear removes all interrupts', () => {
    const queue = new InterruptQueue();
    queue.cancel();
    queue.inject('msg');
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.cancelPending).toBe(false);
  });
});

/**
 * ToolRouter unit tests — verify the permission gateway logic.
 *
 * These tests cover:
 *   - Permission gate: risk level enforcement (low/medium/high)
 *   - Sensitive file protection (.env, *.key)
 *   - Handler dispatch (read tools, write tools, unknown tools)
 *   - Batch execution: read-concurrent + write-serial ordering
 *   - Error handling: handler exceptions become error results, not throws
 *   - Annotation lookups: isReadOnly, requiresApproval, isDestructive
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ToolRouter,
  TOOL_ANNOTATIONS,
  riskLevelPermits,
  isReadOnlyTool,
  requiresApproval,
  isDestructive,
  classifyBatchOps,
  type ToolHandler,
  type ToolContext,
} from '../src/index.js';

// ── Helpers ──

function makeRouter(
  opts: {
    riskLevel?: 'low' | 'medium' | 'high';
    sensitiveFiles?: Set<string>;
    handlers?: Record<string, ToolHandler>;
  } = {},
) {
  const sensitive = opts.sensitiveFiles ?? new Set(['.env', 'secret.key']);
  const router = new ToolRouter({
    isSensitiveFile: (name: string) => sensitive.has(name),
    getRiskLevel: () => opts.riskLevel ?? 'medium',
  });
  if (opts.handlers) {
    for (const [name, handler] of Object.entries(opts.handlers)) {
      router.register(name, handler);
    }
  }
  return router;
}

const CTX: ToolContext = { projectId: 1, sessionId: 'sess-test' };

// ── Annotation tests ──

describe('Tool annotations', () => {
  it('classifies read tools as read + concurrent', () => {
    expect(TOOL_ANNOTATIONS.list_files.permission).toBe('read');
    expect(TOOL_ANNOTATIONS.list_files.concurrency).toBe('concurrent');
    expect(TOOL_ANNOTATIONS.read_file.permission).toBe('read');
    expect(TOOL_ANNOTATIONS.search_files.concurrency).toBe('concurrent');
  });

  it('classifies write tools as write/destructive + serial', () => {
    expect(TOOL_ANNOTATIONS.write_file.permission).toBe('write');
    expect(TOOL_ANNOTATIONS.write_file.concurrency).toBe('serial');
    expect(TOOL_ANNOTATIONS.delete_file.permission).toBe('destructive');
    expect(TOOL_ANNOTATIONS.delete_file.concurrency).toBe('serial');
  });

  it('riskLevelPermits: high satisfies all, low satisfies only low', () => {
    expect(riskLevelPermits('high', 'high')).toBe(true);
    expect(riskLevelPermits('high', 'low')).toBe(true);
    expect(riskLevelPermits('low', 'high')).toBe(false);
    expect(riskLevelPermits('medium', 'medium')).toBe(true);
    expect(riskLevelPermits('medium', 'high')).toBe(false);
  });

  it('isReadOnlyTool / requiresApproval / isDestructive', () => {
    expect(isReadOnlyTool('list_files')).toBe(true);
    expect(isReadOnlyTool('write_file')).toBe(false);
    expect(requiresApproval('write_file')).toBe(true);
    expect(requiresApproval('list_files')).toBe(false);
    expect(isDestructive('delete_file')).toBe(true);
    expect(isDestructive('write_file')).toBe(false);
  });

  it('classifyBatchOps: delete_file makes batch destructive', () => {
    expect(classifyBatchOps([{ type: 'move_file' }])).toBe('write');
    expect(classifyBatchOps([{ type: 'delete_file' }])).toBe('destructive');
    expect(classifyBatchOps([{ type: 'create_folder' }, { type: 'delete_file' }])).toBe(
      'destructive',
    );
    expect(classifyBatchOps([])).toBe('write');
  });
});

// ── Permission gate tests ──

describe('ToolRouter permission gate', () => {
  it('denies unknown tools', async () => {
    const router = makeRouter();
    const result = await router.execute('nonexistent_tool', {}, CTX);
    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.denialReason).toBe('unknown_tool');
    expect(result.output).toContain('Unknown tool');
  });

  it('denies write_file at low risk level', async () => {
    const router = makeRouter({
      riskLevel: 'low',
      handlers: {
        write_file: async () => 'should not reach',
      },
    });
    const result = await router.execute(
      'write_file',
      { file_path: 'test.txt', content: 'hi' },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.denialReason).toBe('risk_level');
  });

  it('allows write_file at high risk level', async () => {
    const router = makeRouter({
      riskLevel: 'high',
      handlers: {
        write_file: async () => 'queued: task_123',
      },
    });
    const result = await router.execute(
      'write_file',
      { file_path: 'test.txt', content: 'hi' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.denied).toBe(false);
    expect(result.output).toContain('task_123');
  });

  it('allows create_folder at low risk level', async () => {
    const router = makeRouter({
      riskLevel: 'low',
      handlers: {
        create_folder: async () => 'queued: task_456',
      },
    });
    const result = await router.execute('create_folder', { folder_path: 'newdir' }, CTX);
    expect(result.success).toBe(true);
    expect(result.output).toContain('task_456');
  });

  it('denies delete_file at medium risk level (requires high)', async () => {
    const router = makeRouter({
      riskLevel: 'medium',
      handlers: {
        delete_file: async () => 'should not reach',
      },
    });
    const result = await router.execute('delete_file', { file_path: 'test.txt' }, CTX);
    expect(result.success).toBe(false);
    expect(result.denialReason).toBe('risk_level');
  });

  it('denies operations on sensitive files (.env)', async () => {
    const router = makeRouter({
      riskLevel: 'high',
      handlers: {
        write_file: async () => 'should not reach',
        delete_file: async () => 'should not reach',
      },
    });
    const writeResult = await router.execute(
      'write_file',
      { file_path: '.env', content: 'SECRET=1' },
      CTX,
    );
    expect(writeResult.denied).toBe(true);
    expect(writeResult.denialReason).toBe('sensitive_file');

    const deleteResult = await router.execute(
      'delete_file',
      { file_path: 'config/secret.key' },
      CTX,
    );
    expect(deleteResult.denied).toBe(true);
    expect(deleteResult.denialReason).toBe('sensitive_file');
  });

  it('denies batch_operations containing delete at medium risk', async () => {
    const router = makeRouter({
      riskLevel: 'medium',
      handlers: {
        batch_operations: async () => 'should not reach',
      },
    });
    const result = await router.execute(
      'batch_operations',
      {
        operations: [
          { type: 'create_folder', folder_path: 'a' },
          { type: 'delete_file', file_path: 'b.txt' },
        ],
      },
      CTX,
    );
    // batch with delete_file → effective permission 'destructive' → requires 'high'
    expect(result.denied).toBe(true);
    expect(result.denialReason).toBe('risk_level');
  });

  it('allows batch_operations with only move/create at medium risk', async () => {
    const router = makeRouter({
      riskLevel: 'medium',
      handlers: {
        batch_operations: async () => 'queued: task_789',
      },
    });
    const result = await router.execute(
      'batch_operations',
      {
        operations: [
          { type: 'create_folder', folder_path: 'a' },
          { type: 'move_file', source: 'b', target: 'c' },
        ],
      },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('task_789');
  });
});

// ── Handler dispatch tests ──

describe('ToolRouter handler dispatch', () => {
  it('dispatches to registered read handlers', async () => {
    const router = makeRouter({
      handlers: {
        list_files: async (args) => `listed ${args.dir_path}`,
        read_file: async (args) => `read ${args.file_path}`,
      },
    });
    const listResult = await router.execute('list_files', { dir_path: '/foo' }, CTX);
    expect(listResult.success).toBe(true);
    expect(listResult.output).toBe('listed /foo');
    expect(listResult.permission).toBe('read');

    const readResult = await router.execute('read_file', { file_path: 'bar.txt' }, CTX);
    expect(readResult.output).toBe('read bar.txt');
  });

  it('catches handler errors and returns them as failed results', async () => {
    const router = makeRouter({
      handlers: {
        read_file: async () => {
          throw new Error('disk failure');
        },
      },
    });
    const result = await router.execute('read_file', { file_path: 'x.txt' }, CTX);
    expect(result.success).toBe(false);
    expect(result.denied).toBe(false); // not a permission denial
    expect(result.errorMessage).toBe('disk failure');
    expect(result.output).toContain('disk failure');
  });

  it('returns elapsedMs for every call', async () => {
    const router = makeRouter({
      handlers: {
        list_files: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'done';
        },
      },
    });
    const result = await router.execute('list_files', {}, CTX);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(5);
  });

  it('denies if no handler registered for a known tool', async () => {
    const router = makeRouter(); // no handlers
    const result = await router.execute('list_files', {}, CTX);
    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.denialReason).toBe('unknown_tool');
    expect(result.output).toContain('No handler registered');
  });
});

// ── Batch execution tests ──

describe('ToolRouter executeBatch', () => {
  it('executes read tools concurrently and preserves order', async () => {
    const callOrder: string[] = [];
    const router = makeRouter({
      handlers: {
        list_files: async (args) => {
          callOrder.push(`list:${args.dir_path}`);
          await new Promise((r) => setTimeout(r, 20));
          return `listed ${args.dir_path}`;
        },
        read_file: async (args) => {
          callOrder.push(`read:${args.file_path}`);
          await new Promise((r) => setTimeout(r, 5));
          return `read ${args.file_path}`;
        },
      },
    });

    const calls = [
      { id: '1', name: 'list_files', args: { dir_path: '/a' } },
      { id: '2', name: 'read_file', args: { file_path: 'b.txt' } },
      { id: '3', name: 'list_files', args: { dir_path: '/c' } },
    ];
    const results = await router.executeBatch(calls, CTX);

    expect(results).toHaveLength(3);
    expect(results[0].output).toBe('listed /a');
    expect(results[1].output).toBe('read b.txt');
    expect(results[2].output).toBe('listed /c');
    // All succeeded
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('executes write tools serially in arrival order', async () => {
    const executionOrder: string[] = [];
    const router = makeRouter({
      riskLevel: 'high',
      handlers: {
        write_file: async (args) => {
          executionOrder.push(`write:${args.file_path}`);
          return `wrote ${args.file_path}`;
        },
        create_folder: async (args) => {
          executionOrder.push(`folder:${args.folder_path}`);
          return `created ${args.folder_path}`;
        },
      },
    });

    const calls = [
      { id: '1', name: 'write_file', args: { file_path: 'a.txt', content: '1' } },
      { id: '2', name: 'create_folder', args: { folder_path: 'b' } },
      { id: '3', name: 'write_file', args: { file_path: 'c.txt', content: '3' } },
    ];
    const results = await router.executeBatch(calls, CTX);

    expect(results).toHaveLength(3);
    // Serial execution preserves arrival order
    expect(executionOrder).toEqual(['write:a.txt', 'folder:b', 'write:c.txt']);
  });

  it('mixes read-concurrent and write-serial correctly', async () => {
    const router = makeRouter({
      riskLevel: 'high',
      handlers: {
        list_files: async () => 'listed',
        write_file: async () => 'wrote',
        read_file: async () => 'read',
      },
    });

    const calls = [
      { id: '1', name: 'list_files', args: {} },
      { id: '2', name: 'write_file', args: { file_path: 'a.txt', content: 'x' } },
      { id: '3', name: 'read_file', args: { file_path: 'b.txt' } },
      { id: '4', name: 'write_file', args: { file_path: 'c.txt', content: 'y' } },
    ];
    const results = await router.executeBatch(calls, CTX);

    expect(results).toHaveLength(4);
    expect(results[0].output).toBe('listed');
    expect(results[1].output).toBe('wrote');
    expect(results[2].output).toBe('read');
    expect(results[3].output).toBe('wrote');
  });

  it('handles denials within batch without aborting other calls', async () => {
    const router = makeRouter({
      riskLevel: 'low', // write_file will be denied (requires high)
      handlers: {
        list_files: async () => 'listed',
        write_file: async () => 'should not reach',
      },
    });

    const calls = [
      { id: '1', name: 'list_files', args: {} },
      { id: '2', name: 'write_file', args: { file_path: 'a.txt', content: 'x' } },
      { id: '3', name: 'list_files', args: {} },
    ];
    const results = await router.executeBatch(calls, CTX);

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[1].denied).toBe(true);
    expect(results[2].success).toBe(true);
  });
});

// ── isReadOnly / hasHandler ──

describe('ToolRouter introspection', () => {
  it('isReadOnly reflects annotation', () => {
    const router = makeRouter();
    expect(router.isReadOnly('list_files')).toBe(true);
    expect(router.isReadOnly('write_file')).toBe(false);
    expect(router.isReadOnly('unknown')).toBe(false);
  });

  it('hasHandler tracks registrations', () => {
    const router = makeRouter({
      handlers: { list_files: async () => 'ok' },
    });
    expect(router.hasHandler('list_files')).toBe(true);
    expect(router.hasHandler('read_file')).toBe(false);
  });

  it('getAnnotation returns the annotation', () => {
    const router = makeRouter();
    const ann = router.getAnnotation('delete_file');
    expect(ann).toBeDefined();
    expect(ann!.permission).toBe('destructive');
  });
});

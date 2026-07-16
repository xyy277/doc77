import { describe, it, expect, vi } from 'vitest';
import { isSensitiveFile } from '@doc77/core';
import { executeAiWriteTool, isAiWriteTool } from '../src/server/ai-tools.js';
import { initI18n } from '../src/i18n/index.js';

beforeAll(() => initI18n('zh-CN'));

function makeDeps(riskLevel = 'high') {
  const writeFns = {
    moveFile: vi.fn(async () => ({ task_id: '11' })),
    createFolder: vi.fn(async () => ({ task_id: '12' })),
    deleteFile: vi.fn(async () => ({ task_id: '13' })),
    batchOperations: vi.fn(async () => ({ task_id: '14' })),
  };
  return { writeFns, isSensitiveFile, getRiskLevel: () => riskLevel };
}
const ctx = { projectId: 1, sessionId: 's1' };

describe('isAiWriteTool', () => {
  it('recognizes write tool names, rejects read/unknown', () => {
    expect(isAiWriteTool('move_file')).toBe(true);
    expect(isAiWriteTool('batch_operations')).toBe(true);
    expect(isAiWriteTool('read_file')).toBe(false);
    expect(isAiWriteTool('nope')).toBe(false);
  });
});

describe('executeAiWriteTool', () => {
  it('enqueues move_file and returns a pending-approval message with the task id', async () => {
    const deps = makeDeps('high');
    const res = await executeAiWriteTool(
      'move_file',
      { source: 'a.md', target: 'docs/a.md' },
      ctx,
      deps,
    );
    expect(deps.writeFns.moveFile).toHaveBeenCalledWith(1, 's1', 'a.md', 'docs/a.md');
    expect(res).toContain('11');
    expect(res).toMatch(/审批/);
  });

  it('blocks moving TO a sensitive target before enqueue', async () => {
    const deps = makeDeps('high');
    const res = await executeAiWriteTool(
      'move_file',
      { source: 'a.md', target: '.env' },
      ctx,
      deps,
    );
    expect(deps.writeFns.moveFile).not.toHaveBeenCalled();
    expect(res).toMatch(/敏感|sensitive/i);
  });

  it('gates delete_file at medium risk level (no enqueue)', async () => {
    const deps = makeDeps('medium');
    const res = await executeAiWriteTool('delete_file', { file_path: 'a.md' }, ctx, deps);
    expect(deps.writeFns.deleteFile).not.toHaveBeenCalled();
    expect(res).toMatch(/风险|不允许|risk/i);
  });

  it('allows delete_file at high risk level', async () => {
    const deps = makeDeps('high');
    const res = await executeAiWriteTool('delete_file', { file_path: 'a.md' }, ctx, deps);
    expect(deps.writeFns.deleteFile).toHaveBeenCalledWith(1, 's1', 'a.md');
    expect(res).toContain('13');
  });

  it('allows create_folder even at low risk level', async () => {
    const deps = makeDeps('low');
    const res = await executeAiWriteTool('create_folder', { folder_path: 'archive' }, ctx, deps);
    expect(deps.writeFns.createFolder).toHaveBeenCalledWith(1, 's1', 'archive');
    expect(res).toContain('12');
  });

  it('rejects a batch containing a delete op at medium risk', async () => {
    const deps = makeDeps('medium');
    const res = await executeAiWriteTool(
      'batch_operations',
      { operations: [{ type: 'delete_file', file_path: 'a.md' }] },
      ctx,
      deps,
    );
    expect(deps.writeFns.batchOperations).not.toHaveBeenCalled();
    expect(res).toMatch(/风险|不允许|risk/i);
  });

  it('enqueues a valid batch and returns the task id', async () => {
    const deps = makeDeps('high');
    const ops = [
      { type: 'create_folder', folder_path: 'archive' },
      { type: 'move_file', source: 'a.md', target: 'archive/a.md' },
    ];
    const res = await executeAiWriteTool('batch_operations', { operations: ops }, ctx, deps);
    expect(deps.writeFns.batchOperations).toHaveBeenCalledWith(1, 's1', ops);
    expect(res).toContain('14');
  });
});

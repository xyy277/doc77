import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createEventsHandler } from '../src/server/events.js';
import { getEventBus, resetEventBus } from '../src/server/event-bus.js';

function mockRes() {
  return { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
}

describe('createEventsHandler (task lifecycle SSE)', () => {
  it('streams task:executed as SSE and cleans up listeners on close', () => {
    const bus = new EventEmitter();
    const handler = createEventsHandler(bus);
    const req = new EventEmitter() as never;
    const res = mockRes();
    handler(req, res as never);

    expect(res.writeHead).toHaveBeenCalled();
    bus.emit('task:executed', { task_id: '7', project_id: 1, result: 'ok' });
    const written = res.write.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('event: task:executed');
    expect(written).toContain('"task_id":"7"');

    expect(bus.listenerCount('task:executed')).toBe(1);
    (req as unknown as EventEmitter).emit('close');
    expect(bus.listenerCount('task:executed')).toBe(0);
  });

  it('also forwards task:failed', () => {
    const bus = new EventEmitter();
    const handler = createEventsHandler(bus);
    const req = new EventEmitter() as never;
    const res = mockRes();
    handler(req, res as never);

    bus.emit('task:failed', {
      task_id: '9',
      project_id: 1,
      error_message: 'boom',
      rolled_back: true,
    });
    const written = res.write.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('event: task:failed');
    expect(written).toContain('boom');
  });

  it('forwards file-tree:changed with paths payload', () => {
    const bus = new EventEmitter();
    const handler = createEventsHandler(bus);
    const req = new EventEmitter() as never;
    const res = mockRes();
    handler(req, res as never);

    bus.emit('file-tree:changed', {
      projectId: 1,
      path: 'docs',
      opType: 'create',
      paths: ['docs/api.md'],
    });
    const written = res.write.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('event: file-tree:changed');
    expect(written).toContain('"opType":"create"');
    expect(written).toContain('docs/api.md');
  });

  it('无参调用默认使用 core 共享事件总线（globalThis 单例）', () => {
    resetEventBus();
    const handler = createEventsHandler();
    const req = new EventEmitter() as never;
    const res = mockRes();
    handler(req, res as never);

    getEventBus().emit('file-tree:changed', {
      projectId: 7,
      path: '',
      opType: 'delete',
      paths: ['gone.md'],
    });
    const written = res.write.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('event: file-tree:changed');
    expect(written).toContain('"projectId":7');

    (req as unknown as EventEmitter).emit('close');
    resetEventBus();
  });
});

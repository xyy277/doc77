import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createEventsHandler } from '../src/server/events.js';

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
});

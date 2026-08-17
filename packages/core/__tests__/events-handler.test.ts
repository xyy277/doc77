import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createEventsHandler } from '../src/server/events.js';
import { getEventBus, resetEventBus } from '../src/server/event-bus.js';

function mockRes() {
  return { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
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

describe('createEventsHandler 心跳与死连接收割（bfcache 防御层）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(heartbeatMs = 30_000) {
    const bus = new EventEmitter();
    const handler = createEventsHandler(bus, { heartbeatMs });
    const req = new EventEmitter() as never;
    const res = mockRes();
    handler(req, res as never);
    return { bus, req, res };
  }

  it('心跳周期写入 ping（30s 两次）', () => {
    vi.useFakeTimers();
    const { res } = setup(30_000);
    expect(res.write.mock.calls.some((c) => c[0] === ': connected\n\n')).toBe(true);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    const pings = res.write.mock.calls.filter((c) => c[0] === ': ping\n\n');
    expect(pings).toHaveLength(2);
  });

  it('write 回调错误 → 收割：监听器全移除 + res.end + destroy', () => {
    vi.useFakeTimers();
    const { bus, req, res } = setup(1_000);
    // ping write 回调报错（socket 已死）
    res.write.mockImplementation((chunk: string, cb?: (err?: Error) => void) => {
      if (chunk === ': ping\n\n' && cb) cb(new Error('EPIPE'));
    });
    vi.advanceTimersByTime(1_000);
    // 4 个事件监听器全部移除
    for (const ev of [
      'task:executed',
      'task:failed',
      'file-tree:changed',
      'graph:index-progress',
    ]) {
      expect(bus.listenerCount(ev)).toBe(0);
    }
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.destroy).toHaveBeenCalledTimes(1);
    // interval 已清：再 advance 无新 ping
    const before = res.write.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    expect(res.write.mock.calls.length).toBe(before);
    // req close 路径与收割共用清理：触发后无二次 end
    (req as unknown as EventEmitter).emit('close');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('write 同步抛错 → 收割（write-after-end 场景）', () => {
    vi.useFakeTimers();
    const { bus, res } = setup(1_000);
    res.write.mockImplementation(() => {
      throw new Error('write after end');
    });
    vi.advanceTimersByTime(1_000);
    for (const ev of ['task:executed', 'file-tree:changed']) {
      expect(bus.listenerCount(ev)).toBe(0);
    }
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('事件 payload write 失败 → 收割', () => {
    const { bus, res } = setup(60_000);
    res.write.mockImplementation((chunk: string, cb?: (err?: Error) => void) => {
      if (typeof chunk === 'string' && chunk.includes('task:executed') && cb)
        cb(new Error('EPIPE'));
    });
    bus.emit('task:executed', { task_id: '1' });
    expect(bus.listenerCount('task:executed')).toBe(0);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('清理后 bus.emit 不再写入（listener 已移除）', () => {
    const { bus, req, res } = setup(60_000);
    (req as unknown as EventEmitter).emit('close');
    const before = res.write.mock.calls.length;
    bus.emit('file-tree:changed', { projectId: 1, path: '', opType: 'create', paths: [] });
    expect(res.write.mock.calls.length).toBe(before);
  });
});

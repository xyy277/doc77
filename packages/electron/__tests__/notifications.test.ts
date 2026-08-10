import { describe, it, expect, vi, beforeAll } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildNotification,
  NotificationSubscriber,
  showNotification,
  type NotificationDispatcher,
  type NotificationOptions,
  type EventBus,
} from '../src/notifications.js';
import { bindCoreT } from '../src/i18n.js';
import { initI18n, t as coreT } from '@doc77/core';

/**
 * notifications.ts 的文案经 electron t() shim 走 @doc77/core 词条。
 * 这里绑定真实 core t + zh-CN 词条，断言中文文案（真实代码路径）。
 */
beforeAll(() => {
  initI18n('zh-CN');
  bindCoreT(coreT);
});

/**
 * buildNotification 纯函数测试 —— 不依赖 Electron API。
 */
describe('buildNotification', () => {
  it('task:approved 返回审批通过文案', () => {
    const r = buildNotification('task:approved', { task_id: '42' });
    expect(r).not.toBeNull();
    expect(r?.title).toBe('审批通过');
    expect(r?.body).toContain('42');
    expect(r?.clickAction).toBe('queue');
  });

  it('task:executed 返回执行完成文案', () => {
    const r = buildNotification('task:executed', { task_id: '7' });
    expect(r?.title).toBe('任务执行完成');
    expect(r?.body).toContain('7');
  });

  it('task:failed 返回失败文案，包含错误信息', () => {
    const r = buildNotification('task:failed', {
      task_id: '9',
      error_message: 'disk full',
    });
    expect(r?.title).toBe('任务执行失败');
    expect(r?.body).toContain('9');
    expect(r?.body).toContain('disk full');
  });

  it('task:failed 无 error_message 字段时使用"未知错误"', () => {
    const r = buildNotification('task:failed', { task_id: '1' });
    expect(r?.body).toContain('未知错误');
  });

  it('file-tree:changed 返回 null（不弹通知）', () => {
    const r = buildNotification('file-tree:changed', { path: '/x' });
    expect(r).toBeNull();
  });

  it('payload 为 null/undefined 时不崩溃，task_id 为空字符串', () => {
    const r = buildNotification('task:executed', null);
    expect(r?.body).toContain('#'); // task_id 空字符串 → "任务 #"
  });
});

/**
 * NotificationSubscriber 订阅器测试 —— 用 mock dispatcher + EventEmitter 模拟事件总线。
 */
describe('NotificationSubscriber', () => {
  function createMockDispatcher(): {
    dispatcher: NotificationDispatcher;
    calls: NotificationOptions[];
  } {
    const calls: NotificationOptions[] = [];
    return {
      dispatcher: {
        show(options: NotificationOptions) {
          calls.push(options);
        },
      },
      calls,
    };
  }

  it('attachEventBus 订阅 task:approved → dispatcher.show 被调用', () => {
    const { dispatcher, calls } = createMockDispatcher();
    const sub = new NotificationSubscriber(dispatcher);
    const bus: EventBus = new EventEmitter();

    sub.attachEventBus(bus);
    bus.emit('task:approved', { task_id: '5' });

    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('审批通过');
    expect(calls[0].body).toContain('5');
  });

  it('file-tree:changed 事件不触发 dispatcher.show（被 buildNotification 过滤）', () => {
    const { dispatcher, calls } = createMockDispatcher();
    const sub = new NotificationSubscriber(dispatcher);
    const bus: EventBus = new EventEmitter();

    sub.attachEventBus(bus);
    bus.emit('file-tree:changed', { path: '/foo' });

    expect(calls).toHaveLength(0);
  });

  it('detachEventBus 后不再收到事件', () => {
    const { dispatcher, calls } = createMockDispatcher();
    const sub = new NotificationSubscriber(dispatcher);
    const bus: EventBus = new EventEmitter();

    sub.attachEventBus(bus);
    bus.emit('task:executed', { task_id: '1' });
    expect(calls).toHaveLength(1);

    sub.detachEventBus();
    bus.emit('task:executed', { task_id: '2' });
    expect(calls).toHaveLength(1); // 仍是 1，detach 后不再收
  });

  it('重复 attach 先 detach 旧订阅，避免 listener 泄漏', () => {
    const { dispatcher } = createMockDispatcher();
    const sub = new NotificationSubscriber(dispatcher);
    const bus: EventEmitter = new EventEmitter();

    sub.attachEventBus(bus);
    const before = bus.listenerCount('task:executed');
    expect(before).toBe(1);

    // 再次 attach 应先 detach，listener 数量不增加
    sub.attachEventBus(bus);
    expect(bus.listenerCount('task:executed')).toBe(1);
  });
});

/**
 * showNotification 便捷封装测试。
 */
describe('showNotification', () => {
  it('调用 dispatcher.show 一次', () => {
    const calls: NotificationOptions[] = [];
    const dispatcher: NotificationDispatcher = {
      show: (o) => calls.push(o),
    };
    showNotification(dispatcher, { title: 'T', body: 'B' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ title: 'T', body: 'B' });
  });
});

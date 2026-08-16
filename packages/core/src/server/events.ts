import type { Request, Response } from 'express';
import { getEventBus } from './event-bus.js';

/**
 * Server→client push channel for write-task lifecycle and file-tree events.
 *
 * The AI chat request is short-lived, but a write task is executed later (after
 * the user approves it in the Queue tab). This SSE endpoint lets the client
 * learn the outcome asynchronously: the MCP transactional executor emits
 * task:executed / task:failed on the shared event bus, and we relay them to any
 * connected browser so the UI can report completion. Since v1.1.2 the
 * file watcher also emits file-tree:changed here (external edits / git /
 * webdav sync), driving incremental tree refreshes.
 *
 * 事件总线自 v1.1.2 起由 core 提供 globalThis 单例（见 event-bus.ts），
 * 无参调用即使用共享总线；测试仍可注入独立 EventEmitter。
 */
interface MinimalBus {
  on(event: string, listener: (payload: unknown) => void): void;
  off(event: string, listener: (payload: unknown) => void): void;
}

const FORWARDED_EVENTS = [
  'task:executed',
  'task:failed',
  'file-tree:changed',
  'graph:index-progress',
] as const;

export function createEventsHandler(bus: MinimalBus = getEventBus()) {
  return (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const listeners: Array<[string, (payload: unknown) => void]> = [];
    for (const event of FORWARDED_EVENTS) {
      const listener = (payload: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      bus.on(event, listener);
      listeners.push([event, listener]);
    }

    req.on('close', () => {
      for (const [event, listener] of listeners) bus.off(event, listener);
      res.end();
    });
  };
}

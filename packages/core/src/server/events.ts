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
 *
 * v1.2.1 红队/bfcache 修复：
 * - 心跳 ping（默认 30s，unref）：抵消 NAT/代理空闲超时；write 报错即收割
 * - 幂等 cleanup()：bus.off + clearInterval + res.end，req close 与心跳
 *   失败路径共用（双清被 cleaned 标志挡住）
 * - 收割（fail()）：cleanup + res.destroy()，保证 app.ts 路由层
 *   req.on('close') → releaseWatcherRef 必然触发
 * - 注意：bfcache 冻结的连接 TCP 层仍"活着"（write 成功），心跳无法识别
 *   bfcache 僵尸——那是前端 pagehide 关闭连接的根治范围；此处收割的是
 *   浏览器真正关闭/驱逐的连接（下一次 write 立即报错）
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

const HEARTBEAT_MS = 30_000;

export function createEventsHandler(
  bus: MinimalBus = getEventBus(),
  opts: { heartbeatMs?: number } = {},
) {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  return (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const listeners: Array<[string, (payload: unknown) => void]> = [];
    let cleaned = false;
    let heartbeat: NodeJS.Timeout | null = null;

    // 幂等清理：req close（客户端断开）与 fail（write 失败）共用；
    // 双清被 cleaned 标志挡住
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      for (const [event, listener] of listeners) bus.off(event, listener);
      res.end();
    };

    // 收割：write 失败 → 清理 + 强制断开 socket（保证路由层
    // req.on('close') → releaseWatcherRef 触发）
    const fail = () => {
      cleanup();
      res.destroy?.();
    };

    const safeWrite = (chunk: string) => {
      try {
        res.write(chunk, (err) => {
          if (err) fail();
        });
      } catch {
        fail(); // write-after-end / destroyed socket
      }
    };

    for (const event of FORWARDED_EVENTS) {
      const listener = (payload: unknown) => {
        safeWrite(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      bus.on(event, listener);
      listeners.push([event, listener]);
    }

    req.on('close', cleanup);

    // 心跳：保持 NAT/代理连接 + 检测死 socket（bfcache 僵尸 TCP 活着
    // 检测不到，见文件头注释；此处的价值是浏览器真正关闭/驱逐后收割）
    heartbeat = setInterval(() => {
      safeWrite(': ping\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();
  };
}

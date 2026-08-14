import { EventEmitter } from 'node:events';

/**
 * 跨包共享事件总线 — globalThis 单例
 *
 * Electron 会从 ~/.doc77/electron-modules 加载 MCP 及其兄弟副本 core；
 * 若总线挂在模块级变量，各副本会各自持有一个 EventEmitter，导致
 * task:executed / task:failed / file-tree:changed 事件在副本间断裂。
 * 挂在 globalThis 命名键下，所有副本（含应用打包的 core）共享同一实例。
 *
 * 事件：
 * - task:executed     → { task_id, project_id, result }
 * - task:failed       → { task_id, project_id, error_message, rolled_back }
 * - file-tree:changed → { projectId, path, opType, paths, truncated? }
 */
const GLOBAL_KEY = '__doc77_event_bus__';

function createBus(): EventEmitter {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  return bus;
}

/** 获取（或创建）共享事件总线实例。 */
export function getEventBus(): EventEmitter {
  const g = globalThis as Record<string, unknown>;
  let bus = g[GLOBAL_KEY] as EventEmitter | undefined;
  if (!bus) {
    bus = createBus();
    g[GLOBAL_KEY] = bus;
  }
  return bus;
}

/** 重置事件总线（测试用）：移除全部监听并删除单例。 */
export function resetEventBus(): void {
  const g = globalThis as Record<string, unknown>;
  const bus = g[GLOBAL_KEY] as EventEmitter | undefined;
  if (bus) bus.removeAllListeners();
  delete g[GLOBAL_KEY];
}

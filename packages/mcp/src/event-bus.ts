/**
 * 事件总线 — 自 v1.1.2 起由 @doc77/core 提供 globalThis 单例
 * （Electron 双 core 副本场景必须共享同一实例，见 core/server/event-bus.ts），
 * 此处仅 re-export，保持 mcp 既有导入路径（index.ts / executor.ts）不变。
 */
export { getEventBus, resetEventBus } from '@doc77/core';

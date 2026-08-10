/**
 * 适配器注册表 — barrel 导出 + 工厂注册表
 *
 * engine.ts 通过 getAdapter(type) 获取适配器实例
 */
import type { SyncAdapter } from '../types.js';
import { GitAdapter } from './git.js';
import { WebDAVAdapter } from './webdav.js';
import { S3Adapter } from './s3.js';
import { LocalAdapter } from './local.js';

export { GitAdapter } from './git.js';
export { WebDAVAdapter } from './webdav.js';
export { S3Adapter } from './s3.js';
export { LocalAdapter } from './local.js';
export { BaseSyncAdapter } from './adapter.js';

/** 适配器工厂注册表 — 类型字符串 → 工厂函数 */
export const ADAPTER_REGISTRY: Record<string, () => SyncAdapter> = {
  git: () => new GitAdapter(),
  webdav: () => new WebDAVAdapter(),
  s3: () => new S3Adapter(),
  local: () => new LocalAdapter(),
};

/**
 * 根据类型字符串获取适配器实例
 * @param type 适配器类型（git/webdav/s3/local）
 * @returns 适配器实例，未知类型返回 null
 */
export function getAdapter(type: string): SyncAdapter | null {
  const factory = ADAPTER_REGISTRY[type];
  return factory ? factory() : null;
}

/**
 * 适配器抽象基类 — 为未来适配器提供 scanLocal 默认实现
 *
 * 现有 GitAdapter/WebDAVAdapter/S3Adapter/LocalAdapter 未继承此基类
 * （它们已各自实现 push/pull/listRemote/testConnection），但 engine
 * 可通过 instanceof 检测是否使用默认 scanLocal，或直接调用 state.ts
 * 中的 scanLocal 函数。
 *
 * 新增适配器建议继承此基类以复用 scanLocal 实现。
 */
import type {
  SyncAdapter,
  SyncContext,
  AdapterConfig,
  ConnectionResult,
  PullResult,
  PushResult,
  RemoteFileEntry,
  FileChange,
} from '../types.js';
import { scanLocal } from '../state.js';

export abstract class BaseSyncAdapter implements SyncAdapter {
  abstract readonly name: string;
  abstract readonly displayName: string;

  abstract testConnection(config: AdapterConfig): Promise<ConnectionResult>;
  abstract pull(ctx: SyncContext): Promise<PullResult>;
  abstract push(ctx: SyncContext): Promise<PushResult>;
  abstract listRemote(config: AdapterConfig): Promise<RemoteFileEntry[]>;

  /**
   * 默认 scanLocal 实现 — 遍历项目目录 + ignorePatterns 过滤
   *
   * 子类可覆盖以提供更高效的实现（如 git 适配器用 git.status() 自发现变更）
   */
  scanLocal(ctx: SyncContext): FileChange[] {
    const ignorePatterns = ctx.options.ignorePatterns || [];
    return scanLocal(ctx.projectPath, ignorePatterns);
  }
}

/**
 * @doc77/sync — Public entry point.
 */
export { SyncEngine } from './engine.js';
export { getAdapter, ADAPTER_REGISTRY } from './adapters/index.js';
export { GitAdapter } from './adapters/git.js';
export { WebDAVAdapter } from './adapters/webdav.js';
export { S3Adapter } from './adapters/s3.js';
export { LocalAdapter } from './adapters/local.js';
export { BaseSyncAdapter } from './adapters/adapter.js';
export type { WebDAVAdapterConfig } from './adapters/webdav.js';
export type { S3AdapterConfig } from './adapters/s3.js';
export type { LocalAdapterConfig } from './adapters/local.js';
export type {
  SyncAdapter,
  SyncConfig,
  SyncState,
  SyncResult,
  SyncContext,
  SyncDirection,
  SyncStatus,
  SyncOptions,
  ConflictEntry,
  FileChange,
  RemoteFileEntry,
  ConnectionResult,
  AdapterConfig,
  GitAdapterConfig,
  PullResult,
  PushResult,
} from './types.js';

// 状态计算（本地扫描 + 远程对比）
export { scanLocal, compareRemote, shouldIgnore } from './state.js';

import { SyncEngine } from './engine.js';

/** Singleton sync engine instance */
let _engine: SyncEngine | null = null;

export function createSyncEngine(): SyncEngine {
  if (!_engine) {
    _engine = new SyncEngine();
  }
  return _engine;
}

// Merge
export { threeWayMerge, resolveConflicts } from './merge/diff3.js';
export type { MergeResult, MergeChunk } from './merge/diff3.js';

// Crypto (E2EE)
export { encrypt, decrypt, encryptFile, decryptFile, deriveKey, generateSalt, generateRecoveryCode } from './crypto/encrypt.js';
export type { EncryptedPayload, EncryptedFile } from './crypto/encrypt.js';
export { Keyring, getKeyring, __resetKeyringForTest } from './crypto/keyring.js';
export type { KeyringState } from './crypto/keyring.js';

// T8: 路由 + 调度器
export { registerSyncRoutes } from './routes.js';
export type { SyncRouteDeps } from './routes.js';
export { SyncScheduler, createSyncScheduler } from './scheduler.js';
export type { SchedulerDeps } from './scheduler.js';

// T13: diff + conflict + ai-assist
export { computeDiff, formatDiff } from './diff.js';
export type { DiffResult, DiffLine } from './diff.js';
export { detectConflicts, resolveConflict } from './conflict.js';
export type { ConflictStrategy, Resolution } from './conflict.js';
export { aiResolveConflict, buildConflictPrompt } from './merge/ai-assist.js';
export type { AiConflictContext, AiResolution, AiChatFn } from './merge/ai-assist.js';


/**
 * @doc77/sync — Public entry point.
 */
export { SyncEngine, getAdapter } from './engine.js';
export { GitAdapter } from './adapters/git.js';
export { WebDAVAdapter } from './adapters/webdav.js';
export { S3Adapter } from './adapters/s3.js';
export { LocalAdapter } from './adapters/local.js';
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

import { SyncEngine } from './engine.js';

/** Singleton sync engine instance */
let _engine: SyncEngine | null = null;

export function createSyncEngine(): SyncEngine {
  if (!_engine) {
    _engine = new SyncEngine();
  }
  return _engine;
}

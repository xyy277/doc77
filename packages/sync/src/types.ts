/**
 * @doc77/sync — Core type definitions.
 */

/** Sync direction */
export type SyncDirection = 'bidirectional' | 'push' | 'pull';

/** Sync status */
export type SyncStatus = 'idle' | 'syncing' | 'conflict' | 'error' | 'disabled';

/** Adapter config base */
export interface AdapterConfig {
  type: string;
  [key: string]: unknown;
}

/** Connection test result */
export interface ConnectionResult {
  ok: boolean;
  message?: string;
  server?: string;
}

/** Remote file entry */
export interface RemoteFileEntry {
  path: string;
  size: number;
  lastModified: string;
  etag?: string;
  hash?: string;
}

/** File change */
export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  mtime: string;
  hash: string;
  size: number;
}

/** Sync options */
export interface SyncOptions {
  ignorePatterns: string[];
  conflictStrategy: 'ask' | 'local' | 'remote';
  dryRun: boolean;
  /** 适配器配置（统一字段 — webdav/s3/local 适配器读取此字段） */
  adapterConfig?: AdapterConfig;
  /** git 适配器兼容字段（值与 adapterConfig 相同，git.ts 优先读 adapterConfig） */
  gitConfig?: AdapterConfig;
}

/** Sync context passed to adapters */
export interface SyncContext {
  projectId: number;
  projectPath: string;
  direction: SyncDirection;
  changedFiles: FileChange[];
  remoteFiles: RemoteFileEntry[];
  options: SyncOptions;
}

/** Pull result */
export interface PullResult {
  filesUpdated: number;
  filesDeleted: number;
  errors: string[];
}

/** Push result */
export interface PushResult {
  filesPushed: number;
  errors: string[];
  commitHash?: string;
}

/** Full sync result */
export interface SyncResult {
  status: 'success' | 'conflict' | 'error';
  pushed: number;
  pulled: number;
  conflicts: ConflictEntry[];
  errors: string[];
  duration: number;
}

/** Conflict entry */
export interface ConflictEntry {
  path: string;
  localHash: string;
  remoteHash: string;
  resolution?: 'local' | 'remote' | 'merged';
}

/** Sync adapter abstract interface */
export interface SyncAdapter {
  readonly name: string;
  readonly displayName: string;

  testConnection(config: AdapterConfig): Promise<ConnectionResult>;
  pull(ctx: SyncContext): Promise<PullResult>;
  push(ctx: SyncContext): Promise<PushResult>;
  listRemote(config: AdapterConfig): Promise<RemoteFileEntry[]>;
}

/** Git adapter config */
export interface GitAdapterConfig extends AdapterConfig {
  type: 'git';
  remoteUrl: string;
  branch: string;
  remoteName: string;
  authMethod: 'ssh' | 'https' | 'token';
  token?: string;
  commitPrefix: string;
  autoCommit: boolean;
  pullStrategy: 'merge' | 'rebase';
}

/** Sync config stored in DB */
export interface SyncConfig {
  id?: number;
  project_id: number;
  adapter_type: string;
  config_json: string;
  direction: SyncDirection;
  interval_seconds: number;
  enabled: number;
  created_at?: string;
  updated_at?: string;
}

/** Sync state stored in DB */
export interface SyncState {
  project_id: number;
  status: SyncStatus;
  last_sync_at: string | null;
  last_baseline: string | null;
  last_error: string | null;
  total_pushed: number;
  total_pulled: number;
  total_conflicts: number;
}


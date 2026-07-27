/**
 * SyncEngine — orchestrates sync operations between local and remote.
 */
import type {
  SyncAdapter,
  SyncConfig,
  SyncState,
  SyncResult,
  SyncContext,
  SyncDirection,
  ConflictEntry,
  GitAdapterConfig,
} from './types.js';
import { GitAdapter } from './adapters/git.js';
import { WebDAVAdapter } from './adapters/webdav.js';
import { S3Adapter } from './adapters/s3.js';
import { LocalAdapter } from './adapters/local.js';

const ADAPTERS: Record<string, () => SyncAdapter> = {
  git: () => new GitAdapter(),
  webdav: () => new WebDAVAdapter(),
  s3: () => new S3Adapter(),
  local: () => new LocalAdapter(),
};

export function getAdapter(type: string): SyncAdapter | null {
  const factory = ADAPTERS[type];
  return factory ? factory() : null;
}

export class SyncEngine {
  private timers: Map<number, ReturnType<typeof setInterval>> = new Map();

  /**
   * Run sync for a project.
   */
  async sync(
    projectId: number,
    projectPath: string,
    config: SyncConfig,
    direction?: SyncDirection,
  ): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      status: 'success',
      pushed: 0,
      pulled: 0,
      conflicts: [],
      errors: [],
      duration: 0,
    };

    const adapter = getAdapter(config.adapter_type);
    if (!adapter) {
      result.status = 'error';
      result.errors.push(`Unknown adapter: ${config.adapter_type}`);
      result.duration = Date.now() - startTime;
      return result;
    }

    const gitConfig = JSON.parse(config.config_json) as GitAdapterConfig;
    const dir = direction || config.direction;

    const ctx: SyncContext = {
      projectId,
      projectPath,
      direction: dir,
      changedFiles: [],
      remoteFiles: [],
      options: {
        ignorePatterns: gitConfig.ignorePatterns || ['node_modules/', '.git/', '*.tmp'],
        conflictStrategy: 'ask',
        dryRun: false,
        gitConfig,
      } as any,
    };

    try {
      // Pull
      if (dir === 'bidirectional' || dir === 'pull') {
        const pullResult = await adapter.pull(ctx);
        result.pulled = pullResult.filesUpdated;
        if (pullResult.errors.length > 0) {
          result.errors.push(...pullResult.errors);
          if (pullResult.errors.some((e) => e.includes('conflict'))) {
            result.status = 'conflict';
          }
        }
      }

      // Push
      if (dir === 'bidirectional' || dir === 'push') {
        const pushResult = await adapter.push(ctx);
        result.pushed = pushResult.filesPushed;
        if (pushResult.errors.length > 0) {
          result.errors.push(...pushResult.errors);
        }
      }

      if (result.errors.length > 0 && result.status === 'success') {
        result.status = 'error';
      }
    } catch (e: unknown) {
      result.status = 'error';
      result.errors.push(e instanceof Error ? e.message : 'Sync failed');
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Test adapter connection.
   */
  async testConnection(adapterType: string, configJson: string): Promise<{ ok: boolean; message?: string }> {
    const adapter = getAdapter(adapterType);
    if (!adapter) return { ok: false, message: `Unknown adapter: ${adapterType}` };

    const config = JSON.parse(configJson);
    config.type = adapterType;
    return adapter.testConnection(config);
  }

  /**
   * Start scheduled sync for a project.
   */
  startScheduler(
    projectId: number,
    projectPath: string,
    config: SyncConfig,
    onResult?: (result: SyncResult) => void,
  ): void {
    this.stopScheduler(projectId);
    if (config.interval_seconds <= 0) return;

    const timer = setInterval(async () => {
      const result = await this.sync(projectId, projectPath, config);
      if (onResult) onResult(result);
    }, config.interval_seconds * 1000);

    this.timers.set(projectId, timer);
  }

  /**
   * Stop scheduled sync for a project.
   */
  stopScheduler(projectId: number): void {
    const timer = this.timers.get(projectId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(projectId);
    }
  }

  /**
   * Stop all schedulers.
   */
  stopAll(): void {
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}

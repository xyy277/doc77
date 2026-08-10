/**
 * SyncEngine — orchestrates sync operations between local and remote.
 */
import type {
  SyncConfig,
  SyncResult,
  SyncContext,
  SyncDirection,
  GitAdapterConfig,
  AdapterConfig,
} from './types.js';
import { getAdapter } from './adapters/index.js';
import { scanLocal, compareRemote } from './state.js';

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

    // 解析适配器配置 — 统一使用 adapterConfig 字段
    const adapterConfig = JSON.parse(config.config_json) as AdapterConfig & {
      ignorePatterns?: string[];
    };
    const dir = direction || config.direction;
    const ignorePatterns = adapterConfig.ignorePatterns || [
      'node_modules/',
      '.git/',
      '*.tmp',
    ];

    const ctx: SyncContext = {
      projectId,
      projectPath,
      direction: dir,
      changedFiles: [],
      remoteFiles: [],
      options: {
        ignorePatterns,
        conflictStrategy: 'ask',
        dryRun: false,
        // 统一配置键：webdav/s3/local 读 adapterConfig，git 兼容读 gitConfig
        adapterConfig,
        gitConfig: adapterConfig as GitAdapterConfig,
      },
    };

    try {
      // 扫描本地文件 + 远程文件列表，diff 后填充 ctx
      // 注：git 适配器用 git.status() 自发现变更，不依赖 changedFiles，填充对它无害
      const localFiles = scanLocal(projectPath, ignorePatterns);
      let remoteFiles: Awaited<ReturnType<typeof adapter.listRemote>> = [];
      try {
        remoteFiles = await adapter.listRemote(adapterConfig);
      } catch (e: unknown) {
        // listRemote 失败不阻塞 push（如远端为空桶/目录尚未创建）
        result.errors.push(
          `listRemote warning: ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }
      ctx.remoteFiles = remoteFiles;

      // 计算 diff — toPush 为需上传的文件集合
      const diff = compareRemote(localFiles, remoteFiles);
      if (diff.conflicts.length > 0) {
        result.conflicts.push(...diff.conflicts);
      }
      // 对非 git 适配器：仅 push toPush 集合（避免重复上传未变更文件）
      // git 适配器用 git.status() 自发现变更，忽略 changedFiles，故这里对 git 无影响
      ctx.changedFiles = diff.toPush;

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
        // listRemote 警告不算硬错误，仅真实错误才标记 status
        const realErrors = result.errors.filter(
          (e) => !e.startsWith('listRemote warning:'),
        );
        if (realErrors.length > 0) result.status = 'error';
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
  async testConnection(
    adapterType: string,
    configJson: string,
  ): Promise<{ ok: boolean; message?: string }> {
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
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}

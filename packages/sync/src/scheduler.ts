/**
 * SyncScheduler — 从 engine.ts 抽离的定时同步调度器。
 *
 * 职责：
 * 1. 管理每个项目的 setInterval 定时器
 * 2. 启动时从 DB 读取 enabled=1 的 sync_configs，恢复调度（持久化语义）
 * 3. stop/stopAll 清理定时器
 *
 * 设计要点：
 * - 调度器本身无状态持久化——"持久化"指的是进程重启后能从 DB 配置恢复定时器
 * - 定时器触发时调用 engine.sync()，结果通过 onResult 回调通知调用方
 * - 与 engine 的 startScheduler/stopScheduler 保持兼容（engine 仍保留这些方法）
 */
import type { SyncEngine } from './engine.js';
import type { SyncConfig, SyncResult } from './types.js';
import type { DatabaseCompat } from '@doc77/core';

export interface SchedulerDeps {
  engine: SyncEngine;
  db: DatabaseCompat;
  /** 获取项目路径的函数（从 projects 表查） */
  getProjectPath?: (projectId: number) => string | null;
  /** 同步结果回调（可选，用于日志/通知） */
  onSyncResult?: (projectId: number, result: SyncResult) => void;
}

export class SyncScheduler {
  private timers: Map<number, ReturnType<typeof setInterval>> = new Map();
  private readonly engine: SyncEngine;
  private readonly db: DatabaseCompat;
  private readonly getProjectPath: (projectId: number) => string | null;
  private readonly onSyncResult?: (projectId: number, result: SyncResult) => void;

  constructor(deps: SchedulerDeps) {
    this.engine = deps.engine;
    this.db = deps.db;
    this.getProjectPath =
      deps.getProjectPath || ((pid: number) => {
        const row = this.db.prepare('SELECT path FROM projects WHERE id = ?').get(pid) as
          | { path: string }
          | undefined;
        return row?.path || null;
      });
    this.onSyncResult = deps.onSyncResult;
  }

  /**
   * 启动指定项目的定时同步。
   * 若该项目已有定时器，先停止再重建（更新 interval）。
   */
  start(projectId: number, config: SyncConfig): void {
    this.stop(projectId);
    if (config.interval_seconds <= 0 || config.enabled === 0) return;

    const timer = setInterval(async () => {
      const projectPath = this.getProjectPath(projectId);
      if (!projectPath) return;
      try {
        const result = await this.engine.sync(projectId, projectPath, config);
        this.onSyncResult?.(projectId, result);
        this.updateState(projectId, result);
      } catch (e) {
        console.error(`[sync:scheduler] project ${projectId} sync failed:`, e);
      }
    }, config.interval_seconds * 1000);

    this.timers.set(projectId, timer);
  }

  /** 停止指定项目的定时同步 */
  stop(projectId: number): void {
    const timer = this.timers.get(projectId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(projectId);
    }
  }

  /** 停止所有定时器 */
  stopAll(): void {
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /**
   * 进程启动时从 DB 恢复所有 enabled=1 的调度。
   * 应在 app 初始化后调用一次。
   */
  restoreFromDB(): number {
    const configs = this.db
      .prepare('SELECT * FROM sync_configs WHERE enabled = 1')
      .all() as SyncConfig[];
    let restored = 0;
    for (const config of configs) {
      if (config.interval_seconds > 0 && config.project_id) {
        this.start(config.project_id, config);
        restored++;
      }
    }
    return restored;
  }

  /** 检查某项目是否正在调度 */
  isRunning(projectId: number): boolean {
    return this.timers.has(projectId);
  }

  /** 列出所有正在调度的项目 ID */
  listRunning(): number[] {
    return Array.from(this.timers.keys());
  }

  /**
   * 同步完成后更新 sync_state 表（记录上次同步时间、状态、计数）。
   * 静默失败——DB 写入异常不抛错（调度器不应因日志写入失败而停止）。
   */
  private updateState(projectId: number, result: SyncResult): void {
    try {
      const status = result.status === 'success' ? 'idle' : result.status;
      this.db
        .prepare(
          `INSERT OR REPLACE INTO sync_state
            (project_id, status, last_sync_at, last_error, total_pushed, total_pulled, total_conflicts)
           VALUES (?, ?, datetime('now'), ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          status,
          result.errors.length > 0 ? result.errors.join('; ') : null,
          result.pushed,
          result.pulled,
          result.conflicts.length,
        );

      // 写入 sync_log
      this.db
        .prepare(
          `INSERT INTO sync_log (project_id, direction, status, files_pushed, files_pulled, conflicts, error_message, duration_ms)
           VALUES (?, 'bidirectional', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          result.status,
          result.pushed,
          result.pulled,
          result.conflicts.length,
          result.errors.length > 0 ? result.errors.join('; ') : null,
          result.duration,
        );
    } catch (e) {
      console.error(`[sync:scheduler] failed to update state for project ${projectId}:`, e);
    }
  }
}

/**
 * 工厂函数：创建调度器并自动从 DB 恢复。
 */
export function createSyncScheduler(deps: SchedulerDeps): SyncScheduler {
  const scheduler = new SyncScheduler(deps);
  scheduler.restoreFromDB();
  return scheduler;
}

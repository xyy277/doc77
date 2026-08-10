/**
 * Sync 路由 — 注册同步相关的 7 条 API 路由。
 *
 * 路由清单：
 * - GET    /api/sync/configs/:projectId  — 获取同步配置
 * - PUT    /api/sync/configs/:projectId  — 保存/更新同步配置
 * - POST   /api/sync/test                — 测试适配器连接
 * - POST   /api/sync/run/:projectId      — 立即执行同步
 * - GET    /api/sync/state/:projectId    — 获取同步状态
 * - GET    /api/sync/log/:projectId      — 获取同步日志（最近 N 条）
 * - POST   /api/sync/scheduler/:projectId/start — 启动定时调度
 * - POST   /api/sync/scheduler/:projectId/stop  — 停止定时调度
 *
 * 设计：外部 registerSyncRoutes(app, deps) 模式，app.ts 仅增加一行挂载。
 *       使用自定义 AppRouter 接口而非 Express 类型，避免 sync 包强依赖 express。
 */
import type { SyncEngine } from './engine.js';
import type { SyncScheduler } from './scheduler.js';
import type { SyncConfig } from './types.js';
import type { DatabaseCompat } from '@doc77/core';

/**
 * 最小路由契约 — 兼容 Express、Polka、自定义 http server。
 * Express 的 app.get/post/put 完全匹配此接口，无需适配。
 */
export interface AppRouter {
  get(path: string, handler: (req: RequestLike, res: ResponseLike) => void): unknown;
  post(path: string, handler: (req: RequestLike, res: ResponseLike) => void): unknown;
  put(path: string, handler: (req: RequestLike, res: ResponseLike) => void): unknown;
}

/** 请求对象的最小契约（兼容 Express Request） */
export interface RequestLike {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  method: string;
  path: string;
}

/** 响应对象的最小契约（兼容 Express Response） */
export interface ResponseLike {
  status(code: number): this;
  json(data: unknown): void;
}

export interface SyncRouteDeps {
  engine: SyncEngine;
  scheduler: SyncScheduler;
  db: DatabaseCompat;
  /** 获取项目路径（从 projects 表查） */
  getProjectPath: (projectId: number) => string | null;
}

type Req = RequestLike;
type Res = ResponseLike;

export function registerSyncRoutes(app: AppRouter, deps: SyncRouteDeps): void {
  const { engine, scheduler, db, getProjectPath } = deps;

  // ── GET /api/sync/configs/:projectId ──
  app.get('/api/sync/configs/:projectId', (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    const config = db
      .prepare('SELECT * FROM sync_configs WHERE project_id = ?')
      .get(projectId) as SyncConfig | undefined;
    if (!config) {
      res.status(404).json({ error: 'No sync config for this project' });
      return;
    }
    res.json({ config });
  });

  // ── PUT /api/sync/configs/:projectId ──
  app.put('/api/sync/configs/:projectId', (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const { adapter_type, config_json, direction, interval_seconds, enabled } = body as {
      adapter_type?: string;
      config_json?: unknown;
      direction?: string;
      interval_seconds?: number;
      enabled?: boolean | number;
    };
    if (!adapter_type || !config_json) {
      res.status(400).json({ error: 'adapter_type and config_json are required' });
      return;
    }
    db.prepare(
      `INSERT OR REPLACE INTO sync_configs
        (project_id, adapter_type, config_json, direction, interval_seconds, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      projectId,
      adapter_type,
      typeof config_json === 'string' ? config_json : JSON.stringify(config_json),
      direction || 'bidirectional',
      interval_seconds || 1800,
      enabled === undefined ? 1 : enabled ? 1 : 0,
    );
    const config = db
      .prepare('SELECT * FROM sync_configs WHERE project_id = ?')
      .get(projectId) as SyncConfig;
    res.json({ config });
  });

  // ── POST /api/sync/test ──
  app.post('/api/sync/test', async (req: Req, res: Res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const { adapter_type, config_json } = body as {
      adapter_type?: string;
      config_json?: unknown;
    };
    if (!adapter_type || !config_json) {
      res.status(400).json({ error: 'adapter_type and config_json are required' });
      return;
    }
    try {
      const result = await engine.testConnection(
        adapter_type,
        typeof config_json === 'string' ? config_json : JSON.stringify(config_json),
      );
      res.json(result);
    } catch (e: unknown) {
      res.status(500).json({ ok: false, message: (e as Error).message });
    }
  });

  // ── POST /api/sync/run/:projectId ──
  app.post('/api/sync/run/:projectId', async (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    const projectPath = getProjectPath(projectId);
    if (!projectPath) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const config = db
      .prepare('SELECT * FROM sync_configs WHERE project_id = ?')
      .get(projectId) as SyncConfig | undefined;
    if (!config) {
      res.status(404).json({ error: 'No sync config for this project' });
      return;
    }
    try {
      // 标记 syncing 状态
      db.prepare(
        `INSERT OR REPLACE INTO sync_state (project_id, status, last_sync_at)
         VALUES (?, 'syncing', datetime('now'))`,
      ).run(projectId);

      const result = await engine.sync(projectId, projectPath, config);

      // 更新状态 + 写日志
      const status = result.status === 'success' ? 'idle' : result.status;
      db.prepare(
        `INSERT OR REPLACE INTO sync_state
          (project_id, status, last_sync_at, last_error, total_pushed, total_pulled, total_conflicts)
         VALUES (?, ?, datetime('now'), ?, ?, ?, ?)`,
      ).run(
        projectId,
        status,
        result.errors.length > 0 ? result.errors.join('; ') : null,
        result.pushed,
        result.pulled,
        result.conflicts.length,
      );
      db.prepare(
        `INSERT INTO sync_log (project_id, direction, status, files_pushed, files_pulled, conflicts, error_message, duration_ms)
         VALUES (?, 'bidirectional', ?, ?, ?, ?, ?, ?)`,
      ).run(
        projectId,
        result.status,
        result.pushed,
        result.pulled,
        result.conflicts.length,
        result.errors.length > 0 ? result.errors.join('; ') : null,
        result.duration,
      );
      res.json({ result });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/sync/state/:projectId ──
  app.get('/api/sync/state/:projectId', (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    const state = db.prepare('SELECT * FROM sync_state WHERE project_id = ?').get(projectId);
    const schedulerRunning = scheduler.isRunning(projectId);
    res.json({ state: state || null, schedulerRunning });
  });

  // ── GET /api/sync/log/:projectId ──
  app.get('/api/sync/log/:projectId', (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const logs = db
      .prepare(
        'SELECT * FROM sync_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(projectId, limit);
    res.json({ logs });
  });

  // ── POST /api/sync/scheduler/:projectId/start ──
  app.post('/api/sync/scheduler/:projectId/start', (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    const config = db
      .prepare('SELECT * FROM sync_configs WHERE project_id = ?')
      .get(projectId) as SyncConfig | undefined;
    if (!config) {
      res.status(404).json({ error: 'No sync config for this project' });
      return;
    }
    scheduler.start(projectId, config);
    res.json({ ok: true, running: true });
  });

  // ── POST /api/sync/scheduler/:projectId/stop ──
  app.post('/api/sync/scheduler/:projectId/stop', (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    scheduler.stop(projectId);
    res.json({ ok: true, running: false });
  });

  // ── GET /api/sync/conflicts/:projectId — T13: 获取待解决冲突列表 ──
  app.get('/api/sync/conflicts/:projectId', (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    // 从 sync_state 读取上次同步的冲突信息
    const state = db.prepare('SELECT * FROM sync_state WHERE project_id = ?').get(projectId) as
      | { total_conflicts: number; last_error: string | null }
      | undefined;
    const conflictCount = state?.total_conflicts || 0;
    // 返回冲突摘要（详细冲突信息存在 sync_log 中）
    res.json({
      projectId,
      pendingConflicts: conflictCount,
      hasConflicts: conflictCount > 0,
      lastError: state?.last_error || null,
    });
  });
}

/**
 * T11: 插件 API 路由 — 安装/卸载/配置插件。
 *
 * 路由清单：
 * - GET    /api/plugins                 — 列出已安装插件
 * - POST   /api/plugins/install         — 从 URL/npm 安装插件
 * - DELETE /api/plugins/:name           — 卸载插件
 * - GET    /api/plugins/:name/config    — 读取插件配置
 * - PUT    /api/plugins/:name/config    — 更新插件配置
 * - POST   /api/plugins/:name/toggle    — 启用/禁用插件
 */
import type { DatabaseCompat } from '../../db/connection.js';

export interface PluginRouteDeps {
  db: DatabaseCompat;
  /** 插件目录路径（~/.doc77/plugins/） */
  pluginDir: string;
}

export interface PluginAppRouter {
  get(path: string, handler: (req: PluginReqLike, res: PluginResLike) => void): unknown;
  post(path: string, handler: (req: PluginReqLike, res: PluginResLike) => void): unknown;
  put(path: string, handler: (req: PluginReqLike, res: PluginResLike) => void): unknown;
  delete(path: string, handler: (req: PluginReqLike, res: PluginResLike) => void): unknown;
}

export interface PluginReqLike {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  method: string;
  path: string;
}

export interface PluginResLike {
  status(code: number): this;
  json(data: unknown): void;
}

type Req = PluginReqLike;
type Res = PluginResLike;

interface PluginRow {
  id: number;
  name: string;
  version: string;
  type: string;
  enabled: number;
  config_json: string;
  source: string | null;
  installed_at: string;
  updated_at: string;
}

export function registerPluginRoutes(app: PluginAppRouter, deps: PluginRouteDeps): void {
  const { db } = deps;

  // ── GET /api/plugins — 列出已安装插件 ──
  app.get('/api/plugins', (_req: Req, res: Res) => {
    const rows = db
      .prepare('SELECT * FROM plugins ORDER BY installed_at DESC')
      .all() as PluginRow[];
    res.json({
      plugins: rows.map((r) => ({
        name: r.name,
        version: r.version,
        type: r.type,
        enabled: r.enabled === 1,
        config: JSON.parse(r.config_json || '{}'),
        source: r.source,
        installedAt: r.installed_at,
      })),
    });
  });

  // ── POST /api/plugins/install — 安装插件 ──
  app.post('/api/plugins/install', (req: Req, res: Res) => {
    const body = (req.body || {}) as {
      name?: string;
      version?: string;
      type?: string;
      source?: string;
      config?: Record<string, unknown>;
    };
    const { name, version, type, source, config } = body;
    if (!name || !version || !type) {
      res.status(400).json({ error: 'name, version, type are required' });
      return;
    }

    // 检查是否已安装
    const existing = db.prepare('SELECT id FROM plugins WHERE name = ?').get(name);
    if (existing) {
      // 更新版本
      db.prepare(
        `UPDATE plugins SET version = ?, type = ?, source = ?, updated_at = datetime('now') WHERE name = ?`,
      ).run(version, type, source || null, name);
      res.json({ ok: true, updated: true, name });
      return;
    }

    // 安装（记录到 DB）
    db.prepare(
      `INSERT INTO plugins (name, version, type, enabled, config_json, source)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(name, version, type, JSON.stringify(config || {}), source || null);
    res.json({ ok: true, installed: true, name });
  });

  // ── DELETE /api/plugins/:name — 卸载插件 ──
  app.delete('/api/plugins/:name', (req: Req, res: Res) => {
    const name = req.params.name;
    if (!name) {
      res.status(400).json({ error: 'Plugin name is required' });
      return;
    }
    const result = db.prepare('DELETE FROM plugins WHERE name = ?').run(name);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    res.json({ ok: true, removed: name });
  });

  // ── GET /api/plugins/:name/config — 读取配置 ──
  app.get('/api/plugins/:name/config', (req: Req, res: Res) => {
    const name = req.params.name;
    const row = db.prepare('SELECT config_json FROM plugins WHERE name = ?').get(name) as
      { config_json: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    res.json({ config: JSON.parse(row.config_json || '{}') });
  });

  // ── PUT /api/plugins/:name/config — 更新配置 ──
  app.put('/api/plugins/:name/config', (req: Req, res: Res) => {
    const name = req.params.name;
    const body = (req.body || {}) as { config?: Record<string, unknown> };
    const config = body.config;
    if (!config) {
      res.status(400).json({ error: 'config is required' });
      return;
    }
    const result = db
      .prepare(`UPDATE plugins SET config_json = ?, updated_at = datetime('now') WHERE name = ?`)
      .run(JSON.stringify(config), name);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    res.json({ ok: true, config });
  });

  // ── POST /api/plugins/:name/toggle — 启用/禁用 ──
  app.post('/api/plugins/:name/toggle', (req: Req, res: Res) => {
    const name = req.params.name;
    const body = (req.body || {}) as { enabled?: boolean };
    const enabled = body.enabled ? 1 : 0;
    const result = db
      .prepare(`UPDATE plugins SET enabled = ?, updated_at = datetime('now') WHERE name = ?`)
      .run(enabled, name);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    res.json({ ok: true, name, enabled: enabled === 1 });
  });
}

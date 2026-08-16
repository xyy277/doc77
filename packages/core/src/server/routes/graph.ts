import type { Express, Request, Response } from 'express';
import { getConnection } from '../../db/connection.js';
import { validatePath } from '../../fs/index.js';
import { queryBacklinks, getGraphStats } from '../../graph/repository.js';
import { relatedDocs } from '../../graph/related.js';
import { fullGraphIndex, markProjectGraphDirty } from '../../graph/indexer.js';
import { getEventBus } from '../event-bus.js';

/**
 * 知识图谱 API（v1.2.0，链接基础设施 MVP）。
 *
 * 路由清单：
 * - GET  /api/graph/:id                — 节点+边（可视化数据，?path= 子图）
 * - GET  /api/graph/:id/backlinks?path=— 反向链接（入链）
 * - GET  /api/graph/:id/related?path=  — 相关文档（co-citation 评分）
 * - GET  /api/graph/:id/stats          — 节点/边/死链/孤立页统计
 * - POST /api/graph/:id/index          — 全量重建（后台执行，SSE 进度）
 *
 * 安全：path 走 validatePath（逃逸 403）；非法 :id / 项目不存在 404；
 * 查询只 join 表不触磁盘。由 createApp 挂载（Electron 与 CLI 同源）。
 */

function projectExists(projectId: number): boolean {
  const row = getConnection().prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as
    { id: number } | undefined;
  return !!row;
}

function projectPath(projectId: number): string | undefined {
  const row = getConnection().prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;
  return row?.path;
}

/** path 参数校验：转相对路径（posix），越界/非法 → 返回 null */
function safeRelPath(req: Request, projectRoot: string): string | null {
  const raw = (req.query.path as string) || '';
  if (!raw) return '';
  try {
    const abs = validatePath(projectRoot, raw);
    return abs
      .slice(projectRoot.length)
      .replace(/^[/\\]+/, '')
      .split('\\')
      .join('/');
  } catch {
    return null;
  }
}

export function registerGraphRoutes(app: Express): void {
  const db = getConnection;

  // ── GET /api/graph/:id — 节点 + 边 ──
  app.get('/api/graph/:id', (req: Request, res: Response) => {
    const projectId = parseInt(String(req.params.id), 10);
    if (isNaN(projectId) || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const root = projectPath(projectId)!;
    const subPath = safeRelPath(req, root);
    if (subPath === null) {
      res.status(403).json({ error: 'Invalid path' });
      return;
    }

    const limit = Math.min(parseInt(String(req.query.limit ?? '2000'), 10) || 2000, 2000);
    // 子图：以 subPath 为锚的 1 跳邻居（含自身）
    const nodes = db()
      .prepare(
        `SELECT m.file_path AS path, m.title, m.tags
         FROM doc_meta m
         WHERE m.project_id = ?
           AND (? = '' OR m.file_path = ? OR m.file_path IN (
             SELECT l.to_path FROM doc_links l
             WHERE l.project_id = m.project_id AND l.from_path = ? AND l.status = 'resolved'
             UNION
             SELECT l.from_path FROM doc_links l
             WHERE l.project_id = m.project_id AND l.to_path = ? AND l.status = 'resolved'
           ))
         LIMIT ?`,
      )
      .all(projectId, subPath, subPath, subPath, subPath, limit) as Array<{
      path: string;
      title: string;
      tags: string;
    }>;
    const nodeSet = new Set(nodes.map((n) => n.path));
    const edges = db()
      .prepare(
        `SELECT from_path AS source, to_path AS target, link_type, anchor
         FROM doc_links
         WHERE project_id = ? AND status = 'resolved' AND from_path IN (
           SELECT file_path FROM doc_meta WHERE project_id = ?
         )
         LIMIT ?`,
      )
      .all(projectId, projectId, limit * 4) as Array<{
      source: string;
      target: string;
      link_type: string;
      anchor: string;
    }>;
    res.json({
      nodes: nodes.map((n) => ({ ...n, tags: JSON.parse(n.tags || '[]') })),
      edges: edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target)),
      projectId,
    });
  });

  // ── GET /api/graph/:id/backlinks — 反向链接 ──
  app.get('/api/graph/:id/backlinks', (req: Request, res: Response) => {
    const projectId = parseInt(String(req.params.id), 10);
    if (isNaN(projectId) || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const root = projectPath(projectId)!;
    const rel = safeRelPath(req, root);
    if (rel === null) {
      res.status(403).json({ error: 'Invalid path' });
      return;
    }
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
    const backlinks = queryBacklinks(db(), projectId, rel, { limit, offset });
    res.json({ path: rel, backlinks });
  });

  // ── GET /api/graph/:id/related — 相关文档 ──
  app.get('/api/graph/:id/related', (req: Request, res: Response) => {
    const projectId = parseInt(String(req.params.id), 10);
    if (isNaN(projectId) || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const root = projectPath(projectId)!;
    const rel = safeRelPath(req, root);
    if (rel === null) {
      res.status(403).json({ error: 'Invalid path' });
      return;
    }
    const limit = Math.min(parseInt(String(req.query.limit ?? '5'), 10) || 5, 20);
    const related = relatedDocs(projectId, rel, limit);
    res.json({ path: rel, related });
  });

  // ── GET /api/graph/:id/stats — 统计 ──
  app.get('/api/graph/:id/stats', (req: Request, res: Response) => {
    const projectId = parseInt(String(req.params.id), 10);
    if (isNaN(projectId) || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ projectId, ...getGraphStats(db(), projectId) });
  });

  // ── POST /api/graph/:id/index — 全量重建（后台，SSE 进度）──
  app.post('/api/graph/:id/index', (req: Request, res: Response) => {
    const projectId = parseInt(String(req.params.id), 10);
    if (isNaN(projectId) || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const root = projectPath(projectId)!;
    // 幂等：复用脏标记调度（5s 去抖 + 后台执行）
    markProjectGraphDirty(projectId);
    // 立即触发（不等去抖）：重建进度经 event-bus 广播（graph:index-progress）
    fullGraphIndex(projectId, root, (p) => {
      try {
        getEventBus().emit('graph:index-progress', { projectId, ...p });
      } catch {
        /* best-effort */
      }
    }).catch(() => {
      /* best-effort */
    });
    res.json({ status: 'indexing' });
  });
}

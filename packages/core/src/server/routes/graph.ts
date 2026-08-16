import type { Express, Request, Response } from 'express';
import { getConnection } from '../../db/connection.js';
import { validatePath } from '../../fs/index.js';
import {
  queryBacklinks,
  getGraphStats,
  queryGraphNodes,
  queryGraphEdges,
  getGraphStatsMulti,
  queryOrphans,
  queryBrokenLinks,
} from '../../graph/repository.js';
import { relatedDocs } from '../../graph/related.js';
import { fullGraphIndex, cancelProjectGraphDirty } from '../../graph/indexer.js';
import { getEventBus } from '../event-bus.js';

/**
 * 知识图谱 API（v1.2.0 链接基础设施 + v1.2.1 可视化/洞察）。
 *
 * 路由清单：
 * - GET  /api/graph?projects=1,2       — 多项目节点+边（聚合，全量）
 * - GET  /api/graph/stats?projects=    — 多项目统计（total + perProject）
 * - GET  /api/graph/orphans?projects=  — 孤立页列表（与 stats.orphans 同谓词）
 * - GET  /api/graph/broken?projects=   — 死链列表（status='broken' 行）
 * - GET  /api/graph/:id                — 单项目节点+边（?path= 子图 / ?mode=full 全量）
 * - GET  /api/graph/:id/backlinks?path=— 反向链接（入链）
 * - GET  /api/graph/:id/related?path=  — 相关文档（co-citation 评分）
 * - GET  /api/graph/:id/stats          — 节点/边/死链/孤立页统计
 * - POST /api/graph/:id/index          — 全量重建（后台执行，SSE 进度）
 *
 * 安全：path 走 validatePath（逃逸 403）；非法 :id / 项目不存在 404；
 * 查询只 join 表不触磁盘。由 createApp 挂载（Electron 与 CLI 同源）。
 *
 * 注册顺序敏感：聚合路由必须位于 GET /api/graph/:id 之前，
 * 否则 'stats'/'orphans'/'broken' 会被 :id 参数吞掉（路由测试守护）。
 */

/** 全量模式节点/边上限（5000 节点验收远低于此；超出置 truncated 标志） */
const FULL_NODE_CAP = 20000;
const FULL_EDGE_CAP = 200000;

/** 聚合/列表路由最多接受的项目数（防 IN 占位符超 SQLite 上限 32766） */
const MAX_PROJECT_IDS = 100;

/** 严格正整数解析：`1.5`/`1e2`/`-1`/`abc` → null（防 parseInt 静默截断） */
function parseIntStrict(v: string): number | null {
  if (!/^\d+$/.test(v)) return null;
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
}

/** limit 参数：严格解析 + 下界 1 + 上界 cap（负值/非法回退默认；防 SQLite LIMIT -N 无上限） */
function parseLimit(raw: unknown, def: number, cap: number): number {
  const n = parseIntStrict(String(raw ?? ''));
  if (n === null) return def;
  return Math.min(n, cap);
}

/** tags 字段防御性解析（坏数据 → []，'null' → []） */
function parseTags(raw: string | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

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

/** projects 参数解析：缺参 → null；格式非法/超上限 → []（调用方决定 400/404） */
function parseProjectIds(req: Request): number[] | null {
  const raw = String(req.query.projects ?? '');
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length > MAX_PROJECT_IDS) return [];
  const ids: number[] = [];
  for (const s of parts) {
    const n = parseIntStrict(s.trim());
    if (n === null) return []; // 任一非法 → 整体无效
    if (ids.indexOf(n) < 0) ids.push(n); // 去重（COUNT 校验会拒绝重复）
  }
  return ids;
}

/** 全部项目存在校验（COUNT 相等） */
function projectIdsExist(ids: number[]): boolean {
  const ph = Array.from({ length: ids.length }, () => '?').join(',');
  const row = getConnection()
    .prepare(`SELECT COUNT(*) AS c FROM projects WHERE id IN (${ph})`)
    .get(...ids) as { c: number } | undefined;
  return (row?.c ?? 0) === ids.length;
}

/** 聚合路由守卫：缺参 400；非法格式/含不存在项目 404；合法返回 id 列表 */
function parseAggregateProjects(req: Request, res: Response): number[] | null {
  const ids = parseProjectIds(req);
  if (ids === null) {
    res.status(400).json({ error: 'projects parameter is required' });
    return null;
  }
  if (ids.length === 0 || !projectIdsExist(ids)) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return ids;
}

export function registerGraphRoutes(app: Express): void {
  const db = getConnection;

  // ══ 聚合图谱（多项目，二阶段可视化 + 洞察）══
  // 注意：必须注册在 GET /api/graph/:id 之前（顺序敏感，见文件头注释）

  // ── GET /api/graph?projects=1,2 — 多项目节点 + 边（全量，受 FULL caps 约束）──
  app.get('/api/graph', (req: Request, res: Response) => {
    const ids = parseAggregateProjects(req, res);
    if (!ids) return;
    // 聚合同样应用 FULL caps。LIMIT CAP+1 探测截断（恰好 CAP 条 ≠ 超限），
    // 响应再 slice 回 CAP —— 修复前无 LIMIT 会序列化 50 万边 ≈ 100MB JSON
    const nodes = queryGraphNodes(db(), ids, { limit: FULL_NODE_CAP + 1 });
    const nodeTruncated = nodes.length > FULL_NODE_CAP;
    const cappedNodes = nodeTruncated ? nodes.slice(0, FULL_NODE_CAP) : nodes;
    const nodeSet = new Set(cappedNodes.map((n) => `${n.project_id}:${n.path}`));
    const edges = queryGraphEdges(db(), ids, { limit: FULL_EDGE_CAP + 1 }).filter(
      (e) =>
        nodeSet.has(`${e.project_id}:${e.source}`) && nodeSet.has(`${e.project_id}:${e.target}`),
    );
    const edgeTruncated = edges.length > FULL_EDGE_CAP;
    res.json({
      projects: ids,
      nodes: cappedNodes.map((n) => ({ ...n, tags: parseTags(n.tags) })),
      edges: edgeTruncated ? edges.slice(0, FULL_EDGE_CAP) : edges,
      truncated: nodeTruncated || edgeTruncated,
    });
  });

  // ── GET /api/graph/stats?projects= — 多项目统计 ──
  app.get('/api/graph/stats', (req: Request, res: Response) => {
    const ids = parseAggregateProjects(req, res);
    if (!ids) return;
    res.json({ projects: ids, ...getGraphStatsMulti(db(), ids) });
  });

  // ── GET /api/graph/orphans?projects=&limit=&offset= — 孤立页列表 ──
  app.get('/api/graph/orphans', (req: Request, res: Response) => {
    const ids = parseAggregateProjects(req, res);
    if (!ids) return;
    const limit = parseLimit(req.query.limit, 200, 10000);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
    const { rows, total } = queryOrphans(db(), ids, { limit, offset });
    res.json({ projects: ids, orphans: rows, total });
  });

  // ── GET /api/graph/broken?projects=&limit=&offset= — 死链列表 ──
  app.get('/api/graph/broken', (req: Request, res: Response) => {
    const ids = parseAggregateProjects(req, res);
    if (!ids) return;
    const limit = parseLimit(req.query.limit, 100, 500);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
    const { rows, total } = queryBrokenLinks(db(), ids, { limit, offset });
    res.json({ projects: ids, broken: rows, total });
  });

  // ── GET /api/graph/:id — 节点 + 边 ──
  app.get('/api/graph/:id', (req: Request, res: Response) => {
    const projectId = parseIntStrict(String(req.params.id));
    if (projectId === null || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const root = projectPath(projectId)!;
    const subPath = safeRelPath(req, root);
    if (subPath === null) {
      res.status(403).json({ error: 'Invalid path' });
      return;
    }

    // 全量模式（可视化页用）：全部节点 + resolved 边，忽略 ?path=
    if (req.query.mode === 'full') {
      // LIMIT CAP+1 探测截断（恰好 CAP 条 ≠ 超限），响应 slice 回 CAP
      const nodes = db()
        .prepare(
          `SELECT m.file_path AS path, m.title, m.tags
           FROM doc_meta m
           WHERE m.project_id = ?
           ORDER BY m.file_path
           LIMIT ?`,
        )
        .all(projectId, FULL_NODE_CAP + 1) as Array<{ path: string; title: string; tags: string }>;
      const nodeTruncated = nodes.length > FULL_NODE_CAP;
      const cappedNodes = nodeTruncated ? nodes.slice(0, FULL_NODE_CAP) : nodes;
      const nodeSet = new Set(cappedNodes.map((n) => n.path));
      const edges = db()
        .prepare(
          `SELECT from_path AS source, to_path AS target, link_type, anchor
           FROM doc_links
           WHERE project_id = ? AND status = 'resolved' AND from_path IN (
             SELECT file_path FROM doc_meta WHERE project_id = ?
           )
           ORDER BY from_path
           LIMIT ?`,
        )
        .all(projectId, projectId, FULL_EDGE_CAP + 1) as Array<{
        source: string;
        target: string;
        link_type: string;
        anchor: string;
      }>;
      const edgeTruncated = edges.length > FULL_EDGE_CAP;
      res.json({
        nodes: cappedNodes.map((n) => ({ ...n, tags: parseTags(n.tags) })),
        edges: edgeTruncated
          ? edges
              .filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target))
              .slice(0, FULL_EDGE_CAP)
          : edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target)),
        projectId,
        truncated: nodeTruncated || edgeTruncated,
      });
      return;
    }

    const limit = parseLimit(req.query.limit, 2000, 2000);
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
      .all(projectId, subPath, subPath, subPath, subPath, limit + 1) as Array<{
      path: string;
      title: string;
      tags: string;
    }>;
    // LIMIT+1 探测截断：恰好 limit 条 ≠ 超限（修复前 >= 误报）
    const nodeTruncated = nodes.length > limit;
    const cappedNodes = nodeTruncated ? nodes.slice(0, limit) : nodes;
    const nodeSet = new Set(cappedNodes.map((n) => n.path));
    // 边查询限定 1-hop 端点集（占位符 IN），而非全项目窗口截断——
    // 修复前 >8000 边项目按 from_path 扫描序取窗口，锚点子图边静默缺失。
    // 空 subPath（全图子图模式）时退化为主键扫描（沿用原语义）。
    const nodePaths = Array.from(nodeSet);
    let edges: Array<{ source: string; target: string; link_type: string; anchor: string }>;
    if (subPath && nodePaths.length > 0) {
      const ph = nodePaths.map(() => '?').join(',');
      edges = db()
        .prepare(
          `SELECT from_path AS source, to_path AS target, link_type, anchor
           FROM doc_links
           WHERE project_id = ? AND status = 'resolved'
             AND from_path IN (${ph}) AND to_path IN (${ph})
           LIMIT ?`,
        )
        .all(projectId, ...nodePaths, ...nodePaths, FULL_EDGE_CAP) as Array<{
        source: string;
        target: string;
        link_type: string;
        anchor: string;
      }>;
    } else {
      edges = db()
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
    }
    res.json({
      nodes: cappedNodes.map((n) => ({ ...n, tags: parseTags(n.tags) })),
      edges: edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target)),
      projectId,
      truncated: nodeTruncated, // 节点数超限（LIMIT 命中探测）
    });
  });

  // ── GET /api/graph/:id/backlinks — 反向链接 ──
  app.get('/api/graph/:id/backlinks', (req: Request, res: Response) => {
    const projectId = parseIntStrict(String(req.params.id));
    if (projectId === null || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const root = projectPath(projectId)!;
    const rel = safeRelPath(req, root);
    if (rel === null) {
      res.status(403).json({ error: 'Invalid path' });
      return;
    }
    const limit = parseLimit(req.query.limit, 50, 200);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
    const backlinks = queryBacklinks(db(), projectId, rel, { limit, offset });
    res.json({ path: rel, backlinks });
  });

  // ── GET /api/graph/:id/related — 相关文档 ──
  app.get('/api/graph/:id/related', (req: Request, res: Response) => {
    const projectId = parseIntStrict(String(req.params.id));
    if (projectId === null || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const root = projectPath(projectId)!;
    const rel = safeRelPath(req, root);
    if (rel === null) {
      res.status(403).json({ error: 'Invalid path' });
      return;
    }
    const limit = parseLimit(req.query.limit, 5, 20);
    const related = relatedDocs(projectId, rel, limit);
    res.json({ path: rel, related });
  });

  // ── GET /api/graph/:id/stats — 统计 ──
  app.get('/api/graph/:id/stats', (req: Request, res: Response) => {
    const projectId = parseIntStrict(String(req.params.id));
    if (projectId === null || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ projectId, ...getGraphStats(db(), projectId) });
  });

  // ── POST /api/graph/:id/index — 全量重建（后台，SSE 进度）──
  app.post('/api/graph/:id/index', (req: Request, res: Response) => {
    const projectId = parseIntStrict(String(req.params.id));
    if (projectId === null || !projectExists(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const root = projectPath(projectId)!;
    // 立即触发（不等去抖）：重建进度经 event-bus 广播（graph:index-progress）。
    // 取消挂起的脏标记计时器——修复前 markProjectGraphDirty 5s 后触发
    // 第二次全量重建（10k 文件 ≈ 20-30s ×2 的重复工作）。
    cancelProjectGraphDirty(projectId);
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

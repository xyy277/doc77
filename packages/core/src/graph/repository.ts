import type { DatabaseCompat } from '../db/connection.js';
import { getConnection } from '../db/connection.js';
import type { ExtractedLink } from './link-extractor.js';

/**
 * 知识图谱数据访问层（v1.2.0）。
 *
 * 表结构见 migrations.ts GRAPH_SCHEMA_SQL（v15）：
 * doc_meta（节点属性）+ doc_links（有向边，status 区分 resolved/broken）。
 * 反向链接 = doc_links 按 to_path 聚合查询，无单独表。
 */

export interface DocMetaRow {
  project_id: number;
  file_path: string;
  title: string;
  aliases: string[];
  tags: string[];
  file_hash: string;
  file_mtime: string | null;
  file_size: number;
}

export interface LinkRow {
  project_id: number;
  from_path: string;
  to_path: string;
  link_type: string;
  anchor: string;
  status: string;
  display: string;
  updated_at: string;
}

export interface BacklinkRow {
  from_path: string;
  title: string;
  link_type: string;
  anchor: string;
  updated_at: string;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  broken: number;
  orphans: number;
}

/** 多项目图谱节点（tags 为原始 JSON 字符串，路由层解析） */
export interface GraphNodeRow {
  project_id: number;
  path: string;
  title: string;
  tags: string;
}

/** 多项目图谱边（resolved only） */
export interface GraphEdgeRow {
  project_id: number;
  source: string;
  target: string;
  link_type: string;
  anchor: string;
}

export interface OrphanRow {
  project_id: number;
  path: string;
  title: string;
}

export interface BrokenLinkRow {
  project_id: number;
  from_path: string;
  to_path: string;
  display: string;
  anchor: string;
  updated_at: string;
}

/** 多项目统计：perProject 分项 + total 求和 */
export interface MultiGraphStats {
  total: GraphStats;
  perProject: Array<{ project_id: number } & GraphStats>;
}

export interface PagedRows<T> {
  rows: T[];
  total: number;
}

export function upsertDocMeta(db: DatabaseCompat, projectId: number, meta: DocMetaRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO doc_meta
       (project_id, file_path, title, aliases, tags, file_hash, file_mtime, file_size, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    projectId,
    meta.file_path,
    meta.title,
    JSON.stringify(meta.aliases),
    JSON.stringify(meta.tags),
    meta.file_hash,
    meta.file_mtime,
    meta.file_size,
  );
}

/** 替换某文件的全部出链（调用方包事务）：删旧插新，死链以 status='broken' 入库 */
export function replaceFileLinks(
  db: DatabaseCompat,
  projectId: number,
  fromPath: string,
  links: ExtractedLink[],
): void {
  db.prepare('DELETE FROM doc_links WHERE project_id = ? AND from_path = ?').run(
    projectId,
    fromPath,
  );
  const insert = db.prepare(
    `INSERT OR REPLACE INTO doc_links
       (project_id, from_path, to_path, link_type, anchor, status, display, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  );
  for (const link of links) {
    // 死链：to_path 存规范化目标 key（wikilink 存标题原文，relative 存归一化路径）
    const toKey = link.toPath ?? normalizeBrokenKey(link);
    insert.run(
      projectId,
      fromPath,
      toKey,
      link.linkType,
      link.anchor,
      link.toPath ? 'resolved' : 'broken',
      link.display,
    );
  }
}

/** 死链的规范化 key（避免与真实路径撞 PK 的语义：死链非真实路径） */
function normalizeBrokenKey(link: ExtractedLink): string {
  const raw = link.raw
    .replace(/^!?\[\[/, '')
    .replace(/\]\]$/, '')
    .split('|')[0]
    .trim();
  return link.linkType === 'wikilink' ? raw : link.raw;
}

/** 删除文件图谱：删 meta + 出链；入链（resolved → broken） */
export function deleteFileGraph(db: DatabaseCompat, projectId: number, filePath: string): void {
  db.prepare('DELETE FROM doc_meta WHERE project_id = ? AND file_path = ?').run(
    projectId,
    filePath,
  );
  db.prepare('DELETE FROM doc_links WHERE project_id = ? AND from_path = ?').run(
    projectId,
    filePath,
  );
  db.prepare(
    `UPDATE doc_links SET status = 'broken', updated_at = datetime('now')
     WHERE project_id = ? AND to_path = ? AND status = 'resolved'`,
  ).run(projectId, filePath);
}

/** 重命名：出链/入链/doc_meta 路径跟随（近似语义：所有指向旧路径的边更新） */
export function renameFileGraph(
  db: DatabaseCompat,
  projectId: number,
  oldPath: string,
  newPath: string,
): void {
  db.prepare(
    "UPDATE doc_meta SET file_path = ?, indexed_at = datetime('now') WHERE project_id = ? AND file_path = ?",
  ).run(newPath, projectId, oldPath);
  db.prepare('UPDATE doc_links SET from_path = ? WHERE project_id = ? AND from_path = ?').run(
    newPath,
    projectId,
    oldPath,
  );
  db.prepare('UPDATE doc_links SET to_path = ? WHERE project_id = ? AND to_path = ?').run(
    newPath,
    projectId,
    oldPath,
  );
}

/** 某文件的入链（反向链接） */
export function queryBacklinks(
  db: DatabaseCompat,
  projectId: number,
  toPath: string,
  opts: { limit?: number; offset?: number } = {},
): BacklinkRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = opts.offset ?? 0;
  return db
    .prepare(
      `SELECT l.from_path, m.title, l.link_type, l.anchor, l.updated_at
       FROM doc_links l
       LEFT JOIN doc_meta m ON m.project_id = l.project_id AND m.file_path = l.from_path
       WHERE l.project_id = ? AND l.to_path = ? AND l.status = 'resolved'
       ORDER BY l.updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(projectId, toPath, limit, offset) as unknown as BacklinkRow[];
}

/** 某文件的出链 */
export function queryOutlinks(db: DatabaseCompat, projectId: number, fromPath: string): LinkRow[] {
  return db
    .prepare(
      `SELECT * FROM doc_links WHERE project_id = ? AND from_path = ? AND status = 'resolved'`,
    )
    .all(projectId, fromPath) as unknown as LinkRow[];
}

/**
 * 孤儿谓词（与 getGraphStats.orphans / queryOrphans 共享）：
 * 无出链（任意 status）+ 无 resolved 入链。抽为常量保证计数与列表永远一致。
 */
const ORPHAN_PREDICATE_SQL = `
  AND NOT EXISTS (SELECT 1 FROM doc_links l WHERE l.project_id = m.project_id AND l.from_path = m.file_path)
  AND NOT EXISTS (SELECT 1 FROM doc_links l WHERE l.project_id = m.project_id AND l.to_path = m.file_path AND l.status = 'resolved')`;

/** IN 占位符生成（空数组调用方应提前返回——SQLite IN () 为语法错误） */
function inPlaceholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/** 图谱统计（nodes/edges/broken/orphans —— 孤立页 = 无出链无入链的节点） */
export function getGraphStats(db: DatabaseCompat, projectId: number): GraphStats {
  const count = (sql: string): number => {
    const row = db.prepare(sql).get(projectId) as { c: number } | undefined;
    return row?.c ?? 0;
  };
  return {
    nodes: count('SELECT COUNT(*) AS c FROM doc_meta WHERE project_id = ?'),
    edges: count(
      `SELECT COUNT(*) AS c FROM doc_links WHERE project_id = ? AND status = 'resolved'`,
    ),
    broken: count(`SELECT COUNT(*) AS c FROM doc_links WHERE project_id = ? AND status = 'broken'`),
    orphans: count(
      `SELECT COUNT(*) AS c FROM doc_meta m
       WHERE m.project_id = ?${ORPHAN_PREDICATE_SQL}`,
    ),
  };
}

/** 多项目节点（全量图谱数据；tags 为原始 JSON 字符串，路由层解析） */
export function queryGraphNodes(
  db: DatabaseCompat,
  projectIds: number[],
  opts?: { limit?: number },
): GraphNodeRow[] {
  if (projectIds.length === 0) return [];
  const ph = inPlaceholders(projectIds.length);
  const limitClause = opts?.limit ? ` LIMIT ${Math.max(1, opts.limit)}` : '';
  return db
    .prepare(
      `SELECT m.project_id, m.file_path AS path, m.title, m.tags
       FROM doc_meta m
       WHERE m.project_id IN (${ph})
       ORDER BY m.project_id, m.file_path${limitClause}`,
    )
    .all(...projectIds) as unknown as GraphNodeRow[];
}

/**
 * 多项目 resolved 边（全量图谱数据）。
 * 源文件必须存在于 doc_meta（与 /api/graph/:id 同语义）；
 * 相关子查询命中 doc_meta 主键索引 (project_id, file_path)。
 */
export function queryGraphEdges(
  db: DatabaseCompat,
  projectIds: number[],
  opts?: { limit?: number },
): GraphEdgeRow[] {
  if (projectIds.length === 0) return [];
  const ph = inPlaceholders(projectIds.length);
  const limitClause = opts?.limit ? ` LIMIT ${Math.max(1, opts.limit)}` : '';
  return db
    .prepare(
      `SELECT l.project_id, l.from_path AS source, l.to_path AS target, l.link_type, l.anchor
       FROM doc_links l
       WHERE l.status = 'resolved'
         AND l.project_id IN (${ph})
         AND l.from_path IN (
           SELECT m2.file_path FROM doc_meta m2
           WHERE m2.project_id = l.project_id AND m2.project_id IN (${ph})
         )
       ORDER BY l.project_id, l.from_path${limitClause}`,
    )
    .all(...projectIds, ...projectIds) as unknown as GraphEdgeRow[];
}

/** 多项目统计：perProject 分项（零填充）+ total 求和，与 getGraphStats 同谓词 */
export function getGraphStatsMulti(db: DatabaseCompat, projectIds: number[]): MultiGraphStats {
  if (projectIds.length === 0) {
    return { total: { nodes: 0, edges: 0, broken: 0, orphans: 0 }, perProject: [] };
  }
  const ph = inPlaceholders(projectIds.length);
  const byProject = (sql: string): Array<{ project_id: number; c: number }> =>
    db.prepare(sql).all(...projectIds) as unknown as Array<{ project_id: number; c: number }>;
  const agg = (rows: Array<{ project_id: number; c: number }>): Map<number, number> =>
    new Map(rows.map((r) => [r.project_id, r.c]));
  const nodes = agg(
    byProject(
      `SELECT m.project_id, COUNT(*) AS c FROM doc_meta m WHERE m.project_id IN (${ph}) GROUP BY m.project_id`,
    ),
  );
  const edges = agg(
    byProject(
      `SELECT l.project_id, COUNT(*) AS c FROM doc_links l WHERE l.project_id IN (${ph}) AND l.status = 'resolved' GROUP BY l.project_id`,
    ),
  );
  const broken = agg(
    byProject(
      `SELECT l.project_id, COUNT(*) AS c FROM doc_links l WHERE l.project_id IN (${ph}) AND l.status = 'broken' GROUP BY l.project_id`,
    ),
  );
  const orphans = agg(
    byProject(
      `SELECT m.project_id, COUNT(*) AS c FROM doc_meta m WHERE m.project_id IN (${ph})${ORPHAN_PREDICATE_SQL} GROUP BY m.project_id`,
    ),
  );
  const perProject = projectIds.map((pid) => ({
    project_id: pid,
    nodes: nodes.get(pid) ?? 0,
    edges: edges.get(pid) ?? 0,
    broken: broken.get(pid) ?? 0,
    orphans: orphans.get(pid) ?? 0,
  }));
  const sum = (key: 'nodes' | 'edges' | 'broken' | 'orphans'): number =>
    perProject.reduce((acc, p) => acc + p[key], 0);
  return {
    total: {
      nodes: sum('nodes'),
      edges: sum('edges'),
      broken: sum('broken'),
      orphans: sum('orphans'),
    },
    perProject,
  };
}

/** 孤立页列表（谓词与 stats.orphans 一致；limit 默认 200，clamp 10000） */
export function queryOrphans(
  db: DatabaseCompat,
  projectIds: number[],
  opts: { limit?: number; offset?: number } = {},
): PagedRows<OrphanRow> {
  if (projectIds.length === 0) return { rows: [], total: 0 };
  const ph = inPlaceholders(projectIds.length);
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 10000));
  const offset = opts.offset ?? 0;
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM doc_meta m WHERE m.project_id IN (${ph})${ORPHAN_PREDICATE_SQL}`,
    )
    .get(...projectIds) as { c: number } | undefined;
  const rows = db
    .prepare(
      `SELECT m.project_id, m.file_path AS path, m.title
       FROM doc_meta m
       WHERE m.project_id IN (${ph})${ORPHAN_PREDICATE_SQL}
       ORDER BY m.project_id, m.file_path
       LIMIT ? OFFSET ?`,
    )
    .all(...projectIds, limit, offset) as unknown as OrphanRow[];
  return { rows, total: totalRow?.c ?? 0 };
}

/** 死链列表（status='broken' 的行；to_path 为规范化目标 key；limit 默认 100，clamp 500） */
export function queryBrokenLinks(
  db: DatabaseCompat,
  projectIds: number[],
  opts: { limit?: number; offset?: number } = {},
): PagedRows<BrokenLinkRow> {
  if (projectIds.length === 0) return { rows: [], total: 0 };
  const ph = inPlaceholders(projectIds.length);
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const offset = opts.offset ?? 0;
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM doc_links WHERE project_id IN (${ph}) AND status = 'broken'`,
    )
    .get(...projectIds) as { c: number } | undefined;
  const rows = db
    .prepare(
      `SELECT project_id, from_path, to_path, display, anchor, updated_at
       FROM doc_links
       WHERE project_id IN (${ph}) AND status = 'broken'
       ORDER BY updated_at DESC, project_id, from_path
       LIMIT ? OFFSET ?`,
    )
    .all(...projectIds, limit, offset) as unknown as BrokenLinkRow[];
  return { rows, total: totalRow?.c ?? 0 };
}

/** 便捷包装（默认连接） */
export function withConn<T>(fn: (db: DatabaseCompat) => T): T {
  return fn(getConnection());
}

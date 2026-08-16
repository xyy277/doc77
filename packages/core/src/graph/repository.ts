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
  const limit = Math.min(opts.limit ?? 50, 200);
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
       WHERE m.project_id = ?
         AND NOT EXISTS (SELECT 1 FROM doc_links l WHERE l.project_id = m.project_id AND l.from_path = m.file_path)
         AND NOT EXISTS (SELECT 1 FROM doc_links l WHERE l.project_id = m.project_id AND l.to_path = m.file_path AND l.status = 'resolved')`,
    ),
  };
}

/** 便捷包装（默认连接） */
export function withConn<T>(fn: (db: DatabaseCompat) => T): T {
  return fn(getConnection());
}

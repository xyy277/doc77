import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { DatabaseCompat } from '../db/connection.js';
import { getConnection } from '../db/connection.js';
import { walkDir, isTextFile } from '../search/indexer.js';
import { extractLinksFromContent, createLinkResolver } from './link-extractor.js';
import { extractDocMeta } from './frontmatter.js';
import { upsertDocMeta, replaceFileLinks, withConn } from './repository.js';

/**
 * 知识图谱批量索引（v1.2.0）。
 *
 * 增量模式完全复刻 FTS indexer（search/indexer.ts）：
 * file_hash（sha256 前 16 位）短路跳过未变更文件；
 * 全量重建 = walkDir 一次遍历 + 100 条/事务 + setTimeout(0) 让出，
 * 末尾清理不存在文件（死链自愈）。
 */

// 批大小影响事件循环停顿：100 文件/批在真实项目可达 ~100ms 阻塞
// （性能测试实测 95ms）—— 40/批把单次停顿压到 ~40ms（1.1.3 事件循环
// 冻结教训的量化约束：全量重建期间 UI/API 不应可感知卡顿）
const BATCH_SIZE = 40;

function fileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function readTextSafe(absPath: string): string | null {
  try {
    if (!isTextFile(absPath)) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

export interface GraphIndexProgress {
  total: number;
  processed: number;
}

/**
 * 增量索引单个文件（hash 短路）。返回是否实际重建了该文件的图谱。
 * 由保存挂点 / watcher 调用，文件已写入磁盘。
 */
export function indexFileLinks(
  projectId: number,
  projectRoot: string,
  relPath: string,
  db?: DatabaseCompat,
): boolean {
  const conn = db ?? getConnection();
  const absPath = path.join(projectRoot, relPath);
  // 仅索引 markdown 家族文档（图谱节点是文档；代码文件不产生节点/边）
  if (!/\.(md|mdx|markdown)$/i.test(relPath)) return false;
  if (!fs.existsSync(absPath) || !isTextFile(absPath)) {
    // 文件不存在/非文本：清掉它的图谱（删除路径触发）
    deleteFileGraphFromIndex(conn, projectId, relPath);
    return false;
  }
  const content = readTextSafe(absPath);
  if (content === null) return false;

  const hash = fileHash(content);
  const meta = conn
    .prepare('SELECT file_hash FROM doc_meta WHERE project_id = ? AND file_path = ?')
    .get(projectId, relPath) as { file_hash: string } | undefined;
  if (meta && meta.file_hash === hash) return false; // 未变更，短路

  const docMeta = extractDocMeta(content, relPath);
  const stats = fs.statSync(absPath);
  upsertDocMeta(conn, projectId, {
    project_id: projectId,
    file_path: relPath,
    title: docMeta.title,
    aliases: docMeta.aliases,
    tags: docMeta.tags,
    file_hash: hash,
    file_mtime: stats.mtime.toISOString(),
    file_size: stats.size,
  });

  const links = extractLinksFromContent(content, relPath, createLinkResolver(projectRoot));
  replaceFileLinks(conn, projectId, relPath, links);
  return true;
}

/** 从索引移除文件（删除路径） */
export function deleteFileGraphFromIndex(
  db: DatabaseCompat,
  projectId: number,
  relPath: string,
): void {
  db.prepare('DELETE FROM doc_meta WHERE project_id = ? AND file_path = ?').run(projectId, relPath);
  db.prepare('DELETE FROM doc_links WHERE project_id = ? AND from_path = ?').run(
    projectId,
    relPath,
  );
  db.prepare(
    `UPDATE doc_links SET status = 'broken', updated_at = datetime('now')
     WHERE project_id = ? AND to_path = ? AND status = 'resolved'`,
  ).run(projectId, relPath);
}

/**
 * 全量重建项目图谱。批处理 + 让出事件循环；返回处理统计。
 * 末尾清理磁盘上已不存在的 doc_meta 与指向不存在文件的边（死链自愈）。
 */
export async function fullGraphIndex(
  projectId: number,
  projectRoot: string,
  onProgress?: (p: GraphIndexProgress) => void,
  db?: DatabaseCompat,
): Promise<GraphIndexProgress> {
  const conn = db ?? getConnection();
  const relFiles = walkDir(projectRoot, projectRoot);
  // 仅索引 markdown 家族（walkDir 返回全部文件，代码文件不产生图谱节点）
  const mdFiles = relFiles.filter((rel) => /\.(md|mdx|markdown)$/i.test(rel));
  const total = mdFiles.length;
  let processed = 0;

  // 两级短路（对齐 indexFileLinks）：一次读全量 meta 建 Map。
  // 1) 快速短路：mtime+size 未变 → 不读文件内容（stat 元数据廉价，
  //    10k 文件核对从"读全部内容 + sha256"（10-30s IO 风暴）降到 <1s）
  // 2) 内容级短路：mtime 变了但内容 hash 相同 → 不重写 DB（hash 兜底）
  // 修复前每次启动/脏标记都无条件重读全部 md 并重写全部 doc_meta/doc_links
  //（10k 文件 20-30s 单核满负荷 = 常驻 CPU ~10% + 全 API 拖慢的来源）。
  const existingMeta = new Map<string, { hash: string; mtime: string; size: number }>();
  const metaRows = conn
    .prepare(
      'SELECT file_path, file_hash, file_mtime, file_size FROM doc_meta WHERE project_id = ?',
    )
    .all(projectId) as Array<{
    file_path: string;
    file_hash: string | null;
    file_mtime: string | null;
    file_size: number;
  }>;
  for (const row of metaRows) {
    if (row.file_hash && row.file_mtime) {
      existingMeta.set(row.file_path, {
        hash: row.file_hash,
        mtime: row.file_mtime,
        size: row.file_size,
      });
    }
  }

  const resolver = createLinkResolver(
    projectRoot,
    relFiles.map((r) => path.join(projectRoot, r)),
  );

  // 仅索引 markdown 家族（walkDir 返回全部文件，代码文件不产生图谱节点）
  for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
    const batch = mdFiles.slice(i, i + BATCH_SIZE);
    const tx = conn.transaction(() => {
      for (const rel of batch) {
        const abs = path.join(projectRoot, rel);
        let stats: fs.Stats;
        try {
          stats = fs.statSync(abs);
        } catch {
          continue;
        }
        const existing = existingMeta.get(rel);
        // 快速短路：mtime+size 未变 → 内容未变（业界标准增量策略），
        // 不读文件内容不算 hash。mtime 被恢复/伪造 + 内容同长同改才会
        // 漏检，可接受（下次内容变更会正常触发）。
        if (
          existing &&
          existing.mtime === stats.mtime.toISOString() &&
          existing.size === stats.size
        ) {
          processed++; // 已核对；进度仍单调推进
          continue;
        }
        const content = readTextSafe(abs);
        if (content === null) continue;
        const hash = fileHash(content);
        // 内容级短路：mtime 变了但内容 hash 相同（touch/属性变更）→ 不重写
        if (existing && existing.hash === hash) {
          processed++;
          continue;
        }
        const docMeta = extractDocMeta(content, rel);
        upsertDocMeta(conn, projectId, {
          project_id: projectId,
          file_path: rel,
          title: docMeta.title,
          aliases: docMeta.aliases,
          tags: docMeta.tags,
          file_hash: hash,
          file_mtime: stats.mtime.toISOString(),
          file_size: stats.size,
        });
        const links = extractLinksFromContent(content, rel, resolver);
        replaceFileLinks(conn, projectId, rel, links);
        processed++;
      }
    });
    tx();
    onProgress?.({ total, processed });
    // 让出事件循环（大项目不冻结 UI/API）
    await new Promise((r) => setTimeout(r, 0));
  }

  // 清理残留 doc_meta：全量重插只覆盖当前文件集，磁盘上已删除的文件的
  // meta 行不会出现在重插中，需显式清理。同时把指向已删除文件的 resolved
  // 边标记 broken —— 修复前靠"全部文件重写出链"隐式完成死链自愈；hash
  // 短路后未变更文件的边不再重写，必须显式处理（语义与 deleteFileGraphFromIndex 一致）
  const files = new Set(mdFiles);
  const stale = conn
    .prepare('SELECT file_path FROM doc_meta WHERE project_id = ?')
    .all(projectId) as Array<{ file_path: string }>;
  for (const s of stale) {
    if (!files.has(s.file_path)) {
      conn
        .prepare('DELETE FROM doc_meta WHERE project_id = ? AND file_path = ?')
        .run(projectId, s.file_path);
      conn
        .prepare(
          `UPDATE doc_links SET status = 'broken', updated_at = datetime('now')
           WHERE project_id = ? AND to_path = ? AND status = 'resolved'`,
        )
        .run(projectId, s.file_path);
    }
  }

  return { total, processed };
}

/** 清空项目全部图谱数据 */
export function clearProjectGraph(projectId: number, db?: DatabaseCompat): void {
  const conn = db ?? getConnection();
  conn.prepare('DELETE FROM doc_links WHERE project_id = ?').run(projectId);
  conn.prepare('DELETE FROM doc_meta WHERE project_id = ?').run(projectId);
}

/** 便捷包装 */
export function indexFileLinksSafe(projectId: number, projectRoot: string, relPath: string): void {
  try {
    withConn((db) => indexFileLinks(projectId, projectRoot, relPath, db));
  } catch {
    /* best-effort — 图谱缺失可降级 */
  }
}

// ── 脏标记调度（目录级变更等批量场景：去抖后后台全量重建）──

const dirtyTimers = new Map<number, ReturnType<typeof setTimeout>>();
const DIRTY_DEBOUNCE_MS = 5000;

/** 取消挂起的脏标记重建（手动 POST index 立即执行后调用，防 5s 后二次全量） */
export function cancelProjectGraphDirty(projectId: number): void {
  const existing = dirtyTimers.get(projectId);
  if (existing) {
    clearTimeout(existing);
    dirtyTimers.delete(projectId);
  }
}

/** 标记项目图谱为脏（目录删除/批量变更），5s 去抖后后台全量重建 */
export function markProjectGraphDirty(projectId: number): void {
  const existing = dirtyTimers.get(projectId);
  if (existing) clearTimeout(existing);
  dirtyTimers.set(
    projectId,
    setTimeout(() => {
      dirtyTimers.delete(projectId);
      try {
        const p = getConnection()
          .prepare('SELECT path FROM projects WHERE id = ?')
          .get(projectId) as { path: string } | undefined;
        if (p) fullGraphIndex(projectId, p.path).catch(() => {});
      } catch {
        /* best-effort */
      }
    }, DIRTY_DEBOUNCE_MS).unref?.(),
  );
}

/**
 * 启动后台逐项目全量重建（v15 迁移后自愈）。
 * 由 electron/server.ts 与 cli/bin/doc77.ts 在 runMigrations 后调用；
 * 延迟 0 让出事件循环，不阻塞启动；图谱缺失可降级，失败静默。
 */
export function bootstrapGraphIndexing(): void {
  setTimeout(async () => {
    try {
      const projects = getConnection().prepare('SELECT id, path FROM projects').all() as Array<{
        id: number;
        path: string;
      }>;
      // 修复前 for 不 await → 多项目并发全量重建（启动 CPU 峰值叠加）。
      // hash 短路后每项目主要成本是 walkDir 枚举，串行避免启动峰值。
      for (const p of projects) {
        try {
          await fullGraphIndex(p.id, p.path);
        } catch {
          /* 单项目失败不阻断后续 */
        }
      }
    } catch {
      /* best-effort */
    }
  }, 0).unref?.();
}

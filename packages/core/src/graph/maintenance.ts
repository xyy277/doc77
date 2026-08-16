import * as path from 'node:path';
import { getConnection } from '../db/connection.js';
import { indexFileLinks, deleteFileGraphFromIndex } from './indexer.js';
import { renameFileGraph } from './repository.js';

/**
 * 图谱事件挂点适配层（v1.2.0）。
 *
 * 由 REST 路由（保存/rename/delete）、watcher flush（外部变更兜底）调用。
 * 图谱是最终一致：失败静默降级（图谱缺失可降级显示）。
 */

/** 文件保存/新增/修改后增量索引 */
export function onFileSaved(projectId: number, projectRoot: string, relPath: string): void {
  try {
    indexFileLinks(projectId, projectRoot, relPath, getConnection());
  } catch {
    /* best-effort */
  }
}

/** 文件删除后清理图谱 */
export function onFileDeleted(projectId: number, relPath: string): void {
  try {
    deleteFileGraphFromIndex(getConnection(), projectId, relPath);
  } catch {
    /* best-effort */
  }
}

/** 重命名后：边与 meta 路径跟随 + 重提取（内容未变但 hash 刷新） */
export function onFileRenamed(
  projectId: number,
  projectRoot: string,
  oldPath: string,
  newPath: string,
): void {
  try {
    renameFileGraph(getConnection(), projectId, oldPath, newPath);
    onFileSaved(projectId, projectRoot, newPath);
  } catch {
    /* best-effort */
  }
}

/** 是否为可索引的 markdown 文档（图谱节点） */
export function isGraphDocument(relPath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(relPath);
}

/** watcher flush 事件 → 图谱增量（paths 为项目相对路径，含目录事件） */
export function onWatcherFlush(
  projectId: number,
  projectRoot: string,
  opType: string,
  paths: string[],
): void {
  for (const p of paths) {
    if (!isGraphDocument(p)) continue;
    if (opType === 'delete') {
      onFileDeleted(projectId, p);
    } else {
      onFileSaved(projectId, projectRoot, p);
    }
  }
}

/** 目录事件（unlinkDir/addDir）→ 该目录下全部文档需重扫：返回 true 时调用方应标记全量重建 */
export function isDirectoryEvent(p: string): boolean {
  return !/\.(md|mdx|markdown)$/i.test(p) && path.posix.extname(p) === '';
}

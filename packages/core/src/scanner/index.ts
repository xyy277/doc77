import * as path from 'node:path';
import * as fs from 'node:fs';
import { getConnection } from '../db/connection.js';
import { listDir, isSensitiveFile, type DirEntry } from '../fs/index.js';

export type { DirEntry };

export interface ScanResult {
  path: string;
  entries: DirEntry[];
  cached: boolean;
}

/**
 * 目录扫描缓存（进程内 Map）。
 *
 * 自 v1.1.4 起不再写入 filetree_cache 表：该表每次写都会触发 sql.js
 * 全内存 DB 的整库序列化（性能灾难放大器），且行数随目录数量无限膨胀。
 * 缓存本质是 mtime 校验的临时数据，重启后重建透明，无持久化需求。
 *
 * 校验策略（v1.1.4 F1）：单次目录 stat（O(1)）替代逐条目 statSync（O(N)，
 * WSL2 上 statSync 昂贵，原"缓存校验"≈重新扫描）。目录 mtime 覆盖
 * 增删/重命名；文件内容修改不改变目录 mtime —— 由 watcher 的
 * clearCache 精确失效兜底（SSE 客户端连接时 watcher 在运行）。
 *
 * 每项目 FIFO 容量上限防内存无限增长；多份 core 副本（Electron main 与
 * MCP 的 electron-modules）各自持一份 Map，分叉无害（mtime 校验兜底）。
 */
interface CacheEntry {
  entries: DirEntry[];
  /** 扫描时目录自身的 mtime（ISO 毫秒精度） */
  dirMtime: string;
  /** 条目数，与目录 mtime 互补：粗粒度文件系统（FAT 等）目录 mtime 可能不更新 */
  entryCount: number;
}

const _cache = new Map<string, CacheEntry>();
const MAX_ENTRIES_PER_PROJECT = 2000;
const _projectCounts = new Map<number, number>();

function cacheKey(projectId: number, nodePath: string): string {
  return projectId + '|' + nodePath;
}

/** 每项目超出上限时按插入序淘汰最旧条目（Map 迭代序即插入序）。 */
function evictIfOverflow(projectId: number): void {
  const count = _projectCounts.get(projectId) ?? 0;
  if (count < MAX_ENTRIES_PER_PROJECT) return;
  const prefix = projectId + '|';
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) {
      _cache.delete(key);
      _projectCounts.set(projectId, count - 1);
      return;
    }
  }
}

function putCache(projectId: number, nodePath: string, entry: CacheEntry): void {
  const key = cacheKey(projectId, nodePath);
  if (!_cache.has(key)) {
    evictIfOverflow(projectId);
    _projectCounts.set(projectId, (_projectCounts.get(projectId) ?? 0) + 1);
  }
  _cache.set(key, entry);
}

/**
 * Scan a directory within a project.
 * Uses lazy loading — only returns direct children.
 * Results are cached in memory with mtime-based invalidation.
 *
 * @param projectId - The project ID
 * @param dirPath - Relative path within the project ('' for root)
 */
export function scanDirectory(projectId: number, dirPath: string): ScanResult {
  // Normalize path
  const normalizedPath = dirPath.replace(/\\/g, '/').replace(/^\/+/, '');

  // Get project root path
  const project = getConnection()
    .prepare('SELECT path FROM projects WHERE id = ?')
    .get(projectId) as { path: string } | undefined;

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const absPath = normalizedPath ? path.join(project.path, normalizedPath) : project.path;

  // Check in-memory cache
  const cached = _cache.get(cacheKey(projectId, normalizedPath));
  if (cached && isCacheValid(absPath, cached)) {
    return { path: normalizedPath, entries: cached.entries, cached: true };
  }

  // Scan fresh
  const entries = listDir(absPath);
  let dirMtime = '';
  try {
    dirMtime = fs.statSync(absPath).mtime.toISOString();
  } catch {
    /* 目录不可访问 — 空 mtime 使缓存恒失效，下次请求重扫 */
  }

  putCache(projectId, normalizedPath, {
    entries,
    dirMtime,
    entryCount: entries.length,
  });

  return { path: normalizedPath, entries, cached: false };
}

/**
 * Clear cache for a specific project path, or entire project if no path given.
 */
export function clearCache(projectId: number, dirPath?: string): void {
  if (dirPath !== undefined) {
    const normalized = dirPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const key = cacheKey(projectId, normalized);
    if (_cache.delete(key)) {
      const count = _projectCounts.get(projectId);
      if (count !== undefined) _projectCounts.set(projectId, count - 1);
    }
  } else {
    const prefix = projectId + '|';
    for (const key of _cache.keys()) {
      if (key.startsWith(prefix)) _cache.delete(key);
    }
    _projectCounts.delete(projectId);
  }
}

/**
 * Check if the cached directory listing is still valid.
 * v1.1.4 (F1)：单次目录 stat + 条目数比对（O(1)），替代逐条目 statSync（O(N)）。
 */
function isCacheValid(absDirPath: string, cached: CacheEntry): boolean {
  try {
    const stats = fs.statSync(absDirPath);
    if (stats.mtime.toISOString() !== cached.dirMtime) return false;
  } catch {
    // Directory was removed or is inaccessible — cache invalid
    return false;
  }
  // Entry count check: catches add/remove even on coarse-mtime filesystems
  try {
    const nonIgnored = fs.readdirSync(absDirPath).filter((name) => !isSensitiveFile(name));
    return nonIgnored.length === cached.entryCount;
  } catch {
    return false;
  }
}

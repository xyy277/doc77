import * as path from 'node:path';
import * as fs from 'node:fs';
import { getConnection } from '../db/connection.js';
import { listDir, type DirEntry } from '../fs/index.js';

export type { DirEntry };

export interface ScanResult {
  path: string;
  entries: DirEntry[];
  cached: boolean;
}

/**
 * Scan a directory within a project.
 * Uses lazy loading — only returns direct children.
 * Results are cached in filetree_cache with mtime-based invalidation.
 *
 * @param projectId - The project ID
 * @param dirPath - Relative path within the project ('' for root)
 */
export function scanDirectory(projectId: number, dirPath: string): ScanResult {
  const db = getConnection();

  // Normalize path
  const normalizedPath = dirPath.replace(/\\/g, '/').replace(/^\/+/, '');

  // Get project root path
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const absPath = normalizedPath ? path.join(project.path, normalizedPath) : project.path;

  // Check cache
  const cached = db
    .prepare(
      'SELECT tree_json, mtime_map FROM filetree_cache WHERE project_id = ? AND node_path = ?',
    )
    .get(projectId, normalizedPath) as { tree_json: string; mtime_map: string | null } | undefined;

  if (cached) {
    const mtimeMap: Record<string, string> = cached.mtime_map ? JSON.parse(cached.mtime_map) : {};

    // Validate by stat'ing each cached file and comparing mtime
    if (isCacheValid(absPath, mtimeMap)) {
      const entries = JSON.parse(cached.tree_json) as DirEntry[];
      return { path: normalizedPath, entries, cached: true };
    }

    // Cache invalid — delete it
    db.prepare('DELETE FROM filetree_cache WHERE project_id = ? AND node_path = ?').run(
      projectId,
      normalizedPath,
    );
  }

  // Scan fresh
  const entries = listDir(absPath);

  // Build mtime map for future cache validation
  const mtimeMap: Record<string, string> = {};
  for (const entry of entries) {
    mtimeMap[entry.name] = entry.modified;
  }

  // Store in cache
  db.prepare(
    `INSERT OR REPLACE INTO filetree_cache (project_id, node_path, tree_json, mtime_map)
     VALUES (?, ?, ?, ?)`,
  ).run(projectId, normalizedPath, JSON.stringify(entries), JSON.stringify(mtimeMap));

  return { path: normalizedPath, entries, cached: false };
}

/**
 * Clear cache for a specific project path, or entire project if no path given.
 */
export function clearCache(projectId: number, dirPath?: string): void {
  const db = getConnection();

  if (dirPath !== undefined) {
    const normalized = dirPath.replace(/\\/g, '/').replace(/^\/+/, '');
    db.prepare('DELETE FROM filetree_cache WHERE project_id = ? AND node_path = ?').run(
      projectId,
      normalized,
    );
  } else {
    db.prepare('DELETE FROM filetree_cache WHERE project_id = ?').run(projectId);
  }
}

/**
 * Check if the cached directory listing is still valid.
 * Stats each file in the cached mtime_map and compares against actual mtime.
 */
function isCacheValid(absDirPath: string, cachedMtimeMap: Record<string, string>): boolean {
  for (const [name, cachedMtime] of Object.entries(cachedMtimeMap)) {
    try {
      const stats = fs.statSync(path.join(absDirPath, name));
      if (stats.mtime.toISOString() !== cachedMtime) {
        return false;
      }
    } catch {
      // File was removed or is inaccessible — cache invalid
      return false;
    }
  }
  return true;
}

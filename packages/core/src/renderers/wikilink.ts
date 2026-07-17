import * as path from 'node:path';
import * as fs from 'node:fs';
import { getConnection } from '../db/connection.js';

// Simple in-memory cache for project file lists (per project)
const fileListCache = new Map<number, { mtime: number; files: string[] }>();
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Get all markdown files in a project directory (cached).
 */
function getProjectFiles(projectId: number, projectRoot: string): string[] {
  const cached = fileListCache.get(projectId);
  if (cached && Date.now() - cached.mtime < CACHE_TTL_MS) {
    return cached.files;
  }
  const files: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip hidden directories and node_modules
          if (!entry.name.startsWith('.')) walk(fullPath);
        } else if (entry.name.endsWith('.md')) {
          files.push(fullPath);
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }
  walk(projectRoot);
  fileListCache.set(projectId, { mtime: Date.now(), files });
  return files;
}

/**
 * Parse alias map from .doc77links file.
 */
function loadAliasMap(projectRoot: string): Map<string, string> {
  const aliasFile = path.join(projectRoot, '.doc77links');
  const map = new Map<string, string>();
  try {
    const content = fs.readFileSync(aliasFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^(.+?)\s*(?:→|➜|\s*=\s*)\s*(.+)$/);
      if (match) {
        map.set(match[1].trim(), match[2].trim());
      }
    }
  } catch {
    /* .doc77links may not exist */
  }
  return map;
}

/**
 * Resolve a wikilink `[[title]]` to a file path relative to the project root.
 *
 * Algorithm:
 * 1. Check alias map (.doc77links)
 * 2. Exact match: title.md
 * 3. Case-insensitive match
 * 4. If not found, return null (dead link)
 */
export function resolveWikilink(
  title: string,
  projectId: number,
  projectRoot: string,
): string | null {
  const allFiles = getProjectFiles(projectId, projectRoot);

  // 1. Check alias map
  const aliasMap = loadAliasMap(projectRoot);
  const aliased = aliasMap.get(title);
  if (aliased) {
    const aliasPath = path.resolve(projectRoot, aliased);
    const relative = path.relative(projectRoot, aliasPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    if (allFiles.includes(aliasPath)) return aliasPath;
  }

  // 2. Exact match
  const targetFile = title.endsWith('.md') ? title : title + '.md';
  const exact = allFiles.find((f) => path.basename(f) === targetFile);
  if (exact) return exact;

  // 3. Case-insensitive match
  const lowerTarget = targetFile.toLowerCase();
  const ci = allFiles.find((f) => path.basename(f).toLowerCase() === lowerTarget);
  if (ci) return ci;

  // 4. Not found
  return null;
}

/**
 * Clear the file list cache for a project (call when files change).
 */
export function clearWikilinkCache(projectId?: number): void {
  if (projectId != null) {
    fileListCache.delete(projectId);
  } else {
    fileListCache.clear();
  }
}

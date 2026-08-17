import * as path from 'node:path';
import * as fs from 'node:fs';
import { walkDir } from '../search/indexer.js';

// 项目文件列表缓存（图谱提取层与渲染期共用的唯一缓存，v1.2.1 红队修复：
// 修复前渲染/图谱各自遍历，且图谱增量保存路径每次全树重扫）
const fileListCache = new Map<number, { mtime: number; files: string[] }>();
const CACHE_TTL_MS = 60_000; // 1 minute

// .doc77links 别名表缓存（按文件 mtime 失效，保存后自动重读）
const aliasCache = new Map<string, { mtimeMs: number; map: Map<string, string> }>();

/**
 * 获取项目全部文件（绝对路径，缓存的）。
 * v1.2.1 红队修复：改用 walkDir（跳过 node_modules/隐藏目录），与图谱
 * 提取层语义统一——node_modules 内 .md 不再作为 wikilink 目标（行为修复）。
 */
export function getProjectFiles(projectId: number, projectRoot: string): string[] {
  const cached = fileListCache.get(projectId);
  if (cached && Date.now() - cached.mtime < CACHE_TTL_MS) {
    return cached.files;
  }
  const files = walkDir(projectRoot, projectRoot).map((rel) =>
    path.join(projectRoot, rel.replace(/\//g, path.sep)),
  );
  fileListCache.set(projectId, { mtime: Date.now(), files });
  return files;
}

/**
 * 原地增删项目文件列表缓存（保存/重命名/删除路由挂点）。
 * 修复前无此能力：新建文件后 60s 内解析为死链；整清缓存又会让每次
 * 保存后的首次渲染重走全树遍历。
 */
export function updateFileListCache(
  projectId: number,
  opts: { added?: string[]; removed?: string[] },
): void {
  const cached = fileListCache.get(projectId);
  if (!cached) return;
  if (opts.removed?.length) {
    const removed = new Set(opts.removed);
    cached.files = cached.files.filter((f) => !removed.has(f));
  }
  if (opts.added?.length) {
    for (const f of opts.added) {
      if (!cached.files.includes(f)) cached.files.push(f);
    }
  }
}

/**
 * 解析 alias map from .doc77links file。
 * v1.2.1 红队修复：按文件 mtime 缓存——修复前每次 resolveWikilink 都
 * 重新读盘 .doc77links。
 */
export function loadAliasMap(projectRoot: string): Map<string, string> {
  const aliasFile = path.join(projectRoot, '.doc77links');
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(aliasFile).mtimeMs;
  } catch {
    /* .doc77links may not exist */
  }
  const cached = aliasCache.get(aliasFile);
  if (cached && cached.mtimeMs === mtimeMs) return cached.map;

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
  aliasCache.set(aliasFile, { mtimeMs, map });
  return map;
}

/** 清空缓存（测试与项目删除用） */
export function clearWikilinkCache(projectId?: number): void {
  if (projectId != null) {
    fileListCache.delete(projectId);
  } else {
    fileListCache.clear();
  }
  aliasCache.clear();
}

/** wikilink 解析索引：O(链接数×文件数) → O(链接数)（红队修复） */
export interface WikilinkIndex {
  /** basename（含 .md）→ 绝对路径（先到先得，与 find 语义一致） */
  resolve: (title: string) => string | null;
  /** 全部文件绝对路径集合（O(1) 存在性检查） */
  has: (absPath: string) => boolean;
}

/**
 * 构造 wikilink 解析索引（每文档渲染/每批提取构建一次，复用全部链接）。
 * exact/ci 均为 basename → 绝对路径 Map；allFileSet 供 fileExists O(1)。
 */
export function createWikilinkIndex(
  allFiles: string[],
  aliasMap: Map<string, string>,
  projectRoot: string,
): WikilinkIndex {
  const exact = new Map<string, string>();
  const ci = new Map<string, string>();
  const allFileSet = new Set<string>();
  for (const f of allFiles) {
    allFileSet.add(f);
    const base = path.basename(f);
    if (!exact.has(base)) exact.set(base, f);
    const lower = base.toLowerCase();
    if (!ci.has(lower)) ci.set(lower, f);
  }

  const resolve = (title: string): string | null => {
    // 1. Alias map
    const aliased = aliasMap.get(title);
    if (aliased) {
      const aliasPath = path.resolve(projectRoot, aliased);
      const relative = path.relative(projectRoot, aliasPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
      if (allFileSet.has(aliasPath)) return aliasPath;
    }
    // 2. Exact
    const targetFile = title.endsWith('.md') ? title : title + '.md';
    const exactHit = exact.get(targetFile);
    if (exactHit) return exactHit;
    // 3. Case-insensitive
    return ci.get(targetFile.toLowerCase()) ?? null;
  };

  return { resolve, has: (p) => allFileSet.has(p) };
}

/**
 * 解析 `[[title]]` 的纯函数核心（渲染期与图谱提取层共用）。
 *
 * Algorithm:
 * 1. Check alias map (.doc77links)
 * 2. Exact match: title.md
 * 3. Case-insensitive match
 * 4. If not found, return null (dead link)
 *
 * 保持线性扫描实现（纯函数基准，供测试与 createWikilinkIndex 对等验证）；
 * 批量场景用 createWikilinkIndex。
 */
export function resolveWikilinkIn(
  allFiles: string[],
  aliasMap: Map<string, string>,
  projectRoot: string,
  title: string,
): string | null {
  // 1. Check alias map
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
 * Resolve a wikilink `[[title]]` to a file path relative to the project root.
 * v1.2.1 红队修复：走索引（一次构建全部链接复用），loadAliasMap 带缓存。
 */
export function resolveWikilink(
  title: string,
  projectId: number,
  projectRoot: string,
): string | null {
  const idx = createWikilinkIndex(
    getProjectFiles(projectId, projectRoot),
    loadAliasMap(projectRoot),
    projectRoot,
  );
  return idx.resolve(title);
}

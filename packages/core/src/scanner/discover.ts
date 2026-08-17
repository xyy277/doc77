import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface DiscoverResult {
  name: string;
  path: string;
  hasReadme: boolean;
  mdCount: number;
}

/** Directories always skipped during discovery */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.svn',
  '.hg',
  '.venv',
  'venv',
  '.tox',
  'dist',
  '.cache',
  '.next',
  '.nuxt',
  'build',
  'target',
  '.terraform',
  '.serverless',
]);

/** Windows-specific system directories to skip */
const WIN_SYSTEM_DIRS = new Set([
  'AppData',
  'Application Data',
  'Cookies',
  'NetHood',
  'PrintHood',
  'Recent',
  'SendTo',
  'Start Menu',
  'Templates',
  'Local Settings',
  'My Documents',
  'My Music',
  'My Pictures',
  'My Videos',
  'Desktop',
  'Documents',
  'Downloads',
  'Music',
  'Pictures',
  'Videos',
  'Favorites',
  'Links',
  'Searches',
  'Contacts',
  'Saved Games',
  'OneDrive',
]);

/** Security: paths that are never allowed as scan roots */
const BLOCKED_ROOTS = new Set([
  '/',
  '/sys',
  '/proc',
  '/dev',
  '/etc',
  '/boot',
  '/run',
  '/bin',
  '/sbin',
  '/usr',
  '/var',
  '/tmp',
  '/lost+found',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System32',
]);

/**
 * Discover candidate projects under a root path.
 *
 * @param rootPath - Starting directory (supports ~ expansion)
 * @param maxDepth - Maximum recursion depth (default 2)
 * @param existingPaths - Set of already-registered project paths to exclude
 * @returns Discovered projects sorted by name
 */
export function discoverProjects(
  rootPath: string,
  maxDepth: number = 2,
  existingPaths: Set<string> = new Set(),
): DiscoverResult[] {
  // Expand ~
  if (rootPath.startsWith('~')) {
    rootPath = os.homedir() + rootPath.slice(1);
  }

  // Resolve to absolute
  rootPath = path.resolve(rootPath);

  // Security check: refuse system directories
  const normalized = rootPath.replace(/\\/g, '/');
  for (const blocked of BLOCKED_ROOTS) {
    const b = blocked.replace(/\\/g, '/');
    if (normalized === b || normalized === b + '/') {
      return [];
    }
  }

  // Verify path exists and is a directory
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(rootPath);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const results: DiscoverResult[] = [];
  const deadline = Date.now() + 10000; // 10s timeout
  const isWindows = process.platform === 'win32';

  function walk(dirPath: string, depth: number): void {
    if (depth > maxDepth || Date.now() > deadline) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    // Check if this directory is a candidate project
    if (depth > 0) {
      // Only check subdirectories, not the root itself
      let hasGit = false;
      let mdCount = 0;
      let hasReadme = false;

      for (const entry of entries) {
        if (entry.name === '.git' && entry.isDirectory()) {
          hasGit = true;
        }
        if (entry.isFile() && entry.name.endsWith('.md')) {
          mdCount++;
          if (/^readme\.md$/i.test(entry.name)) {
            hasReadme = true;
          }
        }
      }

      if (hasGit && mdCount >= 1) {
        const fullPath = path.resolve(dirPath);
        if (!existingPaths.has(fullPath)) {
          results.push({
            name: path.basename(dirPath),
            path: fullPath,
            hasReadme,
            mdCount,
          });
        }
        // Don't recurse into discovered projects
        return;
      }
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (Date.now() > deadline) break;
      if (!entry.isDirectory()) continue;

      const name = entry.name;

      // Skip hidden directories (Unix)
      if (name.startsWith('.')) continue;

      // Skip known non-project directories
      if (SKIP_DIRS.has(name)) continue;

      // Skip Windows system directories (only at depth 0-1 from home)
      if (isWindows && depth <= 1 && WIN_SYSTEM_DIRS.has(name)) continue;

      walk(path.join(dirPath, name), depth + 1);
    }
  }

  walk(rootPath, 0);

  // Sort by name
  results.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  return results;
}

/** discoverProjects 的异步让出版（红队修复）：每 64 目录 setImmediate 让出
 * 事件循环 + deadline 中途退出 + 目录预算封顶。同步版保留（CLI 用）。 */
export async function discoverProjectsAsync(
  rootPath: string,
  maxDepth: number = 2,
  existingPaths: Set<string> = new Set(),
  opts?: { deadlineMs?: number; maxDirs?: number },
): Promise<DiscoverResult[]> {
  const deadlineMs = opts?.deadlineMs ?? 10_000;
  const maxDirs = opts?.maxDirs ?? 50_000;
  // Expand ~
  if (rootPath.startsWith('~')) {
    rootPath = os.homedir() + rootPath.slice(1);
  }
  rootPath = path.resolve(rootPath);

  const normalized = rootPath.replace(/\\/g, '/');
  for (const blocked of BLOCKED_ROOTS) {
    const b = blocked.replace(/\\/g, '/');
    if (normalized === b || normalized === b + '/') {
      return [];
    }
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(rootPath);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const results: DiscoverResult[] = [];
  const deadline = Date.now() + deadlineMs;
  const isWindows = process.platform === 'win32';
  let visitedDirs = 0;

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > maxDepth || Date.now() > deadline || visitedDirs >= maxDirs) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    visitedDirs++;

    if (depth > 0) {
      let hasGit = false;
      let mdCount = 0;
      let hasReadme = false;
      for (const entry of entries) {
        if (entry.name === '.git' && entry.isDirectory()) hasGit = true;
        if (entry.isFile() && entry.name.endsWith('.md')) {
          mdCount++;
          if (/^readme\.md$/i.test(entry.name)) hasReadme = true;
        }
      }
      if (hasGit && mdCount >= 1) {
        const fullPath = path.resolve(dirPath);
        if (!existingPaths.has(fullPath)) {
          results.push({ name: path.basename(dirPath), path: fullPath, hasReadme, mdCount });
        }
        return;
      }
    }

    for (const entry of entries) {
      if (Date.now() > deadline || visitedDirs >= maxDirs) break;
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith('.')) continue;
      if (SKIP_DIRS.has(name)) continue;
      if (isWindows && depth <= 1 && WIN_SYSTEM_DIRS.has(name)) continue;
      await walk(path.join(dirPath, name), depth + 1);
      // 让出事件循环（每 64 目录一次；防大目录树冻结主进程数秒）
      if (visitedDirs % 64 === 0) await new Promise((r) => setImmediate(r));
    }
  }

  await walk(rootPath, 0);
  results.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return results;
}

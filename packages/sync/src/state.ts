/**
 * 同步状态计算 — 本地扫描 + 本地/远程对比
 *
 * 提供：
 * - scanLocal: 遍历项目目录，返回 FileChange 列表（无 baseline 时全部视为 'added'）
 * - compareRemote: 对比本地与远程文件列表，得出 toPush / toPull / conflicts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { FileChange, RemoteFileEntry, ConflictEntry } from './types.js';

/** 默认忽略模式 — 与 engine.ts 默认值保持一致 */
const DEFAULT_IGNORE_PATTERNS = ['node_modules/', '.git/', '*.tmp'];

/**
 * 判断文件是否应被忽略
 * 与 webdav/s3/local 适配器中的 shouldIgnore 行为保持一致
 */
export function shouldIgnore(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.endsWith('/')) return filePath.startsWith(p);
    if (p.startsWith('*')) return filePath.endsWith(p.slice(1));
    return filePath.includes(p);
  });
}

/**
 * 计算文件 SHA-256 哈希，用于精确对比本地/远程内容是否一致
 */
function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 递归遍历目录，收集所有文件变更
 */
function walkDir(root: string, dir: string, out: FileChange[], ignore: string[]): void {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 权限不足等：跳过该目录
    return;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (shouldIgnore(rel, ignore)) continue;
    if (item.isDirectory()) {
      walkDir(root, full, out, ignore);
    } else if (item.isFile()) {
      try {
        const stat = fs.statSync(full);
        const hash = hashFile(full);
        out.push({
          path: rel,
          // 无 baseline 时统一标记为 'added'，push 适配器不区分 added/modified
          type: 'added',
          mtime: stat.mtime.toISOString(),
          hash,
          size: stat.size,
        });
      } catch {
        // 文件读取失败：跳过
      }
    }
  }
}

/**
 * 扫描本地项目目录，返回所有文件变更列表
 *
 * @param projectPath 项目根目录绝对路径
 * @param ignorePatterns 忽略模式（如 ['node_modules/', '.git/']）
 * @returns FileChange 数组，无 baseline 时全部为 'added'
 */
export function scanLocal(
  projectPath: string,
  ignorePatterns: string[] = DEFAULT_IGNORE_PATTERNS,
): FileChange[] {
  const changes: FileChange[] = [];
  if (!fs.existsSync(projectPath)) return changes;
  walkDir(projectPath, projectPath, changes, ignorePatterns);
  return changes;
}

/**
 * 对比本地与远程文件列表，得出需 push / pull / 冲突的集合
 *
 * 判定规则：
 * - 本地有、远程无 → toPush（新增）
 * - 两端都有但 hash 不同 → toPush（修改）+ conflicts
 * - 两端都有但 hash 不可比 → 按 mtime 判断，本地较新则 toPush
 * - 两端都有且 hash 相同 → 跳过（已同步）
 * - 远程有、本地无 → toPull
 *
 * @param local 本地文件变更列表（来自 scanLocal）
 * @param remote 远程文件列表（来自 adapter.listRemote）
 */
export function compareRemote(
  local: FileChange[],
  remote: RemoteFileEntry[],
): { toPush: FileChange[]; toPull: RemoteFileEntry[]; conflicts: ConflictEntry[] } {
  const remoteMap = new Map(remote.map((r) => [r.path, r]));
  const localMap = new Map(local.map((l) => [l.path, l]));
  const toPush: FileChange[] = [];
  const toPull: RemoteFileEntry[] = [];
  const conflicts: ConflictEntry[] = [];

  // 本地有 → 判断是否需要 push
  for (const l of local) {
    const r = remoteMap.get(l.path);
    if (!r) {
      // 远程不存在：需 push
      toPush.push(l);
    } else if (r.hash && l.hash && r.hash !== l.hash) {
      // 两端 hash 都有且不同：需 push 且标记冲突
      toPush.push({ ...l, type: 'modified' });
      conflicts.push({
        path: l.path,
        localHash: l.hash,
        remoteHash: r.hash,
      });
    } else if (!r.hash || !l.hash) {
      // hash 不可比：按 mtime 判断，本地较新则需 push
      const localMtime = new Date(l.mtime).getTime();
      const remoteMtime = new Date(r.lastModified).getTime();
      if (localMtime > remoteMtime) {
        toPush.push({ ...l, type: 'modified' });
      }
    }
    // hash 相同：已同步，跳过
  }

  // 远程有 → 本地无：需 pull
  for (const r of remote) {
    if (!localMap.has(r.path)) {
      toPull.push(r);
    }
  }

  return { toPush, toPull, conflicts };
}

/**
 * T13: 冲突检测与解决 — 识别双向修改冲突，提供解决策略。
 */
import type { FileChange, ConflictEntry, SyncContext } from './types.js';
import { threeWayMerge, type MergeResult } from './merge/diff3.js';

export type ConflictStrategy = 'local' | 'remote' | 'merge' | 'ask';

export interface Resolution {
  path: string;
  strategy: ConflictStrategy;
  resolved: boolean;
  mergedContent?: string;
}

/**
 * 检测冲突：找出同时在本地和远程被修改的文件。
 *
 * @param localChanges 本地变更列表
 * @param remoteFiles 远程文件列表
 * @returns 冲突条目列表
 */
export function detectConflicts(
  localChanges: FileChange[],
  remoteFiles: Array<{ path: string; lastModified: string }>,
): ConflictEntry[] {
  const conflicts: ConflictEntry[] = [];
  const remoteMap = new Map(remoteFiles.map((f) => [f.path, f.lastModified]));

  for (const change of localChanges) {
    if (change.type !== 'modified' && change.type !== 'added') continue;
    const remoteMtime = remoteMap.get(change.path);
    if (!remoteMtime) continue; // 远程没有此文件，不冲突

    // 本地和远程都修改了同一文件 → 冲突
    if (new Date(remoteMtime).getTime() > new Date(change.mtime).getTime() - 60000) {
      conflicts.push({
        path: change.path,
        localHash: change.hash,
        remoteHash: '', // 需要实际计算远程 hash 填充
      });
    }
  }

  return conflicts;
}

/**
 * 解决冲突：根据策略选择本地版本、远程版本或三方合并。
 *
 * @param conflict 冲突条目
 * @param strategy 解决策略
 * @param contents 可选的三方内容（base/local/remote），用于 merge 策略
 */
export function resolveConflict(
  conflict: ConflictEntry,
  strategy: ConflictStrategy,
  contents?: { base?: string; local?: string; remote?: string },
): Resolution {
  switch (strategy) {
    case 'local':
      return { path: conflict.path, strategy, resolved: true, mergedContent: contents?.local };
    case 'remote':
      return { path: conflict.path, strategy, resolved: true, mergedContent: contents?.remote };
    case 'merge':
      if (contents?.base && contents?.local && contents?.remote) {
        const mergeResult: MergeResult = threeWayMerge(
          contents.base,
          contents.local,
          contents.remote,
        );
        return {
          path: conflict.path,
          strategy,
          resolved: true,
          mergedContent: mergeResult.merged,
        };
      }
      return { path: conflict.path, strategy, resolved: false };
    case 'ask':
    default:
      return { path: conflict.path, strategy: 'ask', resolved: false };
  }
}

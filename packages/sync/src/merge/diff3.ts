/**
 * Three-way merge (diff3) for intelligent conflict resolution.
 */

export interface MergeChunk {
  type: 'stable' | 'local' | 'remote' | 'conflict';
  content: string;
  localContent?: string;
  remoteContent?: string;
}

export interface MergeResult {
  merged: string;
  hasConflicts: boolean;
  chunks: MergeChunk[];
  conflictCount: number;
}

/**
 * Simple line-based three-way merge.
 * base: common ancestor, local: our version, remote: their version.
 */
export function threeWayMerge(base: string, local: string, remote: string): MergeResult {
  const baseLines = base.split('\n');
  const localLines = local.split('\n');
  const remoteLines = remote.split('\n');

  const localDiff = diffLines(baseLines, localLines);
  const remoteDiff = diffLines(baseLines, remoteLines);

  const chunks: MergeChunk[] = [];
  let hasConflicts = false;
  let conflictCount = 0;
  const mergedLines: string[] = [];

  const maxLen = Math.max(baseLines.length, localLines.length, remoteLines.length);

  for (let i = 0; i < maxLen; i++) {
    const baseLine = i < baseLines.length ? baseLines[i] : undefined;
    const localLine = i < localLines.length ? localLines[i] : undefined;
    const remoteLine = i < remoteLines.length ? remoteLines[i] : undefined;

    const localChanged = localLine !== baseLine;
    const remoteChanged = remoteLine !== baseLine;

    if (!localChanged && !remoteChanged) {
      // Stable
      if (baseLine !== undefined) {
        chunks.push({ type: 'stable', content: baseLine });
        mergedLines.push(baseLine);
      }
    } else if (localChanged && !remoteChanged) {
      // Only local changed
      const content = localLine ?? '';
      chunks.push({ type: 'local', content });
      if (localLine !== undefined) mergedLines.push(localLine);
    } else if (!localChanged && remoteChanged) {
      // Only remote changed
      const content = remoteLine ?? '';
      chunks.push({ type: 'remote', content });
      if (remoteLine !== undefined) mergedLines.push(remoteLine);
    } else {
      // Both changed
      if (localLine === remoteLine) {
        // Same change — no conflict
        const content = localLine ?? '';
        chunks.push({ type: 'stable', content });
        if (localLine !== undefined) mergedLines.push(localLine);
      } else {
        // Conflict!
        hasConflicts = true;
        conflictCount++;
        chunks.push({
          type: 'conflict',
          content: '',
          localContent: localLine ?? '',
          remoteContent: remoteLine ?? '',
        });
        // Default: keep local (can be overridden by resolution)
        mergedLines.push(`<<<<<<< LOCAL`);
        if (localLine !== undefined) mergedLines.push(localLine);
        mergedLines.push(`=======`);
        if (remoteLine !== undefined) mergedLines.push(remoteLine);
        mergedLines.push(`>>>>>>> REMOTE`);
      }
    }
  }

  return {
    merged: mergedLines.join('\n'),
    hasConflicts,
    chunks,
    conflictCount,
  };
}

/**
 * Resolve conflicts in a merge result.
 */
export function resolveConflicts(
  mergeResult: MergeResult,
  resolutions: Map<number, 'local' | 'remote'>,
): string {
  const lines: string[] = [];
  let conflictIdx = 0;

  for (const chunk of mergeResult.chunks) {
    if (chunk.type !== 'conflict') {
      lines.push(chunk.content);
    } else {
      const resolution = resolutions.get(conflictIdx) || 'local';
      if (resolution === 'local') {
        lines.push(chunk.localContent || '');
      } else {
        lines.push(chunk.remoteContent || '');
      }
      conflictIdx++;
    }
  }

  return lines.join('\n');
}

/**
 * Simple line diff — returns which lines differ from base.
 */
function diffLines(base: string[], target: string[]): boolean[] {
  const result: boolean[] = [];
  const maxLen = Math.max(base.length, target.length);
  for (let i = 0; i < maxLen; i++) {
    result.push(base[i] !== target[i]);
  }
  return result;
}

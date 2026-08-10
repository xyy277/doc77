/**
 * T13: 文档 diff 计算 — 基于行级的简单 diff。
 *
 * 不依赖外部库，用 LCS（最长公共子序列）算法计算行级差异。
 * 输出 unified diff 格式或结构化 DiffResult。
 */
export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  hasChanges: boolean;
}

/**
 * 计算两个文本的行级 diff。
 */
export function computeDiff(localContent: string, remoteContent: string): DiffResult {
  const localLines = localContent.split('\n');
  const remoteLines = remoteContent.split('\n');

  // LCS 动态规划表
  const m = localLines.length;
  const n = remoteLines.length;
  const dp: number[][] = Array(m + 1)
    .fill(0)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (localLines[i - 1] === remoteLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff
  const lines: DiffLine[] = [];
  let i = m;
  let j = n;
  let added = 0;
  let removed = 0;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && localLines[i - 1] === remoteLines[j - 1]) {
      lines.unshift({
        type: 'unchanged',
        content: localLines[i - 1],
        oldLine: i,
        newLine: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      lines.unshift({ type: 'added', content: remoteLines[j - 1], newLine: j });
      j--;
      added++;
    } else {
      lines.unshift({ type: 'removed', content: localLines[i - 1], oldLine: i });
      i--;
      removed++;
    }
  }

  return { lines, added, removed, hasChanges: added > 0 || removed > 0 };
}

/**
 * 格式化为 unified diff 字符串。
 */
export function formatDiff(diff: DiffResult): string {
  const parts: string[] = [];
  for (const line of diff.lines) {
    const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    parts.push(`${prefix} ${line.content}`);
  }
  return parts.join('\n');
}

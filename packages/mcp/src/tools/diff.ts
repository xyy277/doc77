import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t, getConnection, validatePath, isSensitiveFile, isBinaryFile, readFile } from '@doc77/core';

/**
 * Compare two files and return a unified diff.
 */
export function diffFiles(projectId: number, fileA: string, fileB: string): string {
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const absA = validatePath(project.path, fileA);
  const absB = validatePath(project.path, fileB);

  if (isBinaryFile(absA) || isBinaryFile(absB)) {
    return 'Binary files cannot be diffed';
  }

  const linesA = readFile(absA).split('\n');
  const linesB = readFile(absB).split('\n');

  return formatUnifiedDiff(fileA, fileB, linesA, linesB);
}

/**
 * Produce a simple unified diff between two lists of lines.
 */
function formatUnifiedDiff(
  fileA: string,
  fileB: string,
  linesA: string[],
  linesB: string[],
): string {
  const header = `--- ${fileA}\n+++ ${fileB}\n`;
  if (linesA.length === 0 && linesB.length === 0) return header;

  const result: string[] = [header];
  const maxLen = Math.max(linesA.length, linesB.length);

  for (let i = 0; i < maxLen; i++) {
    if (i >= linesA.length) {
      result.push(`@@ -${i},0 +${i + 1},${linesB.length - i} @@`);
      for (let j = i; j < linesB.length; j++) result.push(`+${linesB[j]}`);
      break;
    }
    if (i >= linesB.length) {
      result.push(`@@ -${i + 1},${linesA.length - i} +${i},0 @@`);
      for (let j = i; j < linesA.length; j++) result.push(`-${linesA[j]}`);
      break;
    }
    if (linesA[i] !== linesB[i]) {
      result.push(`@@ -${i + 1},1 +${i + 1},1 @@`);
      result.push(`-${linesA[i]}`);
      result.push(`+${linesB[i]}`);
    }
  }

  return result.join('\n');
}

/**
 * Register diff-related MCP tools.
 */
export function registerDiffTools(server: McpServer): void {
  server.registerTool(
    'diff_files',
    {
      description: t('mcp.tool.diffFiles.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_a: z.string().describe(t('mcp.param.fileA')),
        file_b: z.string().describe(t('mcp.param.fileB')),
      },
    },
    async (args) => {
      const diff = diffFiles(
        args.project_id as number,
        args.file_a as string,
        args.file_b as string,
      );
      return {
        content: [{ type: 'text' as const, text: diff }],
      };
    },
  );
}

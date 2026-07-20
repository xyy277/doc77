import * as path from 'node:path';
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t, getConnection, isSensitiveFile, validatePath, readFile, scanDirectory } from '@doc77/core';

/**
 * Simple glob matching: * matches any sequence, ? matches any single char.
 */
function matchGlob(name: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(name);
}

/**
 * List files in a project directory with optional filtering, sorting, and pagination.
 *
 * @param projectId - Project ID
 * @param dirPath - Directory path (relative to project root)
 * @param opts - Optional settings
 * @param opts.depth - Recursion depth (1=current level only, 0=unlimited, default 1)
 * @param opts.glob - File pattern filter (e.g. "*.md")
 * @param opts.sort_by - Sort field: name, size, modified
 * @param opts.offset - Pagination offset
 * @param opts.limit - Items per page (default 200)
 */
export async function listFiles(
  projectId: number,
  dirPath: string,
  opts?: {
    depth?: number;
    glob?: string;
    sort_by?: 'name' | 'size' | 'modified';
    offset?: number;
    limit?: number;
  },
): Promise<ReturnType<typeof scanDirectory>['entries']> {
  const depth = opts?.depth ?? 1;
  const glob = opts?.glob;
  const maxFiles = 10000; // safety cap for unlimited recursion

  const result = scanDirectory(projectId, dirPath);
  let entries = result.entries;

  // BFS recursive scanning for depth > 1 or depth === 0 (unlimited)
  if (depth === 0 || depth > 1) {
    const allEntries: typeof entries = [];
    const queue: Array<{ dir: string; currentDepth: number }> = [];

    // Seed with direct children, queue subdirectories
    for (const entry of entries) {
      allEntries.push(entry);
      if (entry.type === 'directory') {
        queue.push({
          dir: dirPath ? `${dirPath}/${entry.name}` : entry.name,
          currentDepth: 1,
        });
      }
    }

    while (queue.length > 0 && allEntries.length < maxFiles) {
      const { dir, currentDepth } = queue.shift()!;
      const subResult = scanDirectory(projectId, dir);
      for (const entry of subResult.entries) {
        allEntries.push({ ...entry, name: `${dir}/${entry.name}` });
        if (entry.type === 'directory' && (depth === 0 || currentDepth < depth)) {
          queue.push({
            dir: `${dir}/${entry.name}`,
            currentDepth: currentDepth + 1,
          });
        }
      }
    }

    entries = allEntries;
  }

  // Glob filter — match against file names (excludes directories)
  if (glob) {
    entries = entries.filter((e) => e.type !== 'directory' && matchGlob(e.name, glob));
  }

  // Sort by field
  if (opts?.sort_by) {
    entries = [...entries].sort((a, b) => {
      switch (opts.sort_by) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'size':
          return (b.size ?? 0) - (a.size ?? 0);
        case 'modified':
          return (b.modified ?? '').localeCompare(a.modified ?? '');
        default:
          return 0;
      }
    });
  }

  // Pagination
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 200;
  entries = entries.slice(offset, offset + limit);

  return entries;
}

/**
 * Read file content with security checks.
 */
export async function readFileContent(projectId: number, filePath: string): Promise<string> {
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const fileName = path.basename(filePath);
  if (isSensitiveFile(fileName)) {
    throw new Error(`Access denied: "${fileName}" is a sensitive file`);
  }

  const absPath = validatePath(project.path, filePath);

  // Verify the resolved path is a file (not a directory)
  const stats = fs.statSync(absPath);
  if (stats.isDirectory()) {
    throw new Error(`"${filePath}" is a directory, not a file`);
  }

  return readFile(absPath);
}

/**
 * Get file metadata.
 */
export async function getFileInfo(
  projectId: number,
  filePath: string,
): Promise<{
  name: string;
  type: string;
  size: number;
  modified: string;
}> {
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const absPath = validatePath(project.path, filePath);
  const stats = fs.statSync(absPath);

  return {
    name: path.basename(filePath),
    type: stats.isDirectory() ? 'directory' : 'file',
    size: stats.size,
    modified: stats.mtime.toISOString(),
  };
}

/**
 * Register read-only MCP tools on the given server.
 * -- list_files, read_file, get_file_info
 */
export function registerReadonlyTools(server: McpServer): void {
  // list_files
  server.registerTool(
    'list_files',
    {
      description: t('mcp.tool.listFiles.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        path: z.string().optional().default('').describe(t('mcp.param.dirPath')),
        depth: z.number().optional().default(1).describe(t('mcp.param.depth')),
        glob: z.string().optional().describe(t('mcp.param.glob')),
        sort_by: z.enum(['name', 'size', 'modified']).optional().describe(t('mcp.param.sortBy')),
        offset: z.number().optional().describe(t('mcp.param.offset')),
        limit: z.number().optional().describe(t('mcp.param.limit')),
      },
    },
    async (args) => {
      const entries = await listFiles(args.project_id as number, (args.path as string) || '', {
        depth: args.depth as number | undefined,
        glob: args.glob as string | undefined,
        sort_by: args.sort_by as 'name' | 'size' | 'modified' | undefined,
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(entries, null, 2) }],
      };
    },
  );

  // read_file
  server.registerTool(
    'read_file',
    {
      description: t('mcp.tool.readFile.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_path: z.string().describe(t('mcp.param.filePath')),
      },
    },
    async (args) => {
      const content = await readFileContent(args.project_id as number, args.file_path as string);
      return {
        content: [{ type: 'text' as const, text: content }],
      };
    },
  );

  // get_file_info
  server.registerTool(
    'get_file_info',
    {
      description: t('mcp.tool.getFileInfo.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_path: z.string().describe(t('mcp.param.filePath')),
      },
    },
    async (args) => {
      const info = await getFileInfo(args.project_id as number, args.file_path as string);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
      };
    },
  );
}

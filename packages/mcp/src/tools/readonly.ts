import * as path from 'node:path';
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  t,
  getConnection,
  isSensitiveFile,
  validatePath,
  readFile,
  readFirstNLines,
  scanDirectory,
} from '@doc77/core';

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
 * Read file content with security checks and optional encoding/line range support.
 *
 * @param projectId - Project ID
 * @param filePath - File path (relative to project root)
 * @param opts - Optional settings
 * @param opts.encoding - File encoding (default 'utf-8', supports gbk, latin1, etc.)
 * @param opts.start_line - Start line number (1-indexed, optional)
 * @param opts.end_line - End line number (1-indexed, optional)
 */
export async function readFileContent(
  projectId: number,
  filePath: string,
  opts?: {
    encoding?: BufferEncoding;
    start_line?: number;
    end_line?: number;
  },
): Promise<string> {
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

  const encoding = opts?.encoding || 'utf-8';

  // Large file warning — files > 1MB without start_line return first 100 lines + size hint
  const ONE_MB = 1024 * 1024;
  if (stats.size > ONE_MB && !opts?.start_line) {
    const partial = readFirstNLines(absPath, 100);
    return `${partial.content}\n\n[File is ${(stats.size / ONE_MB).toFixed(1)}MB. Use start_line/end_line for partial reads.]`;
  }

  // Line range read
  if (opts?.start_line || opts?.end_line) {
    const raw = readFile(absPath);
    const lines = raw.split('\n');
    // Remove trailing empty line from split if file ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const start = (opts.start_line || 1) - 1;
    const end = opts.end_line ? opts.end_line : lines.length;
    return lines.slice(start, end).join('\n');
  }

  // Full read with specified encoding
  if (encoding !== 'utf-8') {
    return fs.readFileSync(absPath, encoding);
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
 * Batch get file metadata — individual failures don't block others.
 */
export async function getFileInfos(
  projectId: number,
  filePaths: string[],
): Promise<
  Array<
    | { name: string; type: string; size: number; modified: string; error?: undefined }
    | { name: string; type: string; size: number; modified: string; error: string }
  >
> {
  const results: Array<
    | { name: string; type: string; size: number; modified: string; error?: undefined }
    | { name: string; type: string; size: number; modified: string; error: string }
  > = [];

  for (const fp of filePaths) {
    try {
      const info = await getFileInfo(projectId, fp);
      results.push(info);
    } catch (e: unknown) {
      results.push({
        name: path.basename(fp),
        type: 'file',
        size: 0,
        modified: '',
        error: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  }

  return results;
}

/**
 * Result of a single file read in batch operation.
 */
export interface ReadFilesResult {
  file_path: string;
  content: string | null;
  error?: string;
}

/**
 * Read multiple files concurrently with a maximum of 10 concurrent reads.
 * Individual file read failures do not block other files.
 *
 * @param projectId - Project ID
 * @param filePaths - Array of file paths (relative to project root)
 */
export async function readFiles(
  projectId: number,
  filePaths: string[],
): Promise<ReadFilesResult[]> {
  const CONCURRENCY = 10;
  const results: ReadFilesResult[] = [];

  for (let i = 0; i < filePaths.length; i += CONCURRENCY) {
    const batch = filePaths.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (fp) => {
        try {
          const content = await readFileContent(projectId, fp);
          return { file_path: fp, content };
        } catch (e: unknown) {
          return {
            file_path: fp,
            content: null,
            error: e instanceof Error ? e.message : 'Unknown error',
          };
        }
      }),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        // Should not happen since we catch errors inside the map
        results.push({
          file_path: 'unknown',
          content: null,
          error: result.reason instanceof Error ? result.reason.message : 'Unknown error',
        });
      }
    }
  }

  return results;
}

/**
 * Register read-only MCP tools on the given server.
 * -- list_files, read_file, read_files, get_file_info
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
        encoding: z.string().optional().default('utf-8').describe(t('mcp.param.encoding')),
        start_line: z.number().optional().describe(t('mcp.param.startLine')),
        end_line: z.number().optional().describe(t('mcp.param.endLine')),
      },
    },
    async (args) => {
      const content = await readFileContent(args.project_id as number, args.file_path as string, {
        encoding: args.encoding as BufferEncoding | undefined,
        start_line: args.start_line as number | undefined,
        end_line: args.end_line as number | undefined,
      });
      return {
        content: [{ type: 'text' as const, text: content }],
      };
    },
  );

  // read_files
  server.registerTool(
    'read_files',
    {
      description: t('mcp.tool.readFiles.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_paths: z.array(z.string()).describe(t('mcp.param.filePaths')),
      },
    },
    async (args) => {
      const results = await readFiles(args.project_id as number, args.file_paths as string[]);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
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
        file_path: z.string().optional().describe(t('mcp.param.filePath')),
        file_paths: z.array(z.string()).optional().describe(t('mcp.param.filePaths')),
      },
    },
    async (args) => {
      // Batch mode
      if (args.file_paths && Array.isArray(args.file_paths) && args.file_paths.length > 0) {
        const infos = await getFileInfos(args.project_id as number, args.file_paths as string[]);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(infos, null, 2) }],
        };
      }
      // Single mode
      const info = await getFileInfo(
        args.project_id as number,
        (args.file_path as string) || '',
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
      };
    },
  );
}

import * as path from 'node:path';
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t, getConnection, validatePath, isSensitiveFile, isBinaryFile, readFile } from '@doc77/core';

export interface SearchMatch {
  file_path: string;
  line_number: number;
  line_content: string;
  context_before: string;
  context_after: string;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '__pycache__', '.venv', 'venv',
  'dist', '.cache', '.next', '.nuxt', 'build', 'target',
]);

const SKIP_EXT = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.o', '.wasm',
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif',
  '.mp4', '.mp3', '.wav', '.ogg', '.flac', '.aac', '.mov', '.avi', '.mkv',
  '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz', '.zst',
  '.pdf', '.docx', '.doc', '.xls', '.xlsx', '.ppt', '.pptx',
]);

/**
 * Search for a keyword or regex pattern within project files.
 *
 * @param projectId - Project ID
 * @param query - Search keyword or regex pattern (use /pattern/ wrapper for regex)
 * @param opts - Optional settings
 * @param opts.searchPath - Limit search to a subdirectory (relative to project root)
 * @param opts.glob - File pattern filter (e.g. "*.md")
 * @param opts.maxResults - Max results (default 50)
 * @returns Array of SearchMatch
 */
export function searchFiles(
  projectId: number,
  query: string,
  opts?: { searchPath?: string; glob?: string; maxResults?: number },
): SearchMatch[] {
  const db = getConnection();
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
    { path: string } | undefined;
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const basePath = opts?.searchPath
    ? validatePath(project.path, opts.searchPath)
    : project.path;
  const maxResults = opts?.maxResults ?? 50;

  const results: SearchMatch[] = [];

  // Build regex — if query looks like a regex (starts/ends with /), treat as regex
  let regex: RegExp;
  if (query.startsWith('/') && query.endsWith('/') && query.length > 1) {
    regex = new RegExp(query.slice(1, -1), 'i');
  } else {
    // Escape regex special chars for literal search
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, 'i');
  }

  // Walk files
  walkAndSearch(basePath, '', regex, opts?.glob, maxResults, results);
  return results.slice(0, maxResults);
}

function walkAndSearch(
  basePath: string,
  relativeDir: string,
  regex: RegExp,
  globPattern: string | undefined,
  maxResults: number,
  results: SearchMatch[],
): void {
  const currentPath = path.join(basePath, relativeDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return; // skip directories we can't read
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return;

    if (isSensitiveFile(entry.name)) continue;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const nextDir = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      walkAndSearch(basePath, nextDir, regex, globPattern, maxResults, results);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      if (globPattern && !matchSimpleGlob(entry.name, globPattern)) continue;

      const fullPath = path.join(currentPath, entry.name);
      if (isBinaryFile(fullPath)) continue;

      try {
        const content = readFile(fullPath);
        const lines = content.split('\n');
        const displayPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            results.push({
              file_path: displayPath,
              line_number: i + 1,
              line_content: lines[i].substring(0, 500),
              context_before: i > 0 ? lines[i - 1].substring(0, 200) : '',
              context_after: i < lines.length - 1 ? lines[i + 1].substring(0, 200) : '',
            });
          }
        }
      } catch {
        // Skip files we can't read
      }
    }
  }
}

function matchSimpleGlob(name: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(name);
}

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    'search_files',
    {
      description: t('mcp.tool.searchFiles.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        query: z.string().describe(t('mcp.param.query')),
        path: z.string().optional().describe(t('mcp.param.searchPath')),
        glob: z.string().optional().describe(t('mcp.param.glob')),
        max_results: z.number().optional().default(50).describe(t('mcp.param.maxResults')),
      },
    },
    async (args) => {
      const results = searchFiles(args.project_id as number, args.query as string, {
        searchPath: args.path as string | undefined,
        glob: args.glob as string | undefined,
        maxResults: args.max_results as number | undefined,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );
}

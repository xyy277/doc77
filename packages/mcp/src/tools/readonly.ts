import * as path from 'node:path';
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t, getConnection, isSensitiveFile, validatePath, readFile, scanDirectory } from '@doc77/core';

/**
 * List files in a project directory.
 */
export async function listFiles(
  projectId: number,
  dirPath: string,
): Promise<ReturnType<typeof scanDirectory>['entries']> {
  const result = scanDirectory(projectId, dirPath);
  return result.entries;
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
      },
    },
    async (args) => {
      const entries = await listFiles(args.project_id as number, (args.path as string) || '');
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

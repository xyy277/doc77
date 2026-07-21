import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t, getConnection, scanDirectory } from '@doc77/core';

export interface ProjectSummary {
  id: number;
  name: string;
  path: string;
  file_count: number;
  created_at: string;
}

/**
 * List all registered projects.
 */
export function listProjects(): ProjectSummary[] {
  const db = getConnection();
  const projects = db
    .prepare('SELECT id, name, path, created_at FROM projects ORDER BY id')
    .all() as Array<{ id: number; name: string; path: string; created_at: string }>;

  return projects.map((p) => {
    const scan = scanDirectory(p.id, '');
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      file_count: scan.entries.length,
      created_at: p.created_at,
    };
  });
}

export interface ProjectInfo {
  id: number;
  name: string;
  path: string;
  total_size: number;
  file_count: number;
  folder_count: number;
  created_at: string;
  last_opened: string | null;
}

/**
 * Get detailed info for a single project.
 */
export function getProjectInfo(projectId: number): ProjectInfo | null {
  const db = getConnection();
  const project = db
    .prepare('SELECT id, name, path, created_at, last_opened FROM projects WHERE id = ?')
    .get(projectId) as
    | { id: number; name: string; path: string; created_at: string; last_opened: string | null }
    | undefined;

  if (!project) return null;

  // Count files and folders by scanning root
  const allEntries = scanDirectory(projectId, '').entries;
  const files = allEntries.filter((e) => e.type === 'file');
  const folders = allEntries.filter((e) => e.type === 'directory');
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  return {
    id: project.id,
    name: project.name,
    path: project.path,
    total_size: totalSize,
    file_count: files.length,
    folder_count: folders.length,
    created_at: project.created_at,
    last_opened: project.last_opened,
  };
}

/**
 * Register discovery-related MCP tools.
 */
export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    'list_projects',
    {
      description: t('mcp.tool.listProjects.desc'),
      inputSchema: {},
    },
    async () => {
      const projects = listProjects();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }],
      };
    },
  );

  server.registerTool(
    'get_project_info',
    {
      description: t('mcp.tool.getProjectInfo.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
      },
    },
    async (args) => {
      const info = getProjectInfo(args.project_id as number);
      if (!info) throw new Error(`Project not found: ${args.project_id}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
      };
    },
  );
}

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listProjects, getProjectInfo } from '../tools/discovery.js';
import { listFiles } from '../tools/readonly.js';

/**
 * Register all MCP resources on the given server.
 *
 * Resources expose read-only project data via the `doc77://` scheme:
 * - `doc77://projects`              — JSON list of all registered projects
 * - `doc77://projects/{id}/info`    — JSON details for a single project
 * - `doc77://projects/{id}/tree`    — JSON file tree (accepts `?path=` query)
 *
 * @param server - The McpServer instance to register resources on.
 */
export function registerResources(server: McpServer): void {
  // -- doc77://projects — all registered projects
  server.registerResource(
    'projects',
    'doc77://projects',
    {
      description: 'All registered projects',
    },
    async (_uri) => ({
      contents: [
        {
          uri: 'doc77://projects',
          text: JSON.stringify(listProjects(), null, 2),
          mimeType: 'application/json',
        },
      ],
    }),
  );

  // -- doc77://projects/{id}/info — single project details
  server.registerResource(
    'project-info',
    new ResourceTemplate('doc77://projects/{id}/info', { list: undefined }),
    {
      description: 'Single project details by ID',
    },
    async (uri, variables) => {
      const id = parseInt(variables.id as string, 10);
      const info = getProjectInfo(id);
      if (!info) {
        throw new Error(`Project ${id} not found`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(info, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );

  // -- doc77://projects/{id}/tree — project file tree (accepts ?path=)
  server.registerResource(
    'project-tree',
    new ResourceTemplate('doc77://projects/{id}/tree', { list: undefined }),
    {
      description: 'Project file tree by ID. Query param: path (default root)',
    },
    async (uri, variables) => {
      const id = parseInt(variables.id as string, 10);
      const searchParams = new URLSearchParams(uri.search);
      const dirPath = searchParams.get('path') || '';
      const entries = await listFiles(id, dirPath, { depth: 1 });
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(entries, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );
}

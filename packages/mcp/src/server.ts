import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const SERVER_NAME = 'doc77';
import { VERSION as SERVER_VERSION } from './version.gen.js';
import { registerAllTools } from './tools/index.js';

/**
 * Create and configure the Doc77 MCP server.
 * Registers all tools: read-only + write.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerAllTools(server);

  return server;
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const SERVER_NAME = 'doc77';
import { VERSION as SERVER_VERSION } from './version.gen.js';
import { registerReadonlyTools } from './tools/readonly.js';
import { registerWriteTools } from './tools/write.js';

/**
 * Create and configure the Doc77 MCP server.
 * Registers all 8 tools: 3 read-only + 5 write.
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

  registerReadonlyTools(server);
  registerWriteTools(server);

  return server;
}

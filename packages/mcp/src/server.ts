import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const SERVER_NAME = 'doc77';
import { VERSION as SERVER_VERSION } from './version.gen.js';
import { registerAllTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

/**
 * Create and configure the Doc77 MCP server.
 * Registers all capabilities: tools, resources, prompts.
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
        resources: {},
        prompts: {},
      },
    },
  );

  registerAllTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}

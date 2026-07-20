import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadonlyTools } from './readonly.js';
import { registerWriteTools } from './write.js';
import { registerDiscoveryTools } from './discovery.js';
import { registerSearchTools } from './search.js';
import { registerDiffTools } from './diff.js';
import { registerSessionTools } from './session.js';

/**
 * Register all tools (discovery, read-only + write) on the given MCP server.
 * This is the single entry point for tool registration.
 */
export function registerAllTools(server: McpServer): void {
  registerDiscoveryTools(server);
  registerSearchTools(server);
  registerReadonlyTools(server);
  registerWriteTools(server);
  registerDiffTools(server);
  registerSessionTools(server);
}

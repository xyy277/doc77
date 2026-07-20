import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadonlyTools } from './readonly.js';
import { registerWriteTools } from './write.js';
import { registerDiscoveryTools } from './discovery.js';

/**
 * Register all tools (discovery, read-only + write) on the given MCP server.
 * This is the single entry point for tool registration.
 */
export function registerAllTools(server: McpServer): void {
  registerDiscoveryTools(server);
  registerReadonlyTools(server);
  registerWriteTools(server);
}

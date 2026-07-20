import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadonlyTools } from './readonly.js';
import { registerWriteTools } from './write.js';

/**
 * Register all tools (read-only + write) on the given MCP server.
 * This is the single entry point for tool registration.
 */
export function registerAllTools(server: McpServer): void {
  registerReadonlyTools(server);
  registerWriteTools(server);
}

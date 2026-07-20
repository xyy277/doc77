import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Register all MCP resources on the given server.
 *
 * Resources are MCP protocol primitives for exposing read-only data.
 * This module is a placeholder — resources will be implemented in Phase 2.
 *
 * @param server - The McpServer instance to register resources on.
 */
export function registerResources(server: McpServer): void {
  // No resources registered yet.
  // Phase 2 will populate this with project files, configurations, etc.
  void server;
}

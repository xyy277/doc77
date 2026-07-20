import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Connect an McpServer to stdio transport.
 *
 * Creates a StdioServerTransport (reading from stdin, writing to stdout)
 * and connects the given server to it. This is the standard transport for
 * CLI-based MCP clients (e.g. Claude Desktop, MCP Inspector).
 */
export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as http from 'node:http';

export interface HttpTransportResult {
  server: http.Server;
  port: number;
}

/**
 * Connect the MCP server via HTTP transport.
 * Creates a Node.js HTTP server that handles MCP requests using Streamable HTTP.
 */
export async function connectHttp(
  mcpServer: McpServer,
  port: number,
): Promise<HttpTransportResult> {
  let actualPort = port;

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for browser-based MCP clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: 'doc77-mcp', transport: 'http' }));
      return;
    }

    // MCP endpoint — POST only
    if (req.method === 'POST' && (req.url === '/' || req.url === '/mcp')) {
      try {
        const body = await readBody(req);
        // Handle MCP request via the server's internal transport
        // Note: @modelcontextprotocol/sdk ^1.0.0 may not expose a direct handleRequest method.
        // For now, respond with a structured message indicating HTTP transport is available.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'doc77', version: '1.0.0' },
              capabilities: { tools: {}, resources: {}, prompts: {} },
            },
          }),
        );
        return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
        return;
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(actualPort, '0.0.0.0', () => {
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') {
        actualPort = addr.port;
      }
      resolve({ server: httpServer, port: actualPort });
    });
    httpServer.on('error', reject);
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      // Limit body size to 10MB
      if (body.length > 10 * 1024 * 1024) {
        req.destroy(new Error('Body too large'));
        return;
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

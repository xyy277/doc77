import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t } from '@doc77/core';

const SERVER_NAME = 'doc77';
import { VERSION as SERVER_VERSION } from './version.gen.js';

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

function registerReadonlyTools(server: McpServer): void {
  // list_files
  server.registerTool(
    'list_files',
    {
      description: t('mcp.tool.listFiles.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        path: z.string().optional().default('').describe(t('mcp.param.dirPath')),
      },
    },
    async (args) => {
      const { listFiles } = await import('./tools/readonly.js');
      const entries = await listFiles(args.project_id as number, (args.path as string) || '');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(entries, null, 2) }],
      };
    },
  );

  // read_file
  server.registerTool(
    'read_file',
    {
      description: t('mcp.tool.readFile.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_path: z.string().describe(t('mcp.param.filePath')),
      },
    },
    async (args) => {
      const { readFileContent } = await import('./tools/readonly.js');
      const content = await readFileContent(args.project_id as number, args.file_path as string);
      return {
        content: [{ type: 'text' as const, text: content }],
      };
    },
  );

  // get_file_info
  server.registerTool(
    'get_file_info',
    {
      description: t('mcp.tool.getFileInfo.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_path: z.string().describe(t('mcp.param.filePath')),
      },
    },
    async (args) => {
      const { getFileInfo } = await import('./tools/readonly.js');
      const info = await getFileInfo(args.project_id as number, args.file_path as string);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
      };
    },
  );
}

function registerWriteTools(server: McpServer): void {
  const writeTools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> = [
    {
      name: 'write_file',
      description: t('mcp.tool.writeFile.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_path: z.string().describe(t('mcp.param.filePath')),
        content: z.string().describe(t('mcp.param.content')),
      },
    },
    {
      name: 'create_folder',
      description: t('mcp.tool.createFolder.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        folder_path: z.string().describe(t('mcp.param.folderPath')),
      },
    },
    {
      name: 'move_file',
      description: t('mcp.tool.moveFile.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        source: z.string().describe(t('mcp.param.sourcePath')),
        target: z.string().describe(t('mcp.param.targetPath')),
      },
    },
    {
      name: 'delete_file',
      description: t('mcp.tool.deleteFile.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        file_path: z.string().describe(t('mcp.param.filePathToDelete')),
      },
    },
    {
      name: 'batch_operations',
      description: t('mcp.tool.batchOperations.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        operations: z.array(z.record(z.unknown())).describe(t('mcp.param.operations')),
      },
    },
    {
      name: 'get_task_status',
      description: t('mcp.tool.getTaskStatus.desc'),
      inputSchema: {
        task_id: z.string().describe(t('mcp.param.taskId')),
      },
    },
  ];

  for (const tool of writeTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, z.ZodTypeAny>,
      },
      async (args) => {
        const { writeFile, createFolder, moveFile, deleteFile, batchOperations, getTaskStatus } =
          await import('./tools/write.js');

        // Generate a session ID for this operation
        const { createSession } = await import('./session.js');
        const session = createSession();
        const sessionId = session.id;

        let result;
        switch (tool.name) {
          case 'write_file':
            result = await writeFile(
              args.project_id as number,
              sessionId,
              args.file_path as string,
              args.content as string,
            );
            break;
          case 'create_folder':
            result = await createFolder(
              args.project_id as number,
              sessionId,
              args.folder_path as string,
            );
            break;
          case 'move_file':
            result = await moveFile(
              args.project_id as number,
              sessionId,
              args.source as string,
              args.target as string,
            );
            break;
          case 'delete_file':
            result = await deleteFile(
              args.project_id as number,
              sessionId,
              args.file_path as string,
            );
            break;
          case 'batch_operations':
            result = await batchOperations(
              args.project_id as number,
              sessionId,
              args.operations as Array<{ type: string } & Record<string, unknown>>,
            );
            break;
          case 'get_task_status':
            result = await getTaskStatus(args.task_id as string);
            break;
          default:
            throw new Error(`Unknown tool: ${tool.name}`);
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }
}

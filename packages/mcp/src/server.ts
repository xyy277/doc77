import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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
      description:
        '列出项目指定路径下的文件和文件夹，包含 name/type/size/modified。默认过滤敏感文件。',
      inputSchema: {
        project_id: z.number().describe('项目 ID'),
        path: z.string().optional().default('').describe('目录路径（相对于项目根目录）'),
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
      description: '读取指定文件内容（仅限已注册项目内，敏感文件自动拒绝）',
      inputSchema: {
        project_id: z.number().describe('项目 ID'),
        file_path: z.string().describe('文件路径（相对于项目根目录）'),
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
      description: '获取文件元数据（大小、修改时间、类型）',
      inputSchema: {
        project_id: z.number().describe('项目 ID'),
        file_path: z.string().describe('文件路径（相对于项目根目录）'),
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
      description: '创建或覆盖文件内容（需审批）',
      inputSchema: {
        project_id: z.number().describe('项目 ID'),
        file_path: z.string().describe('文件路径（相对于项目根目录）'),
        content: z.string().describe('要写入的文件内容'),
      },
    },
    {
      name: 'create_folder',
      description: '创建新文件夹（需审批）',
      inputSchema: {
        project_id: z.number().describe('项目 ID'),
        folder_path: z.string().describe('文件夹路径（相对于项目根目录）'),
      },
    },
    {
      name: 'move_file',
      description: '移动或重命名文件（需审批）',
      inputSchema: {
        project_id: z.number().describe('项目 ID'),
        source: z.string().describe('源文件路径'),
        target: z.string().describe('目标文件路径'),
      },
    },
    {
      name: 'delete_file',
      description: '删除文件或空文件夹（强制审批）',
      inputSchema: {
        project_id: z.number().describe('项目 ID'),
        file_path: z.string().describe('要删除的文件路径'),
      },
    },
    {
      name: 'batch_operations',
      description: '批量执行多个操作（整体审批，原子回滚）',
      inputSchema: {
        project_id: z.number().describe('项目 ID'),
        operations: z.array(z.record(z.unknown())).describe('操作数组，每个元素含 type 和对应参数'),
      },
    },
    {
      name: 'get_task_status',
      description: '查询之前提交的写入任务状态',
      inputSchema: {
        task_id: z.string().describe('任务 ID'),
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

import type { ToolDefinition } from '../provider/index.js';

/**
 * MCP Read Tool Definitions — OpenAI Function Calling format.
 *
 * These are the read-only tools the AI agent can use to explore
 * the project's file system. Write tools are deferred to Phase 5.
 */
export const READ_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        '列出项目指定目录下的所有文件和子目录。返回每个条目的名称、类型（file/directory）、大小（字节）和修改时间。用于了解项目结构和文件组织。',
      parameters: {
        type: 'object',
        properties: {
          dir_path: {
            type: 'string',
            description:
              '相对于项目根目录的路径。空字符串或 "/" 表示根目录。例如 "docs" 或 "src/components"',
          },
        },
        required: ['dir_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        '读取项目中指定文本文件的内容。仅支持文本文件（Markdown、代码、配置文件等）。返回文件内容，超过 4000 字符时自动截断。用于理解具体文件的内容。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              '相对于项目根目录的文件路径。例如 "README.md" 或 "docs/design/system-architecture.md"',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_info',
      description:
        '获取单个文件的元信息：名称、类型、大小、最后修改时间。用于确认文件是否存在或比较文件大小，无需读取完整内容时使用。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '相对于项目根目录的文件路径',
          },
        },
        required: ['file_path'],
      },
    },
  },
];

/**
 * MCP Write Tool Definitions — OpenAI Function Calling format.
 *
 * These let the AI agent *propose* file mutations. They never execute directly:
 * the executor enqueues each as a pending task in the approval queue, and the
 * user approves it in the UI before the transactional executor runs it. Every
 * description states that approval is required so the model sets expectations.
 */
export const WRITE_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'move_file',
      description:
        '移动或重命名文件/目录：把 source 移动到 target。该操作会加入审批队列，需用户在「审批」标签页批准后才会执行。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '源路径（相对于项目根目录）' },
          target: { type: 'string', description: '目标路径（相对于项目根目录）' },
        },
        required: ['source', 'target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_folder',
      description:
        '创建新目录（可多级）。该操作会加入审批队列，需用户在「审批」标签页批准后才会执行。',
      parameters: {
        type: 'object',
        properties: {
          folder_path: { type: 'string', description: '要创建的目录路径（相对于项目根目录）' },
        },
        required: ['folder_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        '删除文件或空目录（非空目录无法删除）。该操作会加入审批队列，需用户在「审批」标签页批准后才会执行。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要删除的路径（相对于项目根目录）' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_operations',
      description:
        '批量执行多个文件操作（move_file/create_folder/delete_file）。作为一个事务整体审批、整体执行，任一步失败则全部回滚。该操作会加入审批队列，需用户批准后才会执行。',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            description: '操作数组，每个元素含 type 和对应路径字段',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['move_file', 'create_folder', 'delete_file'],
                },
                source: { type: 'string', description: 'move_file 的源路径' },
                target: { type: 'string', description: 'move_file 的目标路径' },
                folder_path: { type: 'string', description: 'create_folder 的路径' },
                file_path: { type: 'string', description: 'delete_file 的路径' },
              },
              required: ['type'],
            },
          },
        },
        required: ['operations'],
      },
    },
  },
];

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

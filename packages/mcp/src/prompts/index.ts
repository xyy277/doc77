import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Register MCP prompt templates on the given server.
 * Prompts provide pre-built operation templates for common tasks.
 */
export function registerPrompts(server: McpServer): void {
  server.prompt(
    'organize-project',
    {
      description: '帮我整理项目目录结构',
    },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `请帮我整理当前项目的目录结构。

步骤：
1. 先用 list_projects 查看可用项目
2. 用 list_files 了解目录结构（建议 depth=2 先看概况）
3. 分析文件分类，提出整理方案（如：将技术文档放到 docs/、图片放到 assets/、脚本放到 scripts/）
4. 列出具体的 move_file / create_folder 操作建议
5. 每个操作建议需说明意图和理由`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'search-and-classify',
    {
      description: '搜索并归类文档',
    },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `请搜索项目中包含指定关键词或模式的文件，分析它们的内容和用途，提出归类建议。

步骤：
1. 使用 search_files 搜索相关文件
2. 使用 read_file 了解关键文件内容
3. 根据内容相似性和用途，提出文件归类方案
4. 生成具体的 move_file / batch_operations 操作建议`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'summarize-project',
    {
      description: '生成项目摘要',
    },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `请分析当前项目的文档结构，生成一个项目摘要。

需要包括：
- 项目名称和基本信息（使用 get_project_info）
- 主要目录结构和文件统计（使用 list_files depth=2）
- 关键文档列表（如 README、设计文档、API 文档等）
- 文档主题分布（技术文档、业务文档、配置等）
- 建议的改进方向（如：哪些文档可以合并、哪些目录需要整理）`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'find-duplicates',
    {
      description: '查找重复或相似文件',
    },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `请检查项目中是否存在内容重复或高度相似的文件。

步骤：
1. 使用 get_file_info 比较文件大小，找出大小相同的候选文件组
2. 使用 read_files 批量读取候选文件内容进行比较
3. 使用 diff_files 确认文件差异（如果高度相似）
4. 对于确认重复的文件，提出删除或合并建议
5. 删除操作需标注为"高危操作"，要求用户确认`,
          },
        },
      ],
    }),
  );
}

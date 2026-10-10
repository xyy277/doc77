import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t, getConnection, queryBacklinks, relatedDocs } from '@doc77/core';

/**
 * 知识图谱只读 MCP 工具（三阶段第 1 项，docs/design/knowledge-graph.md §10）。
 *
 * - graph_backlinks：某文档的反向链接（谁链接到它）
 * - graph_related：相关文档推荐（co-citation 评分，RelatedScorer 注入点）
 *
 * 只查询图谱索引（doc_meta / doc_links），不触磁盘，天然只读；
 * project_id 非法时直接抛错（与 read_file 等工具语义一致）。
 */

function ensureProject(projectId: number): void {
  const row = getConnection().prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as
    { id: number } | undefined;
  if (!row) throw new Error(`Project not found: ${projectId}`);
}

/** 某文档的反向链接（入链），按最近更新排序 */
export function graphBacklinks(
  projectId: number,
  filePath: string,
  opts?: { limit?: number; offset?: number },
) {
  ensureProject(projectId);
  return queryBacklinks(getConnection(), projectId, filePath, opts);
}

/** 相关文档推荐（co-citation 评分） */
export function graphRelated(projectId: number, filePath: string, limit = 5) {
  ensureProject(projectId);
  // clamp：related 语义上限 20（与 /api/graph/:id/related 一致）
  const capped = Math.max(1, Math.min(limit, 20));
  return relatedDocs(projectId, filePath, capped);
}

export function registerGraphTools(server: McpServer): void {
  server.registerTool(
    'graph_backlinks',
    {
      description: t('mcp.tool.graphBacklinks.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        path: z.string().describe(t('mcp.param.filePath')),
        limit: z.number().optional().describe(t('mcp.param.limit')),
        offset: z.number().optional().describe(t('mcp.param.offset')),
      },
    },
    async (args) => {
      const rows = graphBacklinks(args.project_id as number, args.path as string, {
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
      };
    },
  );

  server.registerTool(
    'graph_related',
    {
      description: t('mcp.tool.graphRelated.desc'),
      inputSchema: {
        project_id: z.number().describe(t('mcp.param.projectId')),
        path: z.string().describe(t('mcp.param.filePath')),
        limit: z.number().optional().describe(t('mcp.param.limit')),
      },
    },
    async (args) => {
      const rows = graphRelated(
        args.project_id as number,
        args.path as string,
        (args.limit as number | undefined) ?? 5,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
      };
    },
  );
}

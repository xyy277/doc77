import { relatedDocs } from './related.js';

/**
 * AI 问答的图谱上下文注入（v1.2.0）。
 *
 * 回答问题时把当前文档的图谱邻居（1 跳，co-citation 排序）内容注入提示词，
 * 类似 Notion sidebar Q&A 的"读当前页 + 链接页"。N/K/T 三级预算防止
 * 上下文窗口爆掉：maxDocs（文档数）× maxCharsPerDoc（单文档截断）×
 * maxTotalChars（总预算）。
 *
 * readContent 由调用方注入（app.ts 的 readProjectFileContent），自动获得
 * 敏感文件拦截、路径沙箱、截断语义 —— AI 注入与 read_file 工具行为一致。
 */

export interface GraphContextOptions {
  maxDocs?: number;
  maxCharsPerDoc?: number;
  maxTotalChars?: number;
}

export type GraphContentReader = (projectId: number, filePath: string) => string;

export function collectGraphNeighbors(
  projectId: number,
  currentPath: string,
  readContent: GraphContentReader,
  opts: GraphContextOptions = {},
): string {
  const maxDocs = opts.maxDocs ?? 3;
  const maxCharsPerDoc = opts.maxCharsPerDoc ?? 2000;
  const maxTotalChars = opts.maxTotalChars ?? 6000;

  const related = relatedDocs(projectId, currentPath, maxDocs);
  if (related.length === 0) return '';

  const parts: string[] = [];
  let total = 0;
  for (const r of related) {
    if (parts.length >= maxDocs) break;
    const content = readContent(projectId, r.path);
    if (!content || content.startsWith('Error:')) continue;
    const slice = content.slice(0, maxCharsPerDoc);
    parts.push(`<doc path="${r.path}">\n${slice}\n</doc>`);
    total += slice.length;
    if (total >= maxTotalChars) break;
  }
  if (parts.length === 0) return '';

  return `\n\n---\n相关文档（知识图谱邻居，供回答参考）：\n${parts.join('\n\n')}`;
}

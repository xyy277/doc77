/**
 * T13: AI 辅助冲突解决 — 调用 AI provider 给出合并建议。
 *
 * 构造 prompt：本地版本 + 远程版本 + 上下文 → 请求 AI 给出合并结果。
 */
export interface AiConflictContext {
  filePath: string;
  localContent: string;
  remoteContent: string;
  baseContent?: string;
}

export interface AiResolution {
  mergedContent: string;
  explanation?: string;
}

/** AI 聊天函数签名（注入以避免硬依赖具体 provider） */
export type AiChatFn = (prompt: string) => Promise<string>;

/**
 * 构造 AI 解决冲突的 prompt。
 */
export function buildConflictPrompt(ctx: AiConflictContext): string {
  return `你是一个代码合并助手。请合并以下冲突的文件版本，保留双方的修改意图。

文件: ${ctx.filePath}

${ctx.baseContent ? `### 基础版本（共同祖先）\n\`\`\`\n${ctx.baseContent}\n\`\`\`\n` : ''}
### 本地版本
\`\`\`
${ctx.localContent}
\`\`\`

### 远程版本
\`\`\`
${ctx.remoteContent}
\`\`\`

请直接输出合并后的完整内容，不要解释。`;
}

/**
 * 调用 AI 解决冲突。
 *
 * @param ctx 冲突上下文（本地/远程/基础版本）
 * @param chatFn AI 聊天函数（注入）
 * @returns AI 给出的合并结果
 */
export async function aiResolveConflict(
  ctx: AiConflictContext,
  chatFn: AiChatFn,
): Promise<AiResolution> {
  const prompt = buildConflictPrompt(ctx);
  const response = await chatFn(prompt);
  // AI 返回的可能是 markdown 代码块包裹的内容，简单清理
  let merged = response.trim();
  // 去除可能的 ``` 包裹
  const codeBlockMatch = merged.match(/^```\w*\n([\s\S]*?)\n```$/);
  if (codeBlockMatch) {
    merged = codeBlockMatch[1];
  }
  return { mergedContent: merged };
}

/**
 * @doc77/ai — Doc77 AI 模块
 *
 * 提供 AI Provider 抽象、Agent 核心、MCP 工具定义和对话 API。
 */

export const VERSION = '0.1.0';

// Provider
export { AiProvider } from './provider/index.js';
export type {
  AiProviderConfig,
  AiMessage,
  ToolCall,
  ToolDefinition,
  AiCompletionRequest,
  AiCompletionResponse,
  StreamChunk,
} from './provider/index.js';

// Agent
export {
  DocAgent,
  createSummarizePrompt,
  createClassifyPrompt,
  createProjectSummaryPrompt,
} from './agent/index.js';
export type { AgentConfig, AgentResponse } from './agent/index.js';

// Tools
export { READ_TOOLS, formatToolResult } from './tools.js';

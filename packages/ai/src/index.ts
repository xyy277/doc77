/**
 * @doc77/ai — Doc77 AI 模块
 *
 * 提供 AI Provider 抽象、Agent 核心、MCP 工具定义和对话 API。
 */

export { VERSION } from './version.gen.js';

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
export { DocAgent, createClassifyPrompt } from './agent/index.js';
export type { AgentConfig, AgentResponse } from './agent/index.js';

// Tools
export { getReadTools, getWriteTools } from './tools.js';

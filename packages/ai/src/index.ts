/**
 * @doc77/ai — Doc77 AI 模块
 *
 * 提供 AI Provider 抽象、Agent 核心、MCP 工具定义和对话 API。
 */

export { VERSION } from './version.gen.js';

// Provider
export { AiProvider, normalizeMessages } from './provider/index.js';
export { OllamaProvider } from './provider/ollama.js';
export type { OllamaProviderConfig, OllamaModelInfo } from './provider/ollama.js';
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

// Agent Loop (Phase 3 redesign — five-layer harness)
export { AgentLoop, createPersistenceAdapter } from './agent/loop.js';
export type { AgentEvent, AgentLoopConfig, PersistenceAdapter } from './agent/loop.js';

// Context Manager (Phase 3 — four-layer compression pipeline)
export { ContextManager, estimateTokens, estimateMessagesTokens } from './context-manager.js';
export type { CompactOptions, CompactResult } from './context-manager.js';

// Streaming Tool Executor (Phase 3 — tools execute as they arrive)
export { StreamingToolExecutor, READ_ONLY_TOOLS } from './streaming-executor.js';
export type {
  ToolCallRequest,
  ToolResult,
  ToolExecutorFn,
  StreamingExecutorOptions,
} from './streaming-executor.js';

// Interrupt Queue (Phase 3 — real-time steering)
export { InterruptQueue } from './interrupt-queue.js';
export type { UserInterrupt, InterruptType } from './interrupt-queue.js';

// Skill System (Phase 4 — SKILL.md + project rules)
export { SkillEngine } from './skills/engine.js';
export type { Skill, SkillSource, SkillContext, SkillSyncFn } from './skills/engine.js';
export { parseSkillFile } from './skills/parser.js';
export type { SkillFrontmatter, ParsedSkill } from './skills/parser.js';
export { loadProjectRules, filterRulesByFile } from './skills/rules.js';
export type { ProjectRule } from './skills/rules.js';
export { getSkillMetaTool, executeSkillMetaTool } from './skills/meta-tool.js';

// Tools
export { getReadTools, getWriteTools } from './tools.js';

// T10: RAG 模块
export { RagEngine } from './rag/index.js';
export type { RagEngineConfig, RagEngineDeps, IndexedDocument, IndexResult } from './rag/index.js';
export { chunkDocument } from './rag/chunker.js';
export type { ChunkOptions, TextChunk } from './rag/chunker.js';
export { createEmbedder } from './rag/embedder.js';
export type { EmbedderConfig, EmbedFn } from './rag/embedder.js';
export { VectorStore, cosineSimilarity } from './rag/vector-store.js';
export type { VectorRecord, VectorStoreDeps } from './rag/vector-store.js';
export { Retriever } from './rag/retriever.js';
export type { RetrievalResult, RetrieverDeps } from './rag/retriever.js';

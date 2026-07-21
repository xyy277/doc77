import {
  AiProvider,
  type AiMessage,
  type ToolDefinition,
  type StreamChunk,
} from '../provider/index.js';
import { t } from '@doc77/core';

export interface AgentConfig {
  provider: AiProvider;
  model?: string;
  tools?: ToolDefinition[];
  maxSteps?: number;
  /** Tool executor — called when DocAgent needs to execute a tool */
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface AgentResponse {
  message: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/**
 * Doc77 AI Agent — handles conversation with tool-use ReAct loop.
 */
export class DocAgent {
  private provider: AiProvider;
  private model: string;
  private tools: ToolDefinition[];
  private maxSteps: number;
  private messages: AiMessage[];
  private executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  private _hasContext = false;

  constructor(config: AgentConfig) {
    this.provider = config.provider;
    this.model = config.model || 'gpt-4o';
    this.tools = config.tools || [];
    this.maxSteps = config.maxSteps || 10;
    this.executeTool = config.executeTool || (async () => 'Tool execution not configured');
    this.messages = [{ role: 'system', content: t('ai.systemPrompt') }];
  }

  get hasContext(): boolean {
    return this._hasContext;
  }

  /**
   * Non-streaming chat — single turn, no tool loop.
   */
  async chat(userMessage: string): Promise<AgentResponse> {
    this.messages.push({ role: 'user', content: userMessage });

    const response = await this.provider.chat({
      model: this.model,
      messages: this.messages,
      tools: this.tools.length > 0 ? this.tools : undefined,
    });

    this.messages.push(response.message);
    return { message: response.message.content };
  }

  /**
   * Streaming chat with ReAct tool-use loop.
   *
   * Yields StreamChunks for token-by-token output and tool call status.
   * Automatically executes tools when the LLM requests them, then
   * continues the conversation with tool results injected.
   *
   * @param opts.noTools When true, tools are withheld from the provider for
   *   this call, forcing a single-turn answer with no ReAct tool loop. Use it
   *   when the relevant content is already injected into context (e.g. the
   *   user asked to summarize a file that's already been read), so the model
   *   answers directly instead of re-discovering the file via list_files/read_file.
   */
  async *chatStream(
    userMessage: string,
    opts?: { noTools?: boolean },
  ): AsyncGenerator<StreamChunk> {
    this.messages.push({ role: 'user', content: userMessage });

    const useTools = !opts?.noTools && this.tools.length > 0;
    console.error(`[ai] chatStream: start, tools=${this.tools.length}, useTools=${useTools}, maxSteps=${this.maxSteps}, history=${this.messages.length}msgs`);
    let step = 0;

    while (step < this.maxSteps) {
      step++;
      console.error(`[ai] chatStream: step ${step}/${this.maxSteps}, messages=${this.messages.length}`);

      let hasContent = false;
      let hasToolCalls = false;
      const toolCalls: Array<{ id: string; name: string; argsStr: string }> = [];

      // Stream from provider, collecting content and tool calls
      for await (const chunk of this.provider.chatStream({
        model: this.model,
        messages: this.messages,
        tools: useTools ? this.tools : undefined,
      })) {
        if (chunk.type === 'token') {
          hasContent = true;
          yield chunk;
        } else if (chunk.type === 'tool_call_start') {
          // UI-only signal — forward for real-time indicator, not for execution.
          yield chunk;
        } else if (chunk.type === 'tool_call') {
          hasToolCalls = true;
          toolCalls.push({
            id: chunk.id,
            name: chunk.name,
            argsStr: chunk.arguments,
          });
          yield chunk;
        } else if (chunk.type === 'done') {
          yield chunk;
        } else if (chunk.type === 'error') {
          yield chunk;
          return;
        }
      }

      // If no tool calls, conversation is complete
      if (!hasToolCalls || toolCalls.length === 0) {
        console.error(`[ai] chatStream: step ${step} done — no tool calls, loop end`);
        break;
      }
      console.error(`[ai] chatStream: step ${step} — LLM requested ${toolCalls.length} tool(s): ${toolCalls.map(tc => `${tc.name}(${(tc.argsStr || '').slice(0, 120)})`).join(', ')}`);

      // Add assistant message with tool_calls to history
      const assistantMsg: AiMessage = {
        role: 'assistant',
        content: hasContent ? '(tool calls made)' : '',
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argsStr },
        })),
      };
      this.messages.push(assistantMsg);

      // Execute each tool call and add results
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.argsStr);
        } catch {
          args = {};
        }

        console.error(`[ai] chatStream: step ${step} → exec tool "${tc.name}"`, args);
        const t0 = Date.now();
        try {
          const result = await this.executeTool(tc.name, args);
          const elapsed = Date.now() - t0;
          const resultPreview = (result || '').slice(0, 100);
          console.error(`[ai] chatStream: step ${step} ← tool "${tc.name}" OK (${elapsed}ms, ${result.length}chars): ${resultPreview}`);
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        } catch (e: unknown) {
          const elapsed = Date.now() - t0;
          const errMsg = e instanceof Error ? e.message : 'Unknown error';
          console.error(`[ai] chatStream: step ${step} ← tool "${tc.name}" ERROR (${elapsed}ms): ${errMsg}`);
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: ${errMsg}`,
          });
        }
      }

      // Continue loop — LLM will see tool results and generate final answer
    }
  }

  /**
   * Add project / file context as a system message.
   */
  addContext(context: string): void {
    this._hasContext = true;
    this.messages.push({
      role: 'system',
      content: `[Context]\n${context}`,
    });
  }

  /**
   * Reset conversation history.
   */
  reset(): void {
    this._hasContext = false;
    this.messages = [{ role: 'system', content: t('ai.systemPrompt') }];
  }

  /**
   * Get conversation history (shallow copy).
   */
  getHistory(): AiMessage[] {
    return [...this.messages];
  }

  /**
   * Replace the conversation history — used to rehydrate a persisted session
   * after a server restart. An empty array is ignored so the default system
   * prompt is never wiped out by a corrupt/empty record.
   */
  setHistory(messages: AiMessage[]): void {
    if (!messages || messages.length === 0) return;
    this.messages = [...messages];
    this._hasContext = true;
  }
}

/**
 * Quick AI capabilities — prompt generators.
 */
export function createClassifyPrompt(fileList: string): string {
  return t('ai.classifyPrompt', { fileList });
}

import {
  AiProvider,
  type AiMessage,
  type ToolDefinition,
  type StreamChunk,
} from '../provider/index.js';

const SYSTEM_PROMPT = `你是 Doc77 AI 助手，一个专业的本地文档管理智能体。

## 你的能力
1. **浏览项目** — 使用 list_files 查看目录结构，了解项目组织方式
2. **阅读文档** — 使用 read_file 读取文件内容，理解项目细节
3. **分析建议** — 基于实际文件内容，给出文档整理、分类、重命名的建议
4. **回答问题** — 基于项目文件内容回答用户问题

## 操作原则
1. **先看再答** — 用户问项目相关问题时，先用工具查看实际文件，再基于事实回答。不要凭空猜测。
2. **简洁有据** — 回答简洁，引用具体文件名和内容作为依据
3. **建议具体** — 给出文件整理建议时，使用具体的文件路径和操作描述
4. **中文优先** — 始终使用中文回复

## 安全约束
- 不要尝试读取 .env、.git、密钥文件等敏感文件
- 所有写操作（移动/删除/创建）需要用户确认后才能执行
- 超大文件（>50MB）建议用户手动处理`;

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
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
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
   */
  async *chatStream(userMessage: string): AsyncGenerator<StreamChunk> {
    this.messages.push({ role: 'user', content: userMessage });

    let step = 0;

    while (step < this.maxSteps) {
      step++;

      let hasContent = false;
      let hasToolCalls = false;
      const toolCalls: Array<{ id: string; name: string; argsStr: string }> = [];

      // Stream from provider, collecting content and tool calls
      for await (const chunk of this.provider.chatStream({
        model: this.model,
        messages: this.messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
      })) {
        if (chunk.type === 'token') {
          hasContent = true;
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
        break;
      }

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

        try {
          const result = await this.executeTool(tc.name, args);
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : 'Unknown error';
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
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  /**
   * Get conversation history (shallow copy).
   */
  getHistory(): AiMessage[] {
    return [...this.messages];
  }
}

/**
 * Quick AI capabilities — prompt generators.
 */
export function createSummarizePrompt(content: string): string {
  return `请用简洁的中文总结以下文档内容（不超过200字）：\n\n${content.slice(0, 4000)}`;
}

export function createClassifyPrompt(fileList: string): string {
  return `请分析以下文件列表，给出归类建议：\n\n${fileList}\n\n请按类别分组，并说明每组文件的特征。`;
}

export function createProjectSummaryPrompt(structure: string): string {
  return `请根据以下项目结构生成一个简短的摘要（不超过150字）：\n\n${structure}`;
}

import { AiProvider, type AiMessage, type ToolDefinition } from '../provider/index.js';

const SYSTEM_PROMPT = `你是 Doc77 AI 助手，一个专业的本地文档管理智能体。

你的职责：
1. 帮助用户管理本地项目文档（归类、重命名、整理、总结）
2. 分析目录结构，提出优化建议
3. 生成具体的文件操作指令（通过 MCP 工具）

操作原则：
1. 所有写操作必须通过 MCP 工具调用
2. 你的任务是"规划"和"建议"，最终执行权在用户手中
3. 生成操作建议时，需说明每个操作的意图和理由
4. 删除操作必须标注为 "高危操作"

文件大小感知规则：
- list_files 结果中包含每个文件的 size（字节）
- 若某个文件大小超过 50MB，避免对其生成 write_file 或 delete_file 建议
- 当用户要求整理超大文件时，应主动建议用户手动处理`;

export interface AgentConfig {
  provider: AiProvider;
  model?: string;
  tools?: ToolDefinition[];
  maxSteps?: number;
}

export interface AgentResponse {
  message: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/**
 * Doc77 AI Agent — handles conversation loop with optional tool-use.
 */
export class DocAgent {
  private provider: AiProvider;
  private model: string;
  private tools: ToolDefinition[];
  private maxSteps: number;
  private messages: AiMessage[] = [];

  constructor(config: AgentConfig) {
    this.provider = config.provider;
    this.model = config.model || 'gpt-4o';
    this.tools = config.tools || [];
    this.maxSteps = config.maxSteps || 10;
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  /**
   * Send a user message and get a response.
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
   * Add context about the current file/project.
   */
  addContext(context: string): void {
    this.messages.push({
      role: 'system',
      content: `[Context] ${context}`,
    });
  }

  /**
   * Reset conversation history.
   */
  reset(): void {
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  }

  /**
   * Get conversation history.
   */
  getHistory(): AiMessage[] {
    return [...this.messages];
  }
}

/**
 * Quick AI capabilities that don't require a full agent.
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

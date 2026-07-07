/**
 * AI Provider abstraction — OpenAI-compatible interface.
 */
export interface AiProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AiCompletionRequest {
  model: string;
  messages: AiMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  max_tokens?: number;
}

export interface AiCompletionResponse {
  message: AiMessage;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export class AiProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: AiProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.model = config.model || 'gpt-4o';
  }

  /**
   * Send a chat completion request.
   */
  async chat(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.model,
        messages: request.messages,
        tools: request.tools,
        stream: false,
        max_tokens: request.max_tokens || 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`AI API error (${response.status}): ${err}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          role: 'assistant';
          content: string;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    return {
      message: {
        role: 'assistant',
        content: choice.message.content || '',
      },
      usage: data.usage,
    };
  }
}

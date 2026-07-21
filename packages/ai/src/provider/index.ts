/**
 * AI Provider abstraction — OpenAI-compatible interface.
 * Supports both streaming (SSE) and non-streaming chat completions.
 */
export interface AiProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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

/**
 * Normalize messages before sending to the LLM API.
 *
 * Some local models (e.g. Qwen ChatML) require system messages to appear
 * only at the beginning of the conversation. This function merges all
 * system-role messages into a single message at index 0, then appends the
 * remaining non-system messages in their original order.
 *
 * When there is 0 or 1 system message the array is returned unchanged so
 * the common case incurs no allocation overhead.
 */
export function normalizeMessages(messages: AiMessage[]): AiMessage[] {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

  if (systemMsgs.length <= 1) return messages;

  const mergedContent = systemMsgs.map((m) => m.content).join('\n\n');
  return [
    { role: 'system' as const, content: mergedContent },
    ...nonSystemMsgs,
  ];
}

/** Unified chunk type for streaming responses */
export type StreamChunk =
  | { type: 'token'; content: string }
  | { type: 'tool_call_start'; name: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done'; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { type: 'error'; message: string };

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
   * Non-streaming chat completion.
   */
  async chat(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const normalized = normalizeMessages(request.messages);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.model,
        messages: normalized,
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
            type: 'function';
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
        tool_calls: choice.message.tool_calls,
      },
      usage: data.usage,
    };
  }

  /**
   * Streaming chat completion — returns an AsyncGenerator of StreamChunks.
   *
   * Handles:
   *  - Token-by-token content deltas
   *  - Tool call accumulation (multiple deltas per tool call)
   *  - Error propagation
   */
  async *chatStream(request: AiCompletionRequest): AsyncGenerator<StreamChunk> {
    const normalized = normalizeMessages(request.messages);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.model,
        messages: normalized,
        tools: request.tools,
        stream: true,
        max_tokens: request.max_tokens || 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      yield { type: 'error', message: `AI API error (${response.status}): ${err.slice(0, 200)}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', message: 'Response body is not readable' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    // Accumulate tool calls from streaming deltas
    const toolCallAcc: Map<number, { id: string; name: string; arguments: string }> = new Map();
    // Tool-call indices whose name has already been announced via tool_call_start.
    const started = new Set<number>();
    let finishReason = '';
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last potentially incomplete line
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            finishReason = 'stop';
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            // Token content
            if (delta.content) {
              yield { type: 'token', content: delta.content };
            }

            // Tool call deltas (may arrive in multiple chunks)
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = toolCallAcc.get(idx) || { id: '', name: '', arguments: '' };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                toolCallAcc.set(idx, existing);
                // Announce the tool as soon as its name is known — lets the UI
                // show the indicator in real time instead of at stream end.
                if (existing.name && !started.has(idx)) {
                  started.add(idx);
                  yield { type: 'tool_call_start', name: existing.name };
                }
              }
            }

            // Capture finish_reason
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // Usage (usually in the final chunk)
            if (parsed.usage) {
              usage = parsed.usage;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Emit completed tool calls
      if (finishReason === 'tool_calls' || toolCallAcc.size > 0) {
        for (const tc of toolCallAcc.values()) {
          if (tc.name) {
            yield {
              type: 'tool_call',
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            };
          }
        }
      }

      yield { type: 'done', usage };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      yield { type: 'error', message: `Stream error: ${message}` };
    } finally {
      reader.releaseLock();
    }
  }
}

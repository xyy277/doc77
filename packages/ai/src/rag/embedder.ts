/**
 * 向量嵌入器 — 调用 AI provider 生成文本向量。
 *
 * 支持两种 provider：
 * 1. OllamaProvider — 调用本地 Ollama 的 /api/embed 端点
 * 2. OpenAI 兼容 — 调用 /v1/embeddings 端点（custom provider）
 *
 * 设计：注入 embedFn 避免硬依赖具体 provider 类，便于测试 mock。
 */
export interface EmbedderConfig {
  /** 嵌入模型名称（如 'nomic-embed-text' / 'text-embedding-3-small'） */
  embedModel: string;
  /** provider 类型 */
  provider: 'ollama' | 'custom';
  /** Ollama 服务地址（仅 provider='ollama' 时使用） */
  ollamaUrl?: string;
  /** OpenAI 兼容 API 的 baseUrl + apiKey（仅 provider='custom' 时使用） */
  baseUrl?: string;
  apiKey?: string;
}

/** 嵌入函数签名 — 接受文本数组，返回向量数组 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * 创建嵌入函数。
 * 根据 config 选择 Ollama 或 OpenAI 兼容 API。
 */
export function createEmbedder(config: EmbedderConfig): EmbedFn {
  if (config.provider === 'ollama') {
    return async (texts: string[]) => {
      const ollamaUrl = config.ollamaUrl || 'http://localhost:11434';
      const res = await fetch(`${ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.embedModel, input: texts }),
      });
      if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings || [];
    };
  }

  // OpenAI 兼容
  return async (texts: string[]) => {
    const baseUrl = config.baseUrl || 'https://api.openai.com';
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.embedModel,
        input: texts,
      }),
    });
    if (!res.ok) throw new Error(`Embeddings API failed: ${res.status}`);
    const data = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data.map((d) => d.embedding);
  };
}

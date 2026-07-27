/**
 * Ollama AI Provider — local model support.
 * Ollama exposes an OpenAI-compatible API at /v1/ plus native API at /api/.
 */
import {
  AiProvider,
  type AiProviderConfig,
  type AiCompletionRequest,
  type AiCompletionResponse,
  type StreamChunk,
} from './index.js';

export interface OllamaModelInfo {
  id: string;
  name: string;
  size: number;
  parameterSize?: string;
  family?: string;
}

export interface OllamaProviderConfig extends AiProviderConfig {
  ollamaUrl?: string; // default http://localhost:11434
}

export class OllamaProvider extends AiProvider {
  private ollamaUrl: string;

  constructor(config: OllamaProviderConfig) {
    // Ollama's OpenAI-compatible endpoint
    const baseUrl = (config.ollamaUrl || 'http://localhost:11434') + '/v1';
    super({
      apiKey: config.apiKey || 'ollama', // Ollama doesn't need a real key
      baseUrl,
      model: config.model || 'qwen2.5:7b',
    });
    this.ollamaUrl = config.ollamaUrl || 'http://localhost:11434';
  }

  /**
   * Check if Ollama is running and accessible.
   */
  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await fetch(`${this.ollamaUrl}/api/version`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = (await res.json()) as { version: string };
      return { ok: true, version: data.version };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : 'Cannot connect' };
    }
  }

  /**
   * List installed models.
   */
  async listModels(): Promise<OllamaModelInfo[]> {
    try {
      const res = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models: Array<{
          name: string;
          size: number;
          details?: { parameter_size?: string; family?: string };
        }>;
      };
      return (data.models || []).map((m) => ({
        id: m.name,
        name: m.name,
        size: m.size,
        parameterSize: m.details?.parameter_size,
        family: m.details?.family,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Generate embeddings (for RAG).
   */
  async embed(model: string, texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) throw new Error(`Embed failed: ${res.status}`);
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings || [];
  }

  /**
   * Pull a model (download).
   */
  async pullModel(modelName: string): Promise<void> {
    const res = await fetch(`${this.ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: false }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Pull failed: ${err}`);
    }
  }
}

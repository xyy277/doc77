/**
 * 检索器 — 封装"查询问题 → 嵌入 → 向量检索 → 返回 top-k 块"流程。
 */
import type { EmbedFn } from './embedder.js';
import type { VectorStore, VectorRecord } from './vector-store.js';

export interface RetrievalResult {
  /** 检索到的相关块（按相似度降序） */
  chunks: VectorRecord[];
  /** 查询问题的嵌入向量（可用于调试） */
  queryEmbedding: number[];
}

export interface RetrieverDeps {
  embedFn: EmbedFn;
  store: VectorStore;
  /** 默认 top-k（默认 5） */
  defaultTopK?: number;
}

export class Retriever {
  private readonly embedFn: EmbedFn;
  private readonly store: VectorStore;
  private readonly defaultTopK: number;

  constructor(deps: RetrieverDeps) {
    this.embedFn = deps.embedFn;
    this.store = deps.store;
    this.defaultTopK = deps.defaultTopK ?? 5;
  }

  /**
   * 检索与问题最相关的 top-k 块。
   *
   * @param question 用户问题
   * @param projectId 项目 ID
   * @param topK 返回块数（默认 5）
   */
  async retrieve(question: string, projectId: number, topK?: number): Promise<RetrievalResult> {
    const k = topK ?? this.defaultTopK;
    const embeddings = await this.embedFn([question]);
    if (!embeddings || embeddings.length === 0) {
      return { chunks: [], queryEmbedding: [] };
    }
    const queryVec = embeddings[0];
    const chunks = this.store.query(queryVec, projectId, k);
    return { chunks, queryEmbedding: queryVec };
  }
}

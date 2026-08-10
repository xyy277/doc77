/**
 * RagEngine — RAG（检索增强生成）核心引擎。
 *
 * 整合 chunker + embedder + vector-store + retriever，提供：
 * - indexDocument(doc) — 索引文档（分块 + 嵌入 + 存储）
 * - query(question) — 检索相关块
 * - reset(projectId) — 清除项目索引
 *
 * 依赖注入：embedFn / db 由调用方注入，避免硬依赖具体 provider。
 */
import { chunkDocument, type ChunkOptions, type TextChunk } from './chunker.js';
import type { EmbedFn, EmbedderConfig } from './embedder.js';
import { createEmbedder } from './embedder.js';
import { VectorStore, type VectorRecord } from './vector-store.js';
import { Retriever, type RetrievalResult } from './retriever.js';
import type { DatabaseCompat } from '@doc77/core';

export interface RagEngineConfig {
  /** 嵌入模型配置 */
  embedder: EmbedderConfig;
  /** 分块参数（可选，用默认值） */
  chunkOptions?: ChunkOptions;
}

export interface RagEngineDeps {
  db: DatabaseCompat;
  config: RagEngineConfig;
  /** 可选：注入自定义 embedFn（测试用）。若不提供则根据 config 创建 */
  embedFn?: EmbedFn;
}

export interface IndexedDocument {
  projectId: number;
  filePath: string;
  content: string;
}

export interface IndexResult {
  /** 索引的块数 */
  chunkCount: number;
  /** 嵌入的向量数 */
  vectorCount: number;
}

export class RagEngine {
  private readonly store: VectorStore;
  private readonly retriever: Retriever;
  private readonly embedFn: EmbedFn;
  private readonly chunkOptions: ChunkOptions;

  constructor(deps: RagEngineDeps) {
    this.store = new VectorStore({ db: deps.db });
    this.embedFn = deps.embedFn || createEmbedder(deps.config.embedder);
    this.retriever = new Retriever({ embedFn: this.embedFn, store: this.store });
    this.chunkOptions = deps.config.chunkOptions || {};
  }

  /**
   * 索引一个文档：分块 → 嵌入 → 存储。
   * 若文件已索引，先删除旧块再重新索引。
   */
  async indexDocument(doc: IndexedDocument): Promise<IndexResult> {
    // 删除该文件的旧索引（重新索引场景）
    this.store.deleteByFile(doc.projectId, doc.filePath);

    const chunks = chunkDocument(doc.content, this.chunkOptions);
    if (chunks.length === 0) {
      return { chunkCount: 0, vectorCount: 0 };
    }

    // 批量嵌入
    const texts = chunks.map((c) => c.content);
    const embeddings = await this.embedFn(texts);

    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: ${embeddings.length} != ${chunks.length} chunks`);
    }

    // 批量存储
    const records = chunks.map((chunk, i) => ({
      projectId: doc.projectId,
      filePath: doc.filePath,
      chunkIndex: chunk.index,
      content: chunk.content,
      embedding: embeddings[i],
    }));
    this.store.storeBatch(records);

    return { chunkCount: chunks.length, vectorCount: embeddings.length };
  }

  /**
   * 检索与问题最相关的 top-k 块。
   */
  async query(question: string, projectId: number, topK?: number): Promise<RetrievalResult> {
    return this.retriever.retrieve(question, projectId, topK);
  }

  /**
   * 清除项目的所有索引。
   */
  reset(projectId: number): number {
    return this.store.deleteByProject(projectId);
  }

  /**
   * 统计项目索引块数。
   */
  count(projectId: number): number {
    return this.store.count(projectId);
  }
}

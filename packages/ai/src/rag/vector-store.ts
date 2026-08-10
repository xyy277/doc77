/**
 * 向量存储 — 基于 SQLite 的余弦相似度向量检索。
 *
 * 设计：
 * - embedding 存为 BLOB（Float32Array 的 Buffer）
 * - 查询时全量扫描计算余弦相似度（本地单用户场景，性能足够）
 * - 不使用 FTS5（FTS5 是关键词搜索，非向量搜索）
 * - 支持按 project_id 过滤
 */
import type { DatabaseCompat } from '@doc77/core';

export interface VectorRecord {
  id: number;
  projectId: number;
  filePath: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  createdAt: string;
}

export interface VectorStoreDeps {
  db: DatabaseCompat;
}

/**
 * 将 Float32Array 序列化为 Buffer 用于 DB 存储。
 */
function embeddingToBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/**
 * 将 Buffer 反序列化为 number[]。
 */
function bufferToEmbedding(buf: Buffer): number[] {
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(float32);
}

/**
 * 计算两个向量的余弦相似度。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class VectorStore {
  private readonly db: DatabaseCompat;

  constructor(deps: VectorStoreDeps) {
    this.db = deps.db;
  }

  /**
   * 存储一个向量块。
   */
  store(record: Omit<VectorRecord, 'id' | 'createdAt'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO rag_chunks (project_id, file_path, chunk_index, content, embedding)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.projectId,
        record.filePath,
        record.chunkIndex,
        record.content,
        embeddingToBuffer(record.embedding),
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * 批量存储向量块。
   */
  storeBatch(records: Array<Omit<VectorRecord, 'id' | 'createdAt'>>): number[] {
    const ids: number[] = [];
    const stmt = this.db.prepare(
      `INSERT INTO rag_chunks (project_id, file_path, chunk_index, content, embedding)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of records) {
      const result = stmt.run(
        r.projectId,
        r.filePath,
        r.chunkIndex,
        r.content,
        embeddingToBuffer(r.embedding),
      );
      ids.push(Number(result.lastInsertRowid));
    }
    return ids;
  }

  /**
   * 查询 top-k 最相似的块。
   *
   * 全量扫描 + 余弦相似度排序。本地单用户场景下 10K 块以内性能可接受。
   */
  query(queryVec: number[], projectId: number, topK: number = 5): VectorRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM rag_chunks WHERE project_id = ?')
      .all(projectId) as Array<{
      id: number;
      project_id: number;
      file_path: string;
      chunk_index: number;
      content: string;
      embedding: Buffer;
      created_at: string;
    }>;

    const scored = rows.map((row) => {
      const embedding = bufferToEmbedding(row.embedding);
      return {
        record: {
          id: row.id,
          projectId: row.project_id,
          filePath: row.file_path,
          chunkIndex: row.chunk_index,
          content: row.content,
          embedding,
          createdAt: row.created_at,
        } as VectorRecord,
        score: cosineSimilarity(queryVec, embedding),
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.record);
  }

  /**
   * 删除指定项目的所有向量块。
   */
  deleteByProject(projectId: number): number {
    const result = this.db.prepare('DELETE FROM rag_chunks WHERE project_id = ?').run(projectId);
    return result.changes;
  }

  /**
   * 删除指定文件的所有向量块。
   */
  deleteByFile(projectId: number, filePath: string): number {
    const result = this.db
      .prepare('DELETE FROM rag_chunks WHERE project_id = ? AND file_path = ?')
      .run(projectId, filePath);
    return result.changes;
  }

  /**
   * 统计指定项目的向量块数量。
   */
  count(projectId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM rag_chunks WHERE project_id = ?')
      .get(projectId) as { cnt: number };
    return row.cnt;
  }
}

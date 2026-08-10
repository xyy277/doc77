/**
 * T10: RAG 路由 — 索引文档 + 查询相关块 + 清除索引。
 *
 * 路由清单：
 * - POST   /api/ai/rag/index   — 索引文档（分块 + 嵌入 + 存储）
 * - POST   /api/ai/rag/query   — 查询相关块
 * - DELETE /api/ai/rag/:projectId — 清除项目索引
 *
 * 设计：registerAiRagRoutes(app, deps)，由 app.ts 挂载。
 *       使用与 sync routes 相同的 AppRouter 接口，避免强依赖 express。
 */
import type { RagEngine } from '@doc77/ai';
import type { DatabaseCompat } from '@doc77/core';

export interface AiRagRouteDeps {
  engine: RagEngine;
  db: DatabaseCompat;
}

/** 路由契约（与 sync routes 的 AppRouter 一致） */
export interface RagAppRouter {
  get(path: string, handler: (req: RagRequestLike, res: RagResponseLike) => void): unknown;
  post(path: string, handler: (req: RagRequestLike, res: RagResponseLike) => void): unknown;
  put(path: string, handler: (req: RagRequestLike, res: RagResponseLike) => void): unknown;
  delete(path: string, handler: (req: RagRequestLike, res: RagResponseLike) => void): unknown;
}

export interface RagRequestLike {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  method: string;
  path: string;
}

export interface RagResponseLike {
  status(code: number): this;
  json(data: unknown): void;
}

type Req = RagRequestLike;
type Res = RagResponseLike;

export function registerAiRagRoutes(app: RagAppRouter, deps: AiRagRouteDeps): void {
  const { engine } = deps;

  // ── POST /api/ai/rag/index — 索引文档 ──
  app.post('/api/ai/rag/index', async (req: Req, res: Res) => {
    const body = (req.body || {}) as {
      project_id?: number;
      file_path?: string;
      content?: string;
    };
    const { project_id, file_path, content } = body;
    if (!project_id || !file_path || content === undefined) {
      res.status(400).json({ error: 'project_id, file_path, content are required' });
      return;
    }
    try {
      const result = await engine.indexDocument({
        projectId: project_id,
        filePath: file_path,
        content,
      });
      res.json({ ok: true, ...result });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── POST /api/ai/rag/query — 查询相关块 ──
  app.post('/api/ai/rag/query', async (req: Req, res: Res) => {
    const body = (req.body || {}) as {
      question?: string;
      project_id?: number;
      top_k?: number;
    };
    const { question, project_id, top_k } = body;
    if (!question || !project_id) {
      res.status(400).json({ error: 'question, project_id are required' });
      return;
    }
    try {
      const result = await engine.query(question, project_id, top_k || 5);
      res.json({
        chunks: result.chunks.map((c) => ({
          file_path: c.filePath,
          chunk_index: c.chunkIndex,
          content: c.content,
        })),
      });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── DELETE /api/ai/rag/:projectId — 清除项目索引 ──
  app.delete('/api/ai/rag/:projectId', (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    try {
      const deleted = engine.reset(projectId);
      res.json({ ok: true, deleted });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/ai/rag/stats/:projectId — 统计项目索引 ──
  app.get('/api/ai/rag/stats/:projectId', (req: Req, res: Res) => {
    const projectId = parseInt(req.params.projectId, 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return;
    }
    try {
      const count = engine.count(projectId);
      res.json({ project_id: projectId, chunk_count: count });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}

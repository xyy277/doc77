/**
 * T10 验收测试 — RAG 模块
 *
 * 覆盖验收标准：
 * - chunkDocument 分块正确
 * - cosineSimilarity 余弦相似度计算
 * - VectorStore 存储 + 查询
 * - RagEngine indexDocument → query 完整流程（用 mock embedFn）
 * - POST /api/ai/rag/index 返回 200 且索引条数正确
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { initDatabase, closeConnection, getConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';
import { RagEngine } from '@doc77/ai';
import { registerAiRagRoutes } from '../src/server/routes/ai-rag.js';
import { chunkDocument } from '@doc77/ai';
import { cosineSimilarity } from '@doc77/ai';

let testDir: string;
let dbPath: string;

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `doc77-rag-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'data.db');
  await initDatabase(dbPath);
  runMigrations();
});

afterAll(() => {
  try {
    closeConnection();
  } catch {
    /* ignore */
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('T10 — chunker 分块器', () => {
  it('按段落分块', () => {
    const text = '这是第一段的内容，有足够长度来独立成块。\n\n这是第二段的内容，也有足够长度。\n\n这是第三段的内容，同样足够长。';
    const chunks = chunkDocument(text, { maxChunkSize: 25, minChunkSize: 1 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].content).toContain('第一段');
    expect(chunks[chunks.length - 1].content).toContain('第三段');
  });

  it('长段落硬切带重叠', () => {
    const long = 'A'.repeat(500) + '\n\n' + 'B'.repeat(500);
    const chunks = chunkDocument(long, { maxChunkSize: 200, minChunkSize: 1, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('空文本返回空数组', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   ')).toEqual([]);
  });
});

describe('T10 — cosineSimilarity 余弦相似度', () => {
  it('相同向量相似度为 1', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('正交向量相似度为 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('不同长度向量返回 0', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });
});

describe('T10 — RagEngine 索引 + 查询（mock embed）', () => {
  it('indexDocument → query 返回相关块', async () => {
    const db = getConnection();
    // 创建项目
    db.prepare('INSERT INTO projects (name, path) VALUES (?, ?)').run(
      'rag-test',
      path.join(testDir, 'rag-project'),
    );

    // mock embedFn：把文本哈希为固定维度向量
    // 相同文本 → 相同向量；不同文本 → 不同向量
    const mockEmbed = async (texts: string[]): Promise<number[][]> => {
      return texts.map((t) => {
        // 简单的确定性嵌入：基于字符的频率向量
        const vec = new Array(8).fill(0);
        for (const ch of t.toLowerCase()) {
          const idx = ch.charCodeAt(0) % 8;
          vec[idx] += 1;
        }
        // 归一化
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
        return vec.map((v) => v / norm);
      });
    };

    const engine = new RagEngine({
      db,
      config: {
        embedder: { provider: 'custom', embedModel: 'mock' },
        chunkOptions: { minChunkSize: 1 },
      },
      embedFn: mockEmbed,
    });

    // 索引文档
    const result = await engine.indexDocument({
      projectId: 1,
      filePath: 'test.md',
      content: '人工智能是计算机科学的一个分支。\n\n机器学习是人工智能的子领域。\n\n深度学习使用神经网络。',
    });
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.vectorCount).toBeGreaterThan(0);

    // 查询
    const queryResult = await engine.query('什么是机器学习', 1, 3);
    expect(queryResult.chunks.length).toBeGreaterThan(0);
    // 至少有一个块包含"机器学习"
    expect(queryResult.chunks.some((c) => c.content.includes('机器学习'))).toBe(true);

    // 统计
    expect(engine.count(1)).toBeGreaterThan(0);

    // 清除
    const deleted = engine.reset(1);
    expect(deleted).toBeGreaterThan(0);
    expect(engine.count(1)).toBe(0);
  });
});

/**
 * T10 路由集成测试
 */
describe('T10 — RAG 路由', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const db = getConnection();
    const mockEmbed = async (texts: string[]): Promise<number[][]> => {
      return texts.map(() => {
        const vec = new Array(4).fill(0).map(() => Math.random());
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
        return vec.map((v) => v / norm);
      });
    };
    const engine = new RagEngine({
      db,
      config: { embedder: { provider: 'custom', embedModel: 'mock' }, chunkOptions: { minChunkSize: 1 } },
      embedFn: mockEmbed,
    });

    // 简易路由器
    const routes: Array<{ method: string; pattern: RegExp; paramNames: string[]; handler: (req: any, res: any) => void }> = [];
    const addRoute = (method: string, p: string, h: any) => {
      const paramNames: string[] = [];
      const regexStr = p.replace(/:([^/]+)/g, (_, n) => { paramNames.push(n); return '([^/]+)'; });
      routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler: h });
    };
    const app = {
      get: (p: string, h: any) => addRoute('GET', p, h),
      post: (p: string, h: any) => addRoute('POST', p, h),
      put: (p: string, h: any) => addRoute('PUT', p, h),
      delete: (p: string, h: any) => addRoute('DELETE', p, h),
    };
    registerAiRagRoutes(app as any, { engine, db });

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      for (const route of routes) {
        if (route.method !== (req.method || '').toUpperCase()) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        let body: any = undefined;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(Buffer.from(c));
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
        }
        // 正确解析 params
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        const reqLike = { params, query: {}, body, method: req.method, path: url.pathname };
        const resLike = {
          _status: 200,
          status(code: number) { this._status = code; return this; },
          json(data: unknown) { res.writeHead(this._status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
        };
        await route.handler(reqLike, resLike);
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  it('POST /api/ai/rag/index 索引文档', async () => {
    const res = await fetch(`${baseUrl}/api/ai/rag/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 1,
        file_path: 'route-test.md',
        content: '这是路由测试文档内容。\n\n第二段内容。',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; chunkCount: number };
    expect(body.ok).toBe(true);
    expect(body.chunkCount).toBeGreaterThan(0);
  });

  it('POST /api/ai/rag/query 查询相关块', async () => {
    const res = await fetch(`${baseUrl}/api/ai/rag/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: '路由测试',
        project_id: 1,
        top_k: 5,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chunks: Array<{ content: string }> };
    expect(body.chunks.length).toBeGreaterThan(0);
  });

  it('GET /api/ai/rag/stats/1 统计索引', async () => {
    const res = await fetch(`${baseUrl}/api/ai/rag/stats/1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chunk_count: number };
    expect(body.chunk_count).toBeGreaterThan(0);
  });
});

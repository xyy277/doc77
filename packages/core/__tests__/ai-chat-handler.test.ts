import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import express from 'express';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createAIChatHandler, createApp } from '../src/server/app.js';

const TEST_DB = path.join(os.tmpdir(), 'doc77-test-ai-chat-' + Date.now() + '.db');

let server: http.Server;
let baseUrl: string;
let providerConstructed = 0;
let agentConstructed = 0;
let ollamaProviderConstructed = 0;

/** Stub provider — records construction, never talks to a network. */
class StubProvider {
  constructor(_config: { apiKey: string; baseUrl: string; model: string }) {
    providerConstructed++;
  }
}

/** Stub OllamaProvider — T4: 验证 ai.provider='ollama' 时被构造 */
class StubOllamaProvider {
  constructor(_config: { apiKey: string; model?: string; ollamaUrl?: string }) {
    ollamaProviderConstructed++;
  }
}

/** Stub agent — yields one token then done. */
class StubAgent {
  hasContext = false;
  constructor(_config: unknown) {
    agentConstructed++;
  }
  addContext(_ctx: string) {
    this.hasContext = true;
  }
  async *chatStream(_message: string, _opts?: { noTools?: boolean }) {
    yield { type: 'token' as const, content: 'stub-reply' };
    yield { type: 'done' as const };
  }
}

beforeAll(async () => {
  await initDatabase(TEST_DB);
  runMigrations();
  const db = getConnection();
  const ins = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  ins.run('ai.token', 'sk-test');
  ins.run('ai.base_url', 'http://127.0.0.1:1'); // never contacted (stub)
  ins.run('ai.model', 'stub-model');
  ins.run('ai.enabled', 'true');

  const app = express();
  app.use(express.json());
  app.post(
    '/api/ai/chat',
    createAIChatHandler({
      AiProvider: StubProvider as never,
      OllamaProvider: StubOllamaProvider as never,
      DocAgent: StubAgent as never,
      getReadTools: () => [],
    }),
  );
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  closeConnection();
  try {
    fs.unlinkSync(TEST_DB);
  } catch {}
});

describe('createAIChatHandler dependency wiring', () => {
  it('constructs injected AiProvider/DocAgent and streams without ReferenceError', async () => {
    // 默认 provider='custom'，应构造 StubProvider
    const res = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'summarize this doc' }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // Regression guard: a missing deps destructure surfaced as
    // "AI service error: AiProvider is not defined" in the SSE stream.
    expect(body).not.toContain('is not defined');
    expect(body).toContain('stub-reply');
    expect(providerConstructed).toBeGreaterThan(0);
    expect(agentConstructed).toBeGreaterThan(0);
  });
});

/**
 * T4 验收：ai.provider='ollama' 时 OllamaProvider 被构造（而非 AiProvider）
 */
describe('T4 — AI multi-provider switch', () => {
  let ollamaServer: http.Server;
  let ollamaBaseUrl: string;
  let ollamaProviderConstructedT4 = 0;
  let customProviderConstructedT4 = 0;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/ai/chat',
      createAIChatHandler({
        AiProvider: class {
          constructor(_c: unknown) {
            customProviderConstructedT4++;
          }
        } as never,
        OllamaProvider: class {
          constructor(_c: unknown) {
            ollamaProviderConstructedT4++;
          }
        } as never,
        DocAgent: StubAgent as never,
        getReadTools: () => [],
      }),
    );
    await new Promise<void>((resolve) => {
      ollamaServer = http.createServer(app).listen(0, () => {
        const addr = ollamaServer.address() as { port: number };
        ollamaBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    ollamaServer?.close();
  });

  it("ai.provider='ollama' → OllamaProvider 被构造（而非 AiProvider）", async () => {
    const db = getConnection();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('ai.provider', 'ollama')").run();
    const beforeOllama = ollamaProviderConstructedT4;
    const beforeCustom = customProviderConstructedT4;

    const res = await fetch(`${ollamaBaseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test ollama provider switch' }),
    });
    expect(res.status).toBe(200);
    expect(ollamaProviderConstructedT4).toBeGreaterThan(beforeOllama);
    // custom provider 不应被构造
    expect(customProviderConstructedT4).toBe(beforeCustom);
  });

  it("ai.provider='custom' → AiProvider 被构造（回归保护）", async () => {
    const db = getConnection();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('ai.provider', 'custom')").run();
    const beforeOllama = ollamaProviderConstructedT4;
    const beforeCustom = customProviderConstructedT4;

    const res = await fetch(`${ollamaBaseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test custom provider regression' }),
    });
    expect(res.status).toBe(200);
    expect(customProviderConstructedT4).toBeGreaterThan(beforeCustom);
    // ollama provider 不应被构造
    expect(ollamaProviderConstructedT4).toBe(beforeOllama);
  });
});

/**
 * T4 验收：GET /api/ai/providers 返回 ['custom', 'ollama']
 */
describe('T4 — GET /api/ai/providers route', () => {
  let appServer: http.Server;
  let appBaseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      appServer = http.createServer(app).listen(0, () => {
        const addr = appServer.address() as { port: number };
        appBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    appServer?.close();
  });

  it("returns ['custom', 'ollama']", async () => {
    const res = await fetch(`${appBaseUrl}/api/ai/providers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: string[] };
    expect(body.providers).toEqual(['custom', 'ollama']);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import express from 'express';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createAIChatHandler } from '../src/server/app.js';

const TEST_DB = path.join(os.tmpdir(), 'doc77-test-ai-chat-' + Date.now() + '.db');

let server: http.Server;
let baseUrl: string;
let providerConstructed = 0;
let agentConstructed = 0;

/** Stub provider — records construction, never talks to a network. */
class StubProvider {
  constructor(_config: { apiKey: string; baseUrl: string; model: string }) {
    providerConstructed++;
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

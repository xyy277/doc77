import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import express from 'express';
import { initDatabase, getConnection, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { initI18n } from '../src/i18n/index.js';
import { createAgentLoopHandler } from '../src/server/app.js';
import {
  createSession,
  getSession,
  getMessagePath,
  appendMessage,
} from '../src/db/session-store.js';

const TEST_DB = path.join(os.tmpdir(), 'doc77-test-agent-loop-' + Date.now() + '.db');

let server: http.Server;
let baseUrl: string;
let providerConstructed = 0;
let ollamaProviderConstructed = 0;

/** Stub AgentLoop — records construction, yields a fixed event stream. */
class StubAgentLoop {
  interrupts = { cancel: () => {}, inject: () => {} };
  private persistence: Record<string, unknown>;
  constructor(config: { persistence?: Record<string, unknown> }) {
    this.persistence = config.persistence || {};
  }
  async *run(
    sessionId: string,
    message: string,
    _opts?: { noTools?: boolean; skipAppendUser?: boolean },
  ): AsyncIterable<Record<string, unknown>> {
    // Mimic AgentLoop.run(): persist user + assistant messages to the
    // injected persistence adapter (the real loop does this in Layer 5).
    const append = this.persistence.appendMessage as (
      sid: string,
      msg: Record<string, unknown>,
    ) => string;
    if (append && message) {
      const userMsgId = append(sessionId, {
        role: 'user',
        content: message,
        parentId: null,
      });
      append(sessionId, {
        role: 'assistant',
        content: 'stub-reply',
        parentId: userMsgId,
      });
    }
    yield { type: 'session', sessionId };
    yield { type: 'token', content: 'stub-reply' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

/** Stub provider — records construction, never talks to a network. */
class StubProvider {
  constructor(_config: { apiKey: string; baseUrl: string; model: string }) {
    providerConstructed++;
  }
}

class StubOllamaProvider {
  constructor(_config: { apiKey: string; model?: string; ollamaUrl?: string }) {
    ollamaProviderConstructed++;
  }
}

/** Real adapter wiring AgentLoop persistence to the SessionStore tree tables. */
function makeRealAdapter() {
  return {
    appendMessage: (sId: string, msg: Record<string, unknown>) =>
      appendMessage(sId, msg as never).id,
    getCurrentLeafId: (sId: string) => getSession(sId)?.currentLeafId ?? null,
    getMessagePath: (sId: string) => getMessagePath(sId),
    addTokenUsage: () => {},
    logToolCall: () => 0,
  };
}

function startServer(deps: Record<string, unknown>): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post('/api/ai/chat', createAgentLoopHandler(deps as never));
  return new Promise<string>((resolve) => {
    const s = http.createServer(app).listen(0, () => {
      const addr = s.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

beforeAll(async () => {
  initI18n('');
  await initDatabase(TEST_DB);
  runMigrations();
  const db = getConnection();
  const ins = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  ins.run('ai.token', 'sk-test');
  ins.run('ai.base_url', 'http://127.0.0.1:1'); // never contacted (stub)
  ins.run('ai.model', 'stub-model');
  ins.run('ai.enabled', 'true');
});

afterAll(() => {
  server?.close();
  closeConnection();
  try {
    fs.unlinkSync(TEST_DB);
  } catch {}
});

describe('createAgentLoopHandler — SessionStore persistence (frontend reload contract)', () => {
  beforeAll(async () => {
    const db = getConnection();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('ai.provider', 'custom')").run();
    baseUrl = await startServer({
      AiProvider: StubProvider as never,
      AgentLoop: StubAgentLoop as never,
      createPersistenceAdapter: makeRealAdapter,
      getReadTools: () => [],
    });
  });

  it('streams session/token/done over SSE', async () => {
    const res = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('event: session');
    expect(body).toContain('event: token');
    expect(body).toContain('stub-reply');
    expect(body).toContain('event: done');
    expect(providerConstructed).toBeGreaterThan(0);
  });

  it('persists the session + messages to SessionStore (ai_sessions / ai_messages tree)', async () => {
    const res = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'persist me' }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const sidMatch = /"session_id":"([^"]+)"/.exec(body);
    expect(sidMatch).toBeTruthy();
    const sid = sidMatch![1];

    // ── Core regression guard ──
    // The frontend reloads messages via GET /api/ai/sessions/:id/messages/path
    // (SessionStore tree). Legacy createAIChatHandler never wrote here, so the
    // reload 404'd and wiped the chat area ("会话闪退"). The AgentLoop handler
    // must leave the session visible to getSession / getMessagePath.
    const session = getSession(sid);
    expect(session).not.toBeNull();

    const path = getMessagePath(sid);
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0].role).toBe('user');
    expect(path[path.length - 1].role).toBe('assistant');
  });

  it('reuses an existing session when session_id is passed', async () => {
    const session = createSession({ projectId: null, title: 'existing', model: 'stub-model' });
    const res = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'continue', session_id: session.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(session.id);
    // Messages append to the same session
    const path = getMessagePath(session.id);
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('createAgentLoopHandler — no project context behaviour', () => {
  let noPidBaseUrl: string;
  let loopConfig: Record<string, unknown> | null = null;

  /** Recording loop — captures the config the handler built for AgentLoop. */
  class RecordingLoop extends StubAgentLoop {
    constructor(config: Record<string, unknown>) {
      super(config);
      loopConfig = config;
    }
  }

  beforeAll(async () => {
    const db = getConnection();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('ai.provider', 'custom')").run();
    noPidBaseUrl = await startServer({
      AiProvider: StubProvider as never,
      AgentLoop: RecordingLoop as never,
      createPersistenceAdapter: makeRealAdapter,
      getReadTools: () => [
        { type: 'function', function: { name: 'list_files', description: 'x', parameters: {} } },
        { type: 'function', function: { name: 'list_projects', description: 'x', parameters: {} } },
      ],
    });
  });

  it('无 project_id 时：只注入 list_projects 工具，system prompt 含引导（不直接调文件工具）', async () => {
    loopConfig = null;
    const res = await fetch(`${noPidBaseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '分析一下项目' }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(loopConfig).not.toBeNull();
    // 工具被过滤：文件工具移除，仅保留 list_projects
    const tools = ((loopConfig!.tools as Array<{ function?: { name?: string } }>) || []).map(
      (t) => t.function?.name,
    );
    expect(tools).toEqual(['list_projects']);
    // system prompt 含"不要调用文件工具"的引导
    expect(String(loopConfig!.systemPrompt)).toContain('Do NOT call file tools');
  });
});

describe('createAgentLoopHandler — T4 provider switch (ollama/custom)', () => {
  let ollamaBaseUrl: string;
  let ollamaConstructedT4 = 0;
  let customConstructedT4 = 0;

  beforeAll(async () => {
    const db = getConnection();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('ai.provider', 'ollama')").run();
    ollamaBaseUrl = await startServer({
      AiProvider: class {
        constructor(_c: unknown) {
          customConstructedT4++;
        }
      } as never,
      OllamaProvider: class {
        constructor(_c: unknown) {
          ollamaConstructedT4++;
        }
      } as never,
      AgentLoop: StubAgentLoop as never,
      createPersistenceAdapter: makeRealAdapter,
      getReadTools: () => [],
    });
  });

  it("ai.provider='ollama' → OllamaProvider 被构造（而非 AiProvider）", async () => {
    const res = await fetch(`${ollamaBaseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'ollama test' }),
    });
    expect(res.status).toBe(200);
    expect(ollamaConstructedT4).toBeGreaterThan(0);
    expect(customConstructedT4).toBe(0);
  });
});

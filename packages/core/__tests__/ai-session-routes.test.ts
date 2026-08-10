/**
 * Integration tests for the Phase 2 AI session/message/search routes.
 *
 * Exercises the full HTTP stack: createApp() → Express router → SessionStore → SQLite.
 * Verifies multi-session CRUD, tree-structured message branching, and search.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { createApp } from '../src/server/app.js';
import { registerProject } from '../src/db/projects.js';
import { createSession, appendMessage, type AiSession } from '../src/db/session-store.js';

async function withServer(
  app: ReturnType<typeof createApp>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
  }
}

async function json(baseUrl: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

describe('AI Session Routes (Phase 2)', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `doc77-ai-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'data.db');
    await initDatabase(dbPath);
    runMigrations();
  });

  afterEach(async () => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── Session CRUD ────────────────────────────────────────

  describe('POST /api/ai/sessions', () => {
    it('creates a new session with default fields', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'POST', '/api/ai/sessions', {
          title: 'My Session',
          model: 'qwen2.5-7b',
        });
        expect(status).toBe(201);
        const session = (body as { session: AiSession }).session;
        expect(session.id).toBeTruthy();
        expect(session.title).toBe('My Session');
        expect(session.model).toBe('qwen2.5-7b');
        expect(session.status).toBe('active');
        expect(session.messageCount).toBe(0);
        expect(session.pinned).toBe(false);
      });
    });

    it('creates a session with project_id', async () => {
      // Register a real project first to satisfy the FK constraint
      const projectDir = path.join(testDir, 'proj');
      fs.mkdirSync(projectDir, { recursive: true });
      const projectId = registerProject('TestProj', projectDir).id;

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'POST', '/api/ai/sessions', {
          project_id: projectId,
          title: 'Project Session',
        });
        expect(status).toBe(201);
        expect((body as { session: AiSession }).session.projectId).toBe(projectId);
      });
    });

    it('rejects invalid project_id', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'POST', '/api/ai/sessions', {
          project_id: -5,
        });
        expect(status).toBe(400);
        expect((body as { error: string }).error).toContain('project_id');
      });
    });
  });

  describe('GET /api/ai/sessions', () => {
    it('lists sessions ordered by updated_at DESC', async () => {
      // Create sessions directly via store for control
      const s1 = createSession({ title: 'Session 1' });
      const s2 = createSession({ title: 'Session 2' });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'GET', '/api/ai/sessions');
        expect(status).toBe(200);
        const sessions = (body as { sessions: AiSession[] }).sessions;
        expect(sessions).toHaveLength(2);
        // Most recently created/updated should be first
        expect(sessions[0].id).toBe(s2.id);
        expect(sessions[1].id).toBe(s1.id);
      });
    });

    it('filters by pinned=true', async () => {
      const s1 = createSession({ title: 'Pinned' });
      createSession({ title: 'Unpinned' });
      // Pin s1 via the store (updateSession is not exposed via API yet,
      // but PATCH endpoint tests that separately)
      const { updateSession } = await import('../src/db/session-store.js');
      updateSession(s1.id, { pinned: true });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'GET', '/api/ai/sessions?pinned=1');
        expect(status).toBe(200);
        const sessions = (body as { sessions: AiSession[] }).sessions;
        expect(sessions).toHaveLength(1);
        expect(sessions[0].title).toBe('Pinned');
      });
    });

    it('filters by status', async () => {
      const s1 = createSession({ title: 'Active' });
      const s2 = createSession({ title: 'Archived' });
      const { updateSession } = await import('../src/db/session-store.js');
      updateSession(s2.id, { status: 'archived' });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        // Default: only non-deleted (active + archived)
        const { body: allBody } = await json(baseUrl, 'GET', '/api/ai/sessions');
        expect((allBody as { sessions: AiSession[] }).sessions).toHaveLength(2);

        // Filter: only archived
        const { body: archivedBody } = await json(
          baseUrl,
          'GET',
          '/api/ai/sessions?status=archived',
        );
        const archived = (archivedBody as { sessions: AiSession[] }).sessions;
        expect(archived).toHaveLength(1);
        expect(archived[0].title).toBe('Archived');
      });
    });
  });

  describe('GET /api/ai/sessions/:id', () => {
    it('returns 404 for non-existent session', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'GET', '/api/ai/sessions/nonexistent-id');
        expect(status).toBe(404);
        expect((body as { error: string }).error).toContain('not found');
      });
    });

    it('returns session details', async () => {
      const session = createSession({ title: 'Detail Test', model: 'test-model' });
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'GET', `/api/ai/sessions/${session.id}`);
        expect(status).toBe(200);
        expect((body as { session: AiSession }).session.title).toBe('Detail Test');
        expect((body as { session: AiSession }).session.model).toBe('test-model');
      });
    });
  });

  describe('PATCH /api/ai/sessions/:id', () => {
    it('updates title and pinned status', async () => {
      const session = createSession({ title: 'Original' });
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'PATCH', `/api/ai/sessions/${session.id}`, {
          title: 'Updated Title',
          pinned: true,
        });
        expect(status).toBe(200);
        const updated = (body as { session: AiSession }).session;
        expect(updated.title).toBe('Updated Title');
        expect(updated.pinned).toBe(true);
      });
    });

    it('returns 404 for non-existent session', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status } = await json(baseUrl, 'PATCH', '/api/ai/sessions/nope', { title: 'X' });
        expect(status).toBe(404);
      });
    });

    it('rejects invalid status value', async () => {
      const session = createSession({ title: 'Test' });
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'PATCH', `/api/ai/sessions/${session.id}`, {
          status: 'invalid',
        });
        expect(status).toBe(400);
        expect((body as { error: string }).error).toContain('status');
      });
    });
  });

  describe('DELETE /api/ai/sessions/:id', () => {
    it('soft-deletes a session', async () => {
      const session = createSession({ title: 'To Delete' });
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'DELETE', `/api/ai/sessions/${session.id}`);
        expect(status).toBe(200);
        expect((body as { id: string; status: string }).status).toBe('deleted');

        // Should not appear in default list
        const { body: listBody } = await json(baseUrl, 'GET', '/api/ai/sessions');
        const sessions = (listBody as { sessions: AiSession[] }).sessions;
        expect(sessions.find((s) => s.id === session.id)).toBeUndefined();

        // But should appear with status=deleted filter
        const { body: deletedBody } = await json(baseUrl, 'GET', '/api/ai/sessions?status=deleted');
        const deleted = (deletedBody as { sessions: AiSession[] }).sessions;
        expect(deleted.find((s) => s.id === session.id)).toBeTruthy();
      });
    });
  });

  describe('POST /api/ai/sessions/:id/purge', () => {
    it('permanently deletes a session', async () => {
      const session = createSession({ title: 'To Purge' });
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status } = await json(baseUrl, 'POST', `/api/ai/sessions/${session.id}/purge`);
        expect(status).toBe(200);

        // Should not appear even with status=deleted filter
        const { body } = await json(baseUrl, 'GET', '/api/ai/sessions?status=deleted');
        const sessions = (body as { sessions: AiSession[] }).sessions;
        expect(sessions.find((s) => s.id === session.id)).toBeUndefined();
      });
    });
  });

  // ── Message Tree ────────────────────────────────────────

  describe('GET /api/ai/sessions/:id/messages', () => {
    it('returns all messages in a session', async () => {
      const session = createSession({ title: 'Msg Test' });
      appendMessage(session.id, { role: 'user', content: 'Hello' });
      appendMessage(session.id, { role: 'assistant', content: 'Hi there' });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(
          baseUrl,
          'GET',
          `/api/ai/sessions/${session.id}/messages`,
        );
        expect(status).toBe(200);
        const messages = (body as { messages: unknown[] }).messages;
        expect(messages).toHaveLength(2);
      });
    });

    it('returns 404 for non-existent session', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status } = await json(baseUrl, 'GET', '/api/ai/sessions/nope/messages');
        expect(status).toBe(404);
      });
    });
  });

  describe('GET /api/ai/sessions/:id/messages/path', () => {
    it('returns the current branch path from root to leaf', async () => {
      const session = createSession({ title: 'Path Test' });
      const m1 = appendMessage(session.id, { role: 'user', content: 'First' });
      const m2 = appendMessage(session.id, { role: 'assistant', content: 'Reply 1' });
      const m3 = appendMessage(session.id, { role: 'user', content: 'Second' });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(
          baseUrl,
          'GET',
          `/api/ai/sessions/${session.id}/messages/path`,
        );
        expect(status).toBe(200);
        const path = (body as { path: { id: string }[] }).path;
        expect(path).toHaveLength(3);
        expect(path[0].id).toBe(m1.id);
        expect(path[2].id).toBe(m3.id);
      });
    });

    it('supports viewing a different branch via ?leaf_id=', async () => {
      const session = createSession({ title: 'Branch Path' });
      const m1 = appendMessage(session.id, { role: 'user', content: 'Question' });
      const m2 = appendMessage(session.id, { role: 'assistant', content: 'Answer A' });
      // Branch from m1: create a sibling of m2. m2b becomes the new current
      // leaf (appendMessage always updates current_leaf_id).
      const m2b = appendMessage(session.id, {
        role: 'assistant',
        content: 'Answer B',
        parentId: m1.id, // branch from m1, sibling of m2
      });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        // Default path goes through m2b (current leaf after last append)
        const { body: defaultBody } = await json(
          baseUrl,
          'GET',
          `/api/ai/sessions/${session.id}/messages/path`,
        );
        const defaultPath = (defaultBody as { path: { id: string }[] }).path;
        expect(defaultPath.map((m) => m.id)).toEqual([m1.id, m2b.id]);

        // View the original branch A via leaf_id=m2 (without mutating session state)
        const { body: branchBody } = await json(
          baseUrl,
          'GET',
          `/api/ai/sessions/${session.id}/messages/path?leaf_id=${m2.id}`,
        );
        const branchPath = (branchBody as { path: { id: string }[] }).path;
        expect(branchPath.map((m) => m.id)).toEqual([m1.id, m2.id]);
      });
    });
  });

  describe('GET /api/ai/sessions/:id/messages/:msgId/variants', () => {
    it('returns sibling variants for a branched message', async () => {
      const session = createSession({ title: 'Variants' });
      const m1 = appendMessage(session.id, { role: 'user', content: 'Q' });
      const m2a = appendMessage(session.id, { role: 'assistant', content: 'A1' });
      const m2b = appendMessage(session.id, { role: 'assistant', content: 'A2', parentId: m1.id });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(
          baseUrl,
          'GET',
          `/api/ai/sessions/${session.id}/messages/${m2a.id}/variants`,
        );
        expect(status).toBe(200);
        const variants = (
          body as { variants: { id: string; content: string }[]; currentIndex: number }
        ).variants;
        expect(variants).toHaveLength(2);
        expect(variants.map((v) => v.content).sort()).toEqual(['A1', 'A2']);
      });
    });
  });

  describe('POST /api/ai/sessions/:id/switch-branch', () => {
    it('switches the current leaf to a different branch', async () => {
      const session = createSession({ title: 'Switch' });
      const m1 = appendMessage(session.id, { role: 'user', content: 'Q' });
      const m2a = appendMessage(session.id, { role: 'assistant', content: 'A1' });
      const m2b = appendMessage(session.id, { role: 'assistant', content: 'A2', parentId: m1.id });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        // Initially current leaf is m2b (last appended)
        // Switch to m2a
        const { status, body } = await json(
          baseUrl,
          'POST',
          `/api/ai/sessions/${session.id}/switch-branch`,
          {
            leaf_message_id: m2a.id,
          },
        );
        expect(status).toBe(200);
        expect((body as { session: AiSession }).session.currentLeafId).toBe(m2a.id);

        // Verify path now goes through m2a
        const { body: pathBody } = await json(
          baseUrl,
          'GET',
          `/api/ai/sessions/${session.id}/messages/path`,
        );
        const path = (pathBody as { path: { id: string }[] }).path;
        expect(path.map((m) => m.id)).toEqual([m1.id, m2a.id]);
      });
    });
  });

  describe('POST /api/ai/sessions/:id/branch', () => {
    it('creates a new session branched from a message', async () => {
      // Register a real project to satisfy FK constraint on project_id
      const projectDir = path.join(testDir, 'branch-proj');
      fs.mkdirSync(projectDir, { recursive: true });
      const projectId = registerProject('BranchProj', projectDir).id;

      const session = createSession({ title: 'Source', projectId });
      const m1 = appendMessage(session.id, { role: 'user', content: 'Hello' });
      appendMessage(session.id, { role: 'assistant', content: 'World' });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(
          baseUrl,
          'POST',
          `/api/ai/sessions/${session.id}/branch`,
          {
            from_message_id: m1.id,
            title: 'Branched Session',
          },
        );
        expect(status).toBe(201);
        const branched = (body as { session: AiSession }).session;
        expect(branched.id).not.toBe(session.id);
        expect(branched.title).toBe('Branched Session');
        expect(branched.projectId).toBe(projectId);
        expect(branched.parentSessionId).toBe(session.id);
        expect(branched.currentLeafId).toBe(m1.id);
      });
    });

    it('returns 404 for non-existent source message', async () => {
      const session = createSession({ title: 'Source' });
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status } = await json(baseUrl, 'POST', `/api/ai/sessions/${session.id}/branch`, {
          from_message_id: 'nonexistent',
        });
        expect(status).toBe(404);
      });
    });
  });

  // ── Search ──────────────────────────────────────────────

  describe('GET /api/ai/search', () => {
    it('finds messages matching the query', async () => {
      const s1 = createSession({ title: 'Search Test' });
      appendMessage(s1.id, { role: 'user', content: 'How do I configure webpack?' });
      appendMessage(s1.id, { role: 'assistant', content: 'You can use webpack.config.js' });

      const s2 = createSession({ title: 'Other' });
      appendMessage(s2.id, { role: 'user', content: 'Tell me about webpack loaders' });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'GET', '/api/ai/search?q=webpack');
        expect(status).toBe(200);
        const results = (body as { results: { sessionId: string }[]; count: number }).results;
        expect(results.length).toBeGreaterThanOrEqual(2);
        expect((body as { count: number }).count).toBe(results.length);
      });
    });

    it('returns 400 when q is missing', async () => {
      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(baseUrl, 'GET', '/api/ai/search');
        expect(status).toBe(400);
        expect((body as { error: string }).error).toContain('q');
      });
    });

    it('filters by session_id', async () => {
      const s1 = createSession({ title: 'S1' });
      appendMessage(s1.id, { role: 'user', content: 'unique keyword xyz' });
      const s2 = createSession({ title: 'S2' });
      appendMessage(s2.id, { role: 'user', content: 'unique keyword xyz' });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(
          baseUrl,
          'GET',
          `/api/ai/search?q=xyz&session_id=${s1.id}`,
        );
        expect(status).toBe(200);
        const results = (body as { results: { sessionId: string }[] }).results;
        expect(results.every((r) => r.sessionId === s1.id)).toBe(true);
      });
    });
  });

  // ── Tool Logs ───────────────────────────────────────────

  describe('GET /api/ai/sessions/:id/tool-logs', () => {
    it('returns tool call audit logs', async () => {
      const session = createSession({ title: 'Tool Logs' });
      const { logToolCall } = await import('../src/db/session-store.js');
      logToolCall({
        sessionId: session.id,
        toolName: 'read_file',
        input: { file_path: 'test.txt' },
        output: 'content',
        elapsedMs: 42,
        success: true,
      });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status, body } = await json(
          baseUrl,
          'GET',
          `/api/ai/sessions/${session.id}/tool-logs`,
        );
        expect(status).toBe(200);
        const logs = (body as { logs: { toolName: string; success: boolean }[] }).logs;
        expect(logs).toHaveLength(1);
        expect(logs[0].toolName).toBe('read_file');
        expect(logs[0].success).toBe(true);
      });
    });
  });

  // ── Regenerate stub ─────────────────────────────────────

  describe('POST /api/ai/sessions/:id/messages/:msgId/regenerate', () => {
    it('returns 501 (Phase 3 stub)', async () => {
      const session = createSession({ title: 'Regen' });
      const msg = appendMessage(session.id, { role: 'assistant', content: 'reply' });

      const app = createApp();
      await withServer(app, async (baseUrl) => {
        const { status } = await json(
          baseUrl,
          'POST',
          `/api/ai/sessions/${session.id}/messages/${msg.id}/regenerate`,
        );
        expect(status).toBe(501);
      });
    });
  });
});

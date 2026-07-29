/**
 * SessionStore unit tests — verifies the tree-structured message store
 * (Phase 1 redesign) at the function level.
 *
 * Covers:
 *   - Session CRUD: createSession / getSession / updateSession / deleteSession
 *   - Message tree: appendMessage / getMessage / getMessagePath
 *   - Branching: switchBranch / getMessageChildren / getBranchVariants
 *   - Tool audit: logToolCall / getToolLogs
 *   - Token usage: addTokenUsage
 *   - Listing: listSessions (filtering by status/project/pinned)
 *   - Search: searchMessages (FTS5 or LIKE fallback)
 *
 * These are unit tests (direct function calls, no HTTP). The
 * ai-session-routes.test.ts file covers the HTTP integration layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { initDatabase, closeConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { registerProject } from '../src/db/projects.js';
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  listSessions,
  appendMessage,
  getMessage,
  getMessagePath,
  getSessionMessages,
  getMessageChildren,
  getBranchVariants,
  switchBranch,
  branchFromMessage,
  logToolCall,
  getToolLogs,
  addTokenUsage,
  searchMessages,
} from '../src/db/session-store.js';

describe('SessionStore — session CRUD', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
  });

  afterEach(() => {
    try { closeConnection(); } catch { /* ignore */ }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a session with defaults', () => {
    const s = createSession({});
    expect(s.id).toBeTruthy();
    expect(s.status).toBe('active');
    expect(s.title).toBe('');
    expect(s.messageCount).toBe(0);
    expect(s.pinned).toBe(false);
  });

  it('creates a session with title and project', () => {
    // registerProject requires a real project row to satisfy the FK
    const proj = registerProject('TestProj', testDir);
    const s = createSession({ title: 'My Chat', projectId: proj.id, model: 'qwen-7b' });
    expect(s.title).toBe('My Chat');
    expect(s.projectId).toBe(proj.id);
    expect(s.model).toBe('qwen-7b');
  });

  it('retrieves a session by id', () => {
    const created = createSession({ title: 'Find me' });
    const found = getSession(created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Find me');
  });

  it('returns null for unknown session id', () => {
    expect(getSession('nonexistent-uuid')).toBeNull();
  });

  it('updates session fields', () => {
    const s = createSession({ title: 'Original' });
    updateSession(s.id, { title: 'Renamed', pinned: true, status: 'archived' });
    const updated = getSession(s.id);
    expect(updated!.title).toBe('Renamed');
    expect(updated!.pinned).toBe(true);
    expect(updated!.status).toBe('archived');
  });

  it('soft-deletes a session (status=deleted)', () => {
    const s = createSession({});
    deleteSession(s.id);
    const found = getSession(s.id);
    expect(found!.status).toBe('deleted');
  });

  it('lists sessions filtered by status', () => {
    createSession({ title: 'active-1' });
    const s2 = createSession({ title: 'archived-1' });
    updateSession(s2.id, { status: 'archived' });

    const active = listSessions({ status: 'active', limit: 100 });
    const archived = listSessions({ status: 'archived', limit: 100 });
    expect(active.some(s => s.title === 'active-1')).toBe(true);
    expect(active.every(s => s.status === 'active')).toBe(true);
    expect(archived.some(s => s.title === 'archived-1')).toBe(true);
  });

  it('lists pinned sessions first when sorting', () => {
    const s1 = createSession({ title: 'unpinned' });
    const s2 = createSession({ title: 'pinned' });
    updateSession(s2.id, { pinned: true });

    const list = listSessions({ limit: 100 });
    const pinnedIdx = list.findIndex(s => s.title === 'pinned');
    const unpinnedIdx = list.findIndex(s => s.title === 'unpinned');
    expect(pinnedIdx).toBeLessThanOrEqual(unpinnedIdx);
  });
});

describe('SessionStore — message tree', () => {
  let testDir: string;
  let sessionId: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    const s = createSession({});
    sessionId = s.id;
  });

  afterEach(() => {
    try { closeConnection(); } catch { /* ignore */ }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('appends messages as a linear chain (parent → child)', () => {
    const u1 = appendMessage(sessionId, { role: 'user', content: 'hello', parentId: null });
    const a1 = appendMessage(sessionId, { role: 'assistant', content: 'hi there', parentId: u1.id });

    expect(u1.parentId).toBeNull();
    expect(a1.parentId).toBe(u1.id);

    const path = getMessagePath(sessionId);
    expect(path).toHaveLength(2);
    expect(path[0].content).toBe('hello');
    expect(path[1].content).toBe('hi there');
  });

  it('getMessagePath returns root → leaf order', () => {
    const u = appendMessage(sessionId, { role: 'user', content: 'q', parentId: null });
    const a = appendMessage(sessionId, { role: 'assistant', content: 'a', parentId: u.id });
    const u2 = appendMessage(sessionId, { role: 'user', content: 'q2', parentId: a.id });

    const path = getMessagePath(sessionId);
    expect(path.map(m => m.content)).toEqual(['q', 'a', 'q2']);
  });

  it('getMessage retrieves a single message by id', () => {
    const u = appendMessage(sessionId, { role: 'user', content: 'find me', parentId: null });
    const found = getMessage(u.id);
    expect(found).not.toBeNull();
    expect(found!.content).toBe('find me');
    expect(found!.role).toBe('user');
  });

  it('increments message_count on append', () => {
    appendMessage(sessionId, { role: 'user', content: '1', parentId: null });
    appendMessage(sessionId, { role: 'assistant', content: '2', parentId: null });
    const s = getSession(sessionId);
    expect(s!.messageCount).toBe(2);
  });

  it('getSessionMessages returns all messages (flat, no tree traversal)', () => {
    appendMessage(sessionId, { role: 'user', content: 'a', parentId: null });
    appendMessage(sessionId, { role: 'assistant', content: 'b', parentId: null });
    const all = getSessionMessages(sessionId);
    expect(all).toHaveLength(2);
  });
});

describe('SessionStore — branching', () => {
  let testDir: string;
  let sessionId: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-br-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    const s = createSession({});
    sessionId = s.id;
  });

  afterEach(() => {
    try { closeConnection(); } catch { /* ignore */ }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates sibling messages (branch variants) with the same parent', () => {
    const userMsg = appendMessage(sessionId, { role: 'user', content: 'question', parentId: null });
    const a1 = appendMessage(sessionId, { role: 'assistant', content: 'answer v1', parentId: userMsg.id });
    const a2 = appendMessage(sessionId, { role: 'assistant', content: 'answer v2', parentId: userMsg.id });

    // Both assistants are children of the same user message
    const children = getMessageChildren(userMsg.id);
    expect(children).toHaveLength(2);
    expect(children.map(c => c.content).sort()).toEqual(['answer v1', 'answer v2']);
  });

  it('getBranchVariants returns all siblings including the message itself', () => {
    const userMsg = appendMessage(sessionId, { role: 'user', content: 'q', parentId: null });
    const a1 = appendMessage(sessionId, { role: 'assistant', content: 'v1', parentId: userMsg.id });
    appendMessage(sessionId, { role: 'assistant', content: 'v2', parentId: userMsg.id });
    appendMessage(sessionId, { role: 'assistant', content: 'v3', parentId: userMsg.id });

    const variants = getBranchVariants(a1.id);
    expect(variants).toHaveLength(3);
  });

  it('switchBranch changes the current leaf and getMessagePath follows it', () => {
    const userMsg = appendMessage(sessionId, { role: 'user', content: 'q', parentId: null });
    const a1 = appendMessage(sessionId, { role: 'assistant', content: 'v1', parentId: userMsg.id });
    const a2 = appendMessage(sessionId, { role: 'assistant', content: 'v2', parentId: userMsg.id });

    // Default leaf is the last appended (a2)
    let path = getMessagePath(sessionId);
    expect(path[path.length - 1].id).toBe(a2.id);

    // Switch to a1
    switchBranch(sessionId, a1.id);
    path = getMessagePath(sessionId);
    expect(path[path.length - 1].id).toBe(a1.id);
    expect(path[path.length - 1].content).toBe('v1');
  });

  it('branchFromMessage creates a new session linked to the original', () => {
    const userMsg = appendMessage(sessionId, { role: 'user', content: 'q', parentId: null });
    appendMessage(sessionId, { role: 'assistant', content: 'a', parentId: userMsg.id });

    const forked = branchFromMessage(sessionId, userMsg.id, 'Forked session');
    expect(forked.id).not.toBe(sessionId);
    expect(forked.parentSessionId).toBe(sessionId);
    expect(forked.title).toBe('Forked session');

    // The forked session should have the message path up to the branch point
    const path = getMessagePath(forked.id);
    expect(path.length).toBeGreaterThanOrEqual(1);
    expect(path[0].content).toBe('q');
  });
});

describe('SessionStore — tool logs + token usage', () => {
  let testDir: string;
  let sessionId: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    const s = createSession({});
    sessionId = s.id;
  });

  afterEach(() => {
    try { closeConnection(); } catch { /* ignore */ }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('logs a tool call and retrieves it', () => {
    logToolCall({
      sessionId,
      messageId: null,
      toolName: 'list_files',
      input: '{"dir_path":"/"}',
      output: '["file1.txt"]',
      elapsedMs: 42,
      success: true,
    });

    const logs = getToolLogs(sessionId);
    expect(logs).toHaveLength(1);
    expect(logs[0].toolName).toBe('list_files');
    expect(logs[0].elapsedMs).toBe(42);
    expect(logs[0].success).toBe(true);
  });

  it('logs failed tool calls with error message', () => {
    logToolCall({
      sessionId,
      messageId: null,
      toolName: 'delete_file',
      input: '{}',
      output: '',
      elapsedMs: 5,
      success: false,
      errorMessage: 'Permission denied',
    });

    const logs = getToolLogs(sessionId);
    expect(logs[0].success).toBe(false);
    expect(logs[0].errorMessage).toBe('Permission denied');
  });

  it('accumulates token usage', () => {
    addTokenUsage(sessionId, 100, 50);
    addTokenUsage(sessionId, 200, 80);

    const s = getSession(sessionId);
    expect(s!.inputTokens).toBe(300);
    expect(s!.outputTokens).toBe(130);
  });
});

describe('SessionStore — search', () => {
  let testDir: string;
  let sessionId: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-search-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    const s = createSession({ title: 'search-test' });
    sessionId = s.id;
  });

  afterEach(() => {
    try { closeConnection(); } catch { /* ignore */ }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('searches messages by content keyword', () => {
    appendMessage(sessionId, { role: 'user', content: 'How do I configure authentication?', parentId: null });
    appendMessage(sessionId, { role: 'assistant', content: 'You can set up auth in the settings panel.', parentId: null });

    const results = searchMessages('authentication', { limit: 20 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // SearchMatch uses `snippet` (not `content`) — it may contain the
    // matched excerpt with FTS5 highlighting or the raw text via LIKE.
    expect(results.some(r => (r.snippet || '').toLowerCase().includes('authentication'))).toBe(true);
  });

  it('searches across multiple sessions', () => {
    const s2 = createSession({});
    appendMessage(sessionId, { role: 'user', content: 'unique-searchable-term-xyz', parentId: null });
    appendMessage(s2.id, { role: 'user', content: 'unique-searchable-term-xyz', parentId: null });

    const results = searchMessages('unique-searchable-term-xyz', { limit: 20 });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for no matches', () => {
    appendMessage(sessionId, { role: 'user', content: 'hello world', parentId: null });
    const results = searchMessages('nonexistent-term-12345', { limit: 20 });
    expect(results).toHaveLength(0);
  });
});

/**
 * SessionStore — SQLite-backed store for AI chat sessions with tree-structured
 * message branching, tool call audit, and full-text search.
 *
 * Replaces the old ai-sessions.ts which stored entire conversations as a
 * single JSON blob. This module provides message-level CRUD, branch
 * operations (edit/resend, regenerate), and FTS5/LIKE search.
 */

import { getConnection, type DatabaseCompat } from './connection.js';
import { fts5Available } from './migrations.js';

// ── Types ────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'archived' | 'deleted';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AiSession {
  id: string;
  projectId: number | null;
  title: string;
  status: SessionStatus;
  parentSessionId: string | null;
  model: string | null;
  systemPromptHash: string | null;
  currentLeafId: string | null;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessageRecord {
  id: string;
  sessionId: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  rawJson: string | null;
  toolCalls: string | null; // JSON string of tool_calls array
  toolCallId: string | null;
  toolName: string | null;
  reasoning: string | null;
  tokenCount: number | null;
  finishReason: string | null;
  metadata: string; // JSON string
  createdAt: string;
}

export interface ToolLogRecord {
  id: number;
  sessionId: string;
  messageId: string | null;
  toolName: string;
  inputJson: string | null;
  outputJson: string | null;
  elapsedMs: number | null;
  success: boolean;
  errorMessage: string | null;
  approvedBy: string | null;
  createdAt: string;
}

export interface SearchMatch {
  sessionId: string;
  messageId: string;
  role: MessageRole;
  snippet: string;
  sessionTitle: string;
  createdAt: string;
}

// ── Session CRUD ─────────────────────────────────────────────

/**
 * Create a new AI session.
 */
export function createSession(opts: {
  id?: string;
  projectId?: number | null;
  title?: string;
  model?: string | null;
}): AiSession {
  const db = getConnection();
  const id = opts.id || generateId();
  db.prepare(
    `INSERT INTO ai_sessions (id, project_id, title, model)
     VALUES (?, ?, ?, ?)`,
  ).run(id, opts.projectId ?? null, opts.title || '', opts.model ?? null);
  return getSession(id)!;
}

/**
 * Get a session by ID. Returns null if not found.
 */
export function getSession(id: string): AiSession | null {
  const db = getConnection();
  const row = db.prepare('SELECT * FROM ai_sessions WHERE id = ?').get(id);
  return row ? rowToSession(row as Record<string, unknown>) : null;
}

/**
 * Update session fields.
 */
export function updateSession(
  id: string,
  fields: Partial<Pick<AiSession, 'title' | 'status' | 'pinned' | 'model' | 'currentLeafId'>>,
): void {
  const db = getConnection();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.title !== undefined) {
    sets.push('title = ?');
    params.push(fields.title);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    params.push(fields.status);
  }
  if (fields.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(fields.pinned ? 1 : 0);
  }
  if (fields.model !== undefined) {
    sets.push('model = ?');
    params.push(fields.model);
  }
  if (fields.currentLeafId !== undefined) {
    sets.push('current_leaf_id = ?');
    params.push(fields.currentLeafId);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE ai_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * Soft-delete a session (set status = 'deleted').
 */
export function deleteSession(id: string): void {
  updateSession(id, { status: 'deleted' });
}

/**
 * Permanently delete a session and all its messages.
 */
export function purgeSession(id: string): void {
  const db = getConnection();
  db.prepare('DELETE FROM ai_sessions WHERE id = ?').run(id);
}

/**
 * List sessions with optional filters.
 */
export function listSessions(
  opts: {
    projectId?: number;
    status?: SessionStatus;
    search?: string;
    pinnedOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): AiSession[] {
  const db = getConnection();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.projectId !== undefined) {
    conditions.push('project_id = ?');
    params.push(opts.projectId);
  }
  if (opts.status !== undefined) {
    conditions.push('status = ?');
    params.push(opts.status);
  } else {
    conditions.push("status != 'deleted'");
  }
  if (opts.pinnedOnly) {
    conditions.push('pinned = 1');
  }
  if (opts.search) {
    conditions.push(
      '(title LIKE ? OR id IN (SELECT session_id FROM ai_messages WHERE content LIKE ?))',
    );
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const rows = db
    .prepare(
      `SELECT * FROM ai_sessions ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(rowToSession);
}

// ── Message Operations ───────────────────────────────────────

/**
 * Append a message to a session, linked to its parent.
 * Updates the session's current_leaf_id and message_count.
 */
export function appendMessage(
  sessionId: string,
  msg: {
    id?: string;
    parentId?: string | null;
    role: MessageRole;
    content: string;
    rawJson?: string | null;
    toolCalls?: unknown[] | null;
    toolCallId?: string | null;
    toolName?: string | null;
    reasoning?: string | null;
    tokenCount?: number | null;
    finishReason?: string | null;
    metadata?: Record<string, unknown>;
  },
): AiMessageRecord {
  const db = getConnection();
  const id = msg.id || generateId();
  const parentId = msg.parentId ?? null;

  // If parentId is null, try to use session's current_leaf_id
  const effectiveParent = parentId ?? getSessionCurrentLeaf(db, sessionId);

  db.prepare(
    `INSERT INTO ai_messages (id, session_id, parent_id, role, content, raw_json, tool_calls, tool_call_id, tool_name, reasoning, token_count, finish_reason, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    effectiveParent,
    msg.role,
    msg.content,
    msg.rawJson ?? null,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.toolCallId ?? null,
    msg.toolName ?? null,
    msg.reasoning ?? null,
    msg.tokenCount ?? null,
    msg.finishReason ?? null,
    JSON.stringify(msg.metadata ?? {}),
  );

  // Update session's current_leaf_id and counters
  db.prepare(
    `UPDATE ai_sessions SET current_leaf_id = ?, message_count = message_count + 1, updated_at = datetime('now') WHERE id = ?`,
  ).run(id, sessionId);

  if (msg.role === 'tool' || msg.toolCalls) {
    db.prepare(`UPDATE ai_sessions SET tool_call_count = tool_call_count + 1 WHERE id = ?`).run(
      sessionId,
    );
  }

  return getMessage(id)!;
}

/**
 * Get a single message by ID.
 */
export function getMessage(id: string): AiMessageRecord | null {
  const db = getConnection();
  const row = db.prepare('SELECT * FROM ai_messages WHERE id = ?').get(id);
  return row ? rowToMessage(row as Record<string, unknown>) : null;
}

/**
 * Get the message path from a leaf message up to the root (inclusive).
 * Returns array ordered from root → leaf.
 */
export function getMessagePath(sessionId: string, leafId?: string | null): AiMessageRecord[] {
  const db = getConnection();
  const session = getSession(sessionId);
  if (!session) return [];

  const effectiveLeafId = leafId ?? session.currentLeafId;
  if (!effectiveLeafId) return [];

  const path: AiMessageRecord[] = [];
  let currentId: string | null = effectiveLeafId;
  const visited = new Set<string>(); // prevent infinite loop

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const msg = getMessage(currentId);
    if (!msg) break;
    path.unshift(msg); // prepend (build root → leaf order)
    currentId = msg.parentId;
  }

  return path;
}

/**
 * Get all messages in a session (flat list, no tree structure).
 */
export function getSessionMessages(sessionId: string): AiMessageRecord[] {
  const db = getConnection();
  const rows = db
    .prepare('SELECT * FROM ai_messages WHERE session_id = ? ORDER BY created_at')
    .all(sessionId) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/**
 * Get children of a specific message (for branch navigation).
 */
export function getMessageChildren(parentId: string): AiMessageRecord[] {
  const db = getConnection();
  const rows = db
    .prepare('SELECT * FROM ai_messages WHERE parent_id = ? ORDER BY created_at')
    .all(parentId) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/**
 * Get the branch variants for a message position (siblings of the same parent).
 * Returns all messages sharing the same parent_id, including the current one.
 */
export function getBranchVariants(messageId: string): AiMessageRecord[] {
  const msg = getMessage(messageId);
  if (!msg) return [];
  if (!msg.parentId) return [msg]; // root has no siblings

  return getMessageChildren(msg.parentId);
}

/**
 * Switch to a different branch by updating the session's current_leaf_id.
 * The target must be a message in the same session.
 */
export function switchBranch(sessionId: string, leafMessageId: string): void {
  const msg = getMessage(leafMessageId);
  if (!msg || msg.sessionId !== sessionId) {
    throw new Error(`Message ${leafMessageId} not found in session ${sessionId}`);
  }
  updateSession(sessionId, { currentLeafId: leafMessageId });
}

/**
 * Branch a session from a specific message — creates a new session
 * that shares history up to the branch point, then diverges.
 */
export function branchFromMessage(
  sourceSessionId: string,
  fromMessageId: string,
  title?: string,
): AiSession {
  const sourceSession = getSession(sourceSessionId);
  if (!sourceSession) throw new Error(`Source session ${sourceSessionId} not found`);

  const branchMsg = getMessage(fromMessageId);
  if (!branchMsg || branchMsg.sessionId !== sourceSessionId) {
    throw new Error(`Message ${fromMessageId} not found in session ${sourceSessionId}`);
  }

  // Create new session linked to parent
  const newSession = createSession({
    projectId: sourceSession.projectId,
    title: title || `${sourceSession.title} (分支)`,
    model: sourceSession.model,
  });

  // Link new session as child of source
  const db = getConnection();
  db.prepare('UPDATE ai_sessions SET parent_session_id = ? WHERE id = ?').run(
    sourceSessionId,
    newSession.id,
  );

  // Set the new session's current_leaf_id to the branch point
  // (the user will continue the conversation from here)
  db.prepare('UPDATE ai_sessions SET current_leaf_id = ? WHERE id = ?').run(
    fromMessageId,
    newSession.id,
  );

  return getSession(newSession.id)!;
}

// ── Tool Call Logging ────────────────────────────────────────

/**
 * Log a tool call to the audit table.
 */
export function logToolCall(entry: {
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  input?: unknown;
  output?: unknown;
  elapsedMs?: number;
  success?: boolean;
  errorMessage?: string | null;
  approvedBy?: string | null;
}): number {
  const db = getConnection();
  const result = db
    .prepare(
      `INSERT INTO ai_tool_logs (session_id, message_id, tool_name, input_json, output_json, elapsed_ms, success, error_message, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.sessionId,
      entry.messageId ?? null,
      entry.toolName,
      entry.input != null ? JSON.stringify(entry.input) : null,
      entry.output != null ? JSON.stringify(entry.output) : null,
      entry.elapsedMs ?? null,
      entry.success === false ? 0 : 1,
      entry.errorMessage ?? null,
      entry.approvedBy ?? null,
    );
  return result.lastInsertRowid as number;
}

/**
 * Get tool call logs for a session.
 */
export function getToolLogs(sessionId: string, limit = 100): ToolLogRecord[] {
  const db = getConnection();
  const rows = db
    .prepare('SELECT * FROM ai_tool_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(sessionId, limit) as Record<string, unknown>[];
  return rows.map(rowToToolLog);
}

// ── Full-Text Search ─────────────────────────────────────────

/**
 * Search message content across all sessions.
 * Uses FTS5 when available, otherwise degrades to LIKE.
 */
export function searchMessages(
  query: string,
  opts: {
    sessionId?: string;
    projectId?: number;
    limit?: number;
  } = {},
): SearchMatch[] {
  const db = getConnection();
  const limit = opts.limit ?? 20;

  if (fts5Available) {
    return searchMessagesFts5(db, query, opts, limit);
  }
  return searchMessagesLike(db, query, opts, limit);
}

function searchMessagesFts5(
  db: DatabaseCompat,
  query: string,
  opts: { sessionId?: string; projectId?: number },
  limit: number,
): SearchMatch[] {
  const conditions: string[] = ['ai_messages_fts MATCH ?'];
  const params: unknown[] = [sanitizeFtsQuery(query)];

  if (opts.sessionId) {
    conditions.push('m.session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.projectId !== undefined) {
    conditions.push('s.project_id = ?');
    params.push(opts.projectId);
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title as session_title
     FROM ai_messages_fts
     JOIN ai_messages m ON m.rowid = ai_messages_fts.rowid
     JOIN ai_sessions s ON s.id = m.session_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.created_at DESC
     LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: string;
    session_id: string;
    role: string;
    content: string;
    created_at: string;
    session_title: string;
  }>;

  return rows.map((r) => ({
    sessionId: r.session_id,
    messageId: r.id,
    role: r.role as MessageRole,
    snippet: r.content.slice(0, 200),
    sessionTitle: r.session_title,
    createdAt: r.created_at,
  }));
}

function searchMessagesLike(
  db: DatabaseCompat,
  query: string,
  opts: { sessionId?: string; projectId?: number },
  limit: number,
): SearchMatch[] {
  const conditions: string[] = ['m.content LIKE ?'];
  const params: unknown[] = [`%${query}%`];

  if (opts.sessionId) {
    conditions.push('m.session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.projectId !== undefined) {
    conditions.push('s.project_id = ?');
    params.push(opts.projectId);
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title as session_title
     FROM ai_messages m
     JOIN ai_sessions s ON s.id = m.session_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.created_at DESC
     LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: string;
    session_id: string;
    role: string;
    content: string;
    created_at: string;
    session_title: string;
  }>;

  return rows.map((r) => ({
    sessionId: r.session_id,
    messageId: r.id,
    role: r.role as MessageRole,
    snippet: r.content.slice(0, 200),
    sessionTitle: r.session_title,
    createdAt: r.created_at,
  }));
}

// ── Token Tracking ───────────────────────────────────────────

/**
 * Update token counts for a session.
 */
export function addTokenUsage(sessionId: string, inputTokens: number, outputTokens: number): void {
  const db = getConnection();
  db.prepare(
    `UPDATE ai_sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(inputTokens, outputTokens, sessionId);
}

// ── Skill Registry ───────────────────────────────────────────

/**
 * Register or update a skill in the database.
 */
export function upsertSkill(skill: {
  id: string;
  source: string;
  sourcePath?: string | null;
  description: string;
  enabled?: boolean;
  globs?: string[] | null;
  alwaysApply?: boolean;
  frontmatterHash?: string | null;
}): void {
  const db = getConnection();
  db.prepare(
    `INSERT INTO ai_skills (id, source, source_path, description, enabled, globs, always_apply, frontmatter_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source,
       source_path = excluded.source_path,
       description = excluded.description,
       globs = excluded.globs,
       always_apply = excluded.always_apply,
       frontmatter_hash = excluded.frontmatter_hash,
       updated_at = datetime('now')`,
  ).run(
    skill.id,
    skill.source,
    skill.sourcePath ?? null,
    skill.description,
    skill.enabled === false ? 0 : 1,
    skill.globs ? JSON.stringify(skill.globs) : null,
    skill.alwaysApply ? 1 : 0,
    skill.frontmatterHash ?? null,
  );
}

/**
 * List all enabled skills.
 */
export function getEnabledSkills(): Array<{
  id: string;
  source: string;
  description: string;
  globs: string[] | null;
  alwaysApply: boolean;
}> {
  const db = getConnection();
  const rows = db.prepare('SELECT * FROM ai_skills WHERE enabled = 1').all() as Record<
    string,
    unknown
  >[];
  return rows.map((r) => ({
    id: r.id as string,
    source: r.source as string,
    description: r.description as string,
    globs: r.globs ? JSON.parse(r.globs as string) : null,
    alwaysApply: r.always_apply === 1,
  }));
}

/**
 * Enable or disable a skill.
 */
export function setSkillEnabled(id: string, enabled: boolean): void {
  const db = getConnection();
  db.prepare("UPDATE ai_skills SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(
    enabled ? 1 : 0,
    id,
  );
}

// ── Helpers ──────────────────────────────────────────────────

function getSessionCurrentLeaf(db: DatabaseCompat, sessionId: string): string | null {
  const row = db.prepare('SELECT current_leaf_id FROM ai_sessions WHERE id = ?').get(sessionId) as
    { current_leaf_id: string | null } | undefined;
  return row?.current_leaf_id ?? null;
}

function rowToSession(r: Record<string, unknown>): AiSession {
  return {
    id: r.id as string,
    projectId: r.project_id as number | null,
    title: r.title as string,
    status: r.status as SessionStatus,
    parentSessionId: r.parent_session_id as string | null,
    model: r.model as string | null,
    systemPromptHash: r.system_prompt_hash as string | null,
    currentLeafId: r.current_leaf_id as string | null,
    messageCount: r.message_count as number,
    toolCallCount: r.tool_call_count as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    pinned: r.pinned === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToMessage(r: Record<string, unknown>): AiMessageRecord {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    parentId: r.parent_id as string | null,
    role: r.role as MessageRole,
    content: r.content as string,
    rawJson: r.raw_json as string | null,
    toolCalls: r.tool_calls as string | null,
    toolCallId: r.tool_call_id as string | null,
    toolName: r.tool_name as string | null,
    reasoning: r.reasoning as string | null,
    tokenCount: r.token_count as number | null,
    finishReason: r.finish_reason as string | null,
    metadata: (r.metadata as string) || '{}',
    createdAt: r.created_at as string,
  };
}

function rowToToolLog(r: Record<string, unknown>): ToolLogRecord {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    messageId: r.message_id as string | null,
    toolName: r.tool_name as string,
    inputJson: r.input_json as string | null,
    outputJson: r.output_json as string | null,
    elapsedMs: r.elapsed_ms as number | null,
    success: r.success === 1,
    errorMessage: r.error_message as string | null,
    approvedBy: r.approved_by as string | null,
    createdAt: r.created_at as string,
  };
}

/**
 * Sanitize a query string for FTS5 MATCH.
 */
function sanitizeFtsQuery(q: string): string {
  const sanitized = q.replace(/[;{}()\\]/g, ' ').trim();
  if (!sanitized) return '""';
  const words = sanitized.split(/\s+/).filter(Boolean);
  return words.map((w) => `"${w}"*`).join(' OR ');
}

/**
 * Simple UUID v4 generator (no external dependency).
 */
function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

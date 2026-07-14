import { getConnection } from './connection.js';

/**
 * SQLite-backed store for AI chat sessions — persists the conversation history
 * so a chat survives a server restart (the in-memory agent cache is rebuilt
 * from here on demand). Keyed by session_id.
 */
export interface StoredAiSession {
  projectId?: number;
  messages: unknown[];
}

export function saveAiSession(
  sessionId: string,
  projectId: number | undefined,
  messages: unknown[],
): void {
  const db = getConnection();
  db.prepare(
    `INSERT INTO ai_chat_sessions (session_id, project_id, messages, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       project_id = excluded.project_id,
       messages = excluded.messages,
       updated_at = datetime('now')`,
  ).run(sessionId, projectId ?? null, JSON.stringify(messages));
}

export function loadAiSession(sessionId: string): StoredAiSession | null {
  const db = getConnection();
  const row = db
    .prepare('SELECT project_id, messages FROM ai_chat_sessions WHERE session_id = ?')
    .get(sessionId) as { project_id: number | null; messages: string } | undefined;
  if (!row) return null;
  let messages: unknown[] = [];
  try {
    messages = JSON.parse(row.messages);
  } catch {
    messages = [];
  }
  return { projectId: row.project_id ?? undefined, messages };
}

export function deleteAiSession(sessionId: string): void {
  getConnection().prepare('DELETE FROM ai_chat_sessions WHERE session_id = ?').run(sessionId);
}

/** Delete sessions older than the given age; returns the number removed. */
export function pruneAiSessions(ttlHours = 24): number {
  const db = getConnection();
  const result = db
    .prepare(
      `DELETE FROM ai_chat_sessions
       WHERE datetime(updated_at, '+' || ? || ' hours') < datetime('now')`,
    )
    .run(ttlHours);
  return result.changes;
}

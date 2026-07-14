import { randomUUID } from 'node:crypto';

export interface SessionAgent {}

interface SessionEntry {
  agent: SessionAgent;
  projectId?: number;
  updatedAt: number;
}

const sessions = new Map<string, SessionEntry>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 6;

function cleanupExpiredSessions(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

export function getOrCreateSession<T extends SessionAgent>(
  sessionId: string | undefined,
  createAgent: () => T,
  projectId?: number,
): { sessionId: string; agent: T; isNew: boolean } {
  cleanupExpiredSessions();

  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing && existing.projectId === projectId) {
      existing.updatedAt = Date.now();
      return { sessionId, agent: existing.agent as T, isNew: false };
    }
  }

  const nextSessionId = sessionId || randomUUID();
  const agent = createAgent();
  sessions.set(nextSessionId, {
    agent,
    projectId,
    updatedAt: Date.now(),
  });

  return { sessionId: nextSessionId, agent, isNew: true };
}

export function resetSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

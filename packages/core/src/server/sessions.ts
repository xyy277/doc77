/**
 * Generic session agent interface — avoids direct dependency on @doc77/ai.
 */
export interface SessionAgent {
  hasContext?: boolean;
  runWithTools(message: string): Promise<string>;
  reset(): void;
  getHistory(): { role: string; content: string }[];
}

interface SessionEntry {
  agent: SessionAgent;
  projectId: number | null;
  lastAccess: number;
}

const sessions = new Map<string, SessionEntry>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create a session with the given agent factory.
 */
export function getOrCreateSession(
  sessionId: string | undefined,
  agentFactory: () => SessionAgent,
  projectId?: number,
): { sessionId: string; agent: SessionAgent } {
  // Cleanup expired sessions
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }

  // Reuse existing session
  if (sessionId && sessions.has(sessionId)) {
    const entry = sessions.get(sessionId)!;
    entry.lastAccess = now;
    return { sessionId, agent: entry.agent };
  }

  // Create new session
  const newId = sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agent = agentFactory();
  sessions.set(newId, { agent, projectId: projectId ?? null, lastAccess: now });
  return { sessionId: newId, agent };
}

/** Reset (clear history of) a specific session. */
export function resetSession(sessionId: string): boolean {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  entry.agent.reset();
  return true;
}

/** Delete a session. */
export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

/** Get conversation history for a session. */
export function getSessionHistory(sessionId: string): { role: string; content: string }[] | null {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  return entry.agent.getHistory();
}

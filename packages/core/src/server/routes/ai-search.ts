/**
 * AI Search Routes
 *
 * Cross-session full-text search over AI message content. Delegates to
 * SessionStore.searchMessages() which uses FTS5 when available and
 * degrades to LIKE-based matching otherwise.
 *
 * Endpoint:
 *   GET /api/ai/search?q=keyword  全文搜索会话消息
 *     Query params:
 *       q          (required) search keyword
 *       session_id (optional) restrict to a single session
 *       project_id (optional) restrict to a project's sessions
 *       limit      (optional) max results, default 20, max 100
 */

import type { Express, Request, Response } from 'express';
import { searchMessages } from '../../db/session-store.js';

/**
 * Mount the AI search route onto the Express app.
 * Call this once from createApp() before the error handler.
 */
export function registerAiSearchRoutes(app: Express): void {
  app.get('/api/ai/search', (req: Request, res: Response) => {
    const query = (req.query.q as string | undefined)?.trim();
    if (!query) {
      res.status(400).json({ error: 'q parameter is required' });
      return;
    }

    const sessionId = (req.query.session_id as string | undefined) || undefined;
    const projectId = req.query.project_id != null
      ? Number(req.query.project_id)
      : undefined;
    const limit = req.query.limit != null
      ? Math.min(Number(req.query.limit) || 20, 100)
      : 20;

    // Validate project_id if provided
    if (req.query.project_id != null && !Number.isFinite(projectId)) {
      res.status(400).json({ error: 'project_id must be a number' });
      return;
    }

    try {
      const results = searchMessages(query, {
        sessionId,
        projectId: Number.isFinite(projectId) ? projectId : undefined,
        limit,
      });
      res.json({
        query,
        results,
        count: results.length,
      });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}

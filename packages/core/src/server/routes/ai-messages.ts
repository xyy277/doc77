/**
 * AI Message Tree Routes
 *
 * Provides read access to the tree-structured message history of a session,
 * including branch navigation (children/variants) and the current branch
 * path from root to leaf. Also exposes tool-call audit logs.
 *
 * The `regenerate` endpoint is a stub until the AgentLoop (Phase 3) lands;
 * it currently returns 501 so the frontend can feature-detect.
 *
 * Endpoints:
 *   GET   /api/ai/sessions/:id/messages                       全部消息（扁平列表）
 *   GET   /api/ai/sessions/:id/messages/path                  当前分支路径（root→leaf）
 *   GET   /api/ai/sessions/:id/messages/:msgId/children       消息的直接子节点
 *   GET   /api/ai/sessions/:id/messages/:msgId/variants       分支变体（同级兄弟）
 *   GET   /api/ai/sessions/:id/tool-logs                      工具调用审计日志
 *   POST  /api/ai/sessions/:id/messages/:msgId/regenerate     重新生成回复（Phase 3）
 */

import type { Express, Request, Response } from 'express';
import {
  getSession,
  getMessage,
  getMessagePath,
  getSessionMessages,
  getMessageChildren,
  getBranchVariants,
  getToolLogs,
} from '../../db/session-store.js';

/**
 * Mount AI message-tree routes onto the Express app.
 * Call this once from createApp() before the error handler.
 */
export function registerAiMessageRoutes(app: Express): void {
  // ── GET /api/ai/sessions/:id/messages — 全部消息 ─────────
  // Returns a flat list of all messages in the session, ordered by
  // creation time. The frontend uses this to build the tree view;
  // branch structure is inferred from parent_id links.
  app.get('/api/ai/sessions/:id/messages', (req: Request, res: Response) => {
    const sessionId = req.params.id as string;
    try {
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const messages = getSessionMessages(sessionId);
      res.json({ messages });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/ai/sessions/:id/messages/path — 当前分支路径 ─
  // Returns the message path from root to the current leaf
  // (session.current_leaf_id). Pass ?leaf_id= to view a different
  // branch without mutating session state — used for preview-on-hover.
  app.get('/api/ai/sessions/:id/messages/path', (req: Request, res: Response) => {
    const sessionId = req.params.id as string;
    const leafId = (req.query.leaf_id as string | undefined) ?? null;
    try {
      const session = getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const path = getMessagePath(sessionId, leafId);
      res.json({
        path,
        currentLeafId: session.currentLeafId,
        messageCount: session.messageCount,
      });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/ai/sessions/:id/messages/:msgId/children ────
  // Direct children of a message — used to render the branch picker
  // (`[‹] 2/3 [›]`) when a message has multiple variants.
  app.get('/api/ai/sessions/:id/messages/:msgId/children', (req: Request, res: Response) => {
    const sessionId = req.params.id as string;
    const msgId = req.params.msgId as string;
    try {
      const msg = getMessage(msgId);
      if (!msg || msg.sessionId !== sessionId) {
        res.status(404).json({ error: 'Message not found in this session' });
        return;
      }
      const children = getMessageChildren(msgId);
      res.json({ children });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/ai/sessions/:id/messages/:msgId/variants ────
  // Sibling variants sharing the same parent — i.e. alternative
  // responses/regenerations at the same conversational position.
  // For a root message (no parent), returns just [self].
  app.get('/api/ai/sessions/:id/messages/:msgId/variants', (req: Request, res: Response) => {
    const sessionId = req.params.id as string;
    const msgId = req.params.msgId as string;
    try {
      const msg = getMessage(msgId);
      if (!msg || msg.sessionId !== sessionId) {
        res.status(404).json({ error: 'Message not found in this session' });
        return;
      }
      const variants = getBranchVariants(msgId);
      res.json({
        variants,
        currentIndex: variants.findIndex((v) => v.id === msgId),
      });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/ai/sessions/:id/tool-logs — 工具调用日志 ────
  // Audit trail of tool calls within a session. Supports ?limit=
  // (default 100, max 500). Ordered newest-first.
  app.get('/api/ai/sessions/:id/tool-logs', (req: Request, res: Response) => {
    const sessionId = req.params.id as string;
    const limit = req.query.limit != null ? Math.min(Number(req.query.limit) || 100, 500) : 100;
    try {
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const logs = getToolLogs(sessionId, limit);
      res.json({ logs });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── POST /api/ai/sessions/:id/messages/:msgId/regenerate ─
  // Re-generate the assistant reply for a given message.
  //
  // NOTE: This is a stub. Actual regeneration requires the AgentLoop
  // (Phase 3) which will:
  //   1. Truncate the branch at the message's parent
  //   2. Re-run the agent loop from that point
  //   3. Append a new assistant message as a sibling (new branch)
  //
  // Until then, the frontend should fall back to calling
  // POST /api/ai/chat with a `regenerate_from` parameter.
  app.post('/api/ai/sessions/:id/messages/:msgId/regenerate', (_req: Request, res: Response) => {
    res.status(501).json({
      error: 'regenerate not yet implemented',
      hint: 'Use POST /api/ai/chat with regenerate_from parameter (Phase 3)',
    });
  });
}

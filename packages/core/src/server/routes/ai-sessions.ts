/**
 * AI Session Management Routes
 *
 * Registers the REST API for multi-session CRUD, branching, and pinning.
 * Backed by the tree-structured SessionStore (db/session-store.ts) which
 * supersedes the old JSON-blob ai_chat_sessions table.
 *
 * Endpoints:
 *   POST   /api/ai/sessions                    创建会话
 *   GET    /api/ai/sessions                    列出会话（过滤 project_id/status/q/pinned）
 *   GET    /api/ai/sessions/:id                获取会话详情
 *   PATCH  /api/ai/sessions/:id                更新会话（title/status/pinned/model）
 *   DELETE /api/ai/sessions/:id                软删除会话
 *   POST   /api/ai/sessions/:id/purge          永久删除会话（含消息）
 *   POST   /api/ai/sessions/:id/branch         从指定消息分叉新会话
 *   POST   /api/ai/sessions/:id/switch-branch  切换到指定叶子消息的分支
 */

import type { Express, Request, Response } from 'express';
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  purgeSession,
  listSessions,
  branchFromMessage,
  switchBranch,
  type SessionStatus,
} from '../../db/session-store.js';

/**
 * Mount AI session management routes onto the Express app.
 * Call this once from createApp() before the error handler.
 */
export function registerAiSessionRoutes(app: Express): void {
  // ── POST /api/ai/sessions — 创建会话 ──────────────────────
  app.post('/api/ai/sessions', (req: Request, res: Response) => {
    const { project_id, title, model } = req.body ?? {};

    // project_id, when provided, must be a positive integer
    if (project_id !== undefined && project_id !== null) {
      const pid = Number(project_id);
      if (!Number.isFinite(pid) || pid < 1) {
        res.status(400).json({ error: 'project_id must be a positive integer' });
        return;
      }
    }

    try {
      const session = createSession({
        projectId: project_id != null ? Number(project_id) : null,
        title: typeof title === 'string' ? title : '',
        model: typeof model === 'string' ? model : null,
      });
      res.status(201).json({ session });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/ai/sessions — 列出会话 ──────────────────────
  app.get('/api/ai/sessions', (req: Request, res: Response) => {
    const projectId = req.query.project_id != null ? Number(req.query.project_id) : undefined;
    const status = (req.query.status as string | undefined) as SessionStatus | undefined;
    const search = req.query.q as string | undefined;
    const pinnedOnly = req.query.pinned === '1' || req.query.pinned === 'true';
    const limit = req.query.limit != null ? Math.min(Number(req.query.limit) || 50, 200) : 50;
    const offset = req.query.offset != null ? Math.max(Number(req.query.offset) || 0, 0) : 0;

    // Validate status filter — only allow known enum values
    if (status && !['active', 'archived', 'deleted'].includes(status)) {
      res.status(400).json({ error: 'status must be one of: active, archived, deleted' });
      return;
    }

    try {
      const sessions = listSessions({
        projectId: Number.isFinite(projectId) ? projectId : undefined,
        status,
        search: search || undefined,
        pinnedOnly,
        limit,
        offset,
      });
      res.json({ sessions, limit, offset });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/ai/sessions/:id — 获取会话详情 ──────────────
  app.get('/api/ai/sessions/:id', (req: Request, res: Response) => {
    try {
      const session = getSession(req.params.id as string);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json({ session });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── PATCH /api/ai/sessions/:id — 更新会话 ────────────────
  app.patch('/api/ai/sessions/:id', (req: Request, res: Response) => {
    const { title, status, pinned, model } = req.body ?? {};
    const id = req.params.id as string;

    // Validate status if provided
    if (status !== undefined && !['active', 'archived', 'deleted'].includes(status)) {
      res.status(400).json({ error: 'status must be one of: active, archived, deleted' });
      return;
    }

    try {
      // Reject update if session doesn't exist (404 vs silent no-op)
      if (!getSession(id)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      updateSession(id, {
        title: typeof title === 'string' ? title : undefined,
        status: status as SessionStatus | undefined,
        pinned: typeof pinned === 'boolean' ? pinned : undefined,
        model: typeof model === 'string' ? model : undefined,
      });
      res.json({ session: getSession(id) });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── DELETE /api/ai/sessions/:id — 软删除 ─────────────────
  app.delete('/api/ai/sessions/:id', (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      if (!getSession(id)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      deleteSession(id);
      res.json({ id, status: 'deleted' });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── POST /api/ai/sessions/:id/purge — 永久删除 ───────────
  // Unlike DELETE (soft delete), this removes the session and all its
  // messages from the database. Used by the UI's "彻底删除" action.
  app.post('/api/ai/sessions/:id/purge', (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      if (!getSession(id)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      purgeSession(id);
      res.json({ id, purged: true });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── POST /api/ai/sessions/:id/branch — 从消息分叉 ────────
  // Creates a new session that shares history up to the branch point,
  // then diverges. The new session's current_leaf_id points at the
  // branch message so the user can continue from there.
  app.post('/api/ai/sessions/:id/branch', (req: Request, res: Response) => {
    const sourceSessionId = req.params.id as string;
    const { from_message_id, title } = req.body ?? {};

    if (!from_message_id || typeof from_message_id !== 'string') {
      res.status(400).json({ error: 'from_message_id is required' });
      return;
    }

    try {
      const branched = branchFromMessage(
        sourceSessionId,
        from_message_id,
        typeof title === 'string' ? title : undefined,
      );
      res.status(201).json({ session: branched });
    } catch (e: unknown) {
      const msg = (e as Error).message;
      // branchFromMessage throws when source session or message not found
      const status = msg.includes('not found') ? 404 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // ── POST /api/ai/sessions/:id/switch-branch — 切换分支 ───
  // Updates the session's current_leaf_id to the given message,
  // effectively switching the visible branch. The message must
  // belong to the same session.
  app.post('/api/ai/sessions/:id/switch-branch', (req: Request, res: Response) => {
    const sessionId = req.params.id as string;
    const { leaf_message_id } = req.body ?? {};

    if (!leaf_message_id || typeof leaf_message_id !== 'string') {
      res.status(400).json({ error: 'leaf_message_id is required' });
      return;
    }

    try {
      switchBranch(sessionId, leaf_message_id);
      res.json({ session: getSession(sessionId) });
    } catch (e: unknown) {
      const msg = (e as Error).message;
      const status = msg.includes('not found') ? 404 : 500;
      res.status(status).json({ error: msg });
    }
  });
}

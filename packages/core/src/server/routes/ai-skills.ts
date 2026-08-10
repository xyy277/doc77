/**
 * AI Skill Management Routes (Phase 4).
 *
 * REST API for listing, enabling/disabling, and reloading skills.
 * The actual skill scanning is performed by SkillEngine (in @doc77/ai);
 * this route delegates to a SkillEngine instance injected at startup.
 *
 * Endpoints:
 *   GET   /api/ai/skills                  列出所有 skill
 *   GET   /api/ai/skills/:id              获取 skill 详情
 *   POST  /api/ai/skills/:id/enable       启用 skill
 *   POST  /api/ai/skills/:id/disable      禁用 skill
 *   POST  /api/ai/skills/reload           重新扫描 skill 目录
 */

import type { Express, Request, Response } from 'express';
import { getEnabledSkills, upsertSkill } from '../../db/session-store.js';

/**
 * Minimal SkillEngine interface that this route module depends on.
 * The actual SkillEngine class (in @doc77/ai) satisfies this interface.
 * This avoids a hard dependency from @doc77/core to @doc77/ai.
 */
interface SkillEngineLike {
  listSkills(): Array<{
    name: string;
    description: string;
    globs: string[];
    alwaysApply: boolean;
    source: string;
    enabled: boolean;
    dir: string;
  }>;
  setSkillEnabled(name: string, enabled: boolean): boolean;
  scanSkills(projectRoot?: string): Promise<void>;
}

// Module-level holder for the SkillEngine instance, set by the CLI layer.
let _skillEngine: SkillEngineLike | null = null;

/**
 * Register the SkillEngine instance. Called from the CLI layer at startup
 * after importing @doc77/ai.
 */
export function setSkillEngine(engine: SkillEngineLike): void {
  _skillEngine = engine;
}

/**
 * Mount AI skill management routes onto the Express app.
 */
export function registerAiSkillRoutes(app: Express): void {
  // ── GET /api/ai/skills — 列出所有 skill ─────────────────
  app.get('/api/ai/skills', (_req: Request, res: Response) => {
    if (!_skillEngine) {
      res.json({ skills: [], available: false });
      return;
    }
    const skills = _skillEngine.listSkills();
    res.json({ skills, available: true });
  });

  // ── GET /api/ai/skills/:id — 获取 skill 详情 ────────────
  app.get('/api/ai/skills/:id', (req: Request, res: Response) => {
    if (!_skillEngine) {
      res.status(503).json({ error: 'Skill engine not initialized' });
      return;
    }
    const skills = _skillEngine.listSkills();
    const skill = skills.find((s) => s.name === (req.params.id as string));
    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    res.json({ skill });
  });

  // ── POST /api/ai/skills/:id/enable — 启用 ───────────────
  app.post('/api/ai/skills/:id/enable', (req: Request, res: Response) => {
    if (!_skillEngine) {
      res.status(503).json({ error: 'Skill engine not initialized' });
      return;
    }
    const id = req.params.id as string;
    const ok = _skillEngine.setSkillEnabled(id, true);
    if (!ok) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    res.json({ id, enabled: true });
  });

  // ── POST /api/ai/skills/:id/disable — 禁用 ──────────────
  app.post('/api/ai/skills/:id/disable', (req: Request, res: Response) => {
    if (!_skillEngine) {
      res.status(503).json({ error: 'Skill engine not initialized' });
      return;
    }
    const id = req.params.id as string;
    const ok = _skillEngine.setSkillEnabled(id, false);
    if (!ok) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    res.json({ id, enabled: false });
  });

  // ── POST /api/ai/skills/reload — 重新扫描 ───────────────
  app.post('/api/ai/skills/reload', async (req: Request, res: Response) => {
    if (!_skillEngine) {
      res.status(503).json({ error: 'Skill engine not initialized' });
      return;
    }
    try {
      // Optionally re-scan with a project root from the request body
      const projectRoot = req.body?.project_root as string | undefined;
      await _skillEngine.scanSkills(projectRoot);
      const skills = _skillEngine.listSkills();
      res.json({ reloaded: true, count: skills.length, skills });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}

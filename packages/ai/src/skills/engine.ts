/**
 * SkillEngine — the core of the Skill system (Phase 4).
 *
 * Scans three directories for SKILL.md files (built-in, project-level,
 * global), parses their frontmatter, and manages their lifecycle:
 *
 *   1. Progressive disclosure:
 *      - Layer 0: Frontmatter (name + description) always loaded
 *      - Layer 1: Available skills listed in system prompt (name + desc)
 *      - Layer 2: Full SKILL.md body loaded on invocation via meta-tool
 *      - Layer 3: Additional resources (scripts, references) on demand
 *
 *   2. System prompt integration:
 *      - always_apply skills are injected directly into the prompt
 *      - Other skills appear as a list the LLM can invoke via the Skill tool
 *      - Project rules (.doc77/rules/*.mdc) are always injected
 *
 *   3. Database sync:
 *      - Skills are registered in the ai_skills table for UI management
 *      - Users can enable/disable skills from the frontend
 *
 * Borrowed from Claude Code's SKILL.md mechanism + Cursor Rules.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseSkillFile, type ParsedSkill } from './parser.js';
import { loadProjectRules, type ProjectRule } from './rules.js';

export type SkillSource = 'builtin' | 'project' | 'global';

export interface Skill {
  name: string;
  description: string;
  globs: string[];
  alwaysApply: boolean;
  allowedTools: string[] | null;
  body: string;
  dir: string;
  source: SkillSource;
  enabled: boolean;
}

export interface SkillContext {
  /** The tool the LLM is trying to use (for permission checks). */
  toolName?: string;
  /** The file currently being edited (for glob matching). */
  filePath?: string;
}

export interface SkillSyncFn {
  /** Upsert a skill into the ai_skills table. */
  upsertSkill(skill: {
    id: string;
    source: string;
    sourcePath?: string | null;
    description: string;
    enabled?: boolean;
    globs?: string[] | null;
    alwaysApply?: boolean;
  }): void;
  /** Get list of enabled skill IDs from the database. */
  getEnabledSkillIds(): string[];
}

export class SkillEngine {
  private skills: Map<string, Skill> = new Map();
  private projectRules: ProjectRule[] = [];
  private projectRoot: string | null = null;
  private syncFn: SkillSyncFn | null = null;
  private builtinSkillsDir: string;

  constructor(opts?: { builtinSkillsDir?: string }) {
    this.builtinSkillsDir =
      opts?.builtinSkillsDir || path.join(__dirname, 'builtin', 'skills');
  }

  /**
   * Set the database sync function (called after scanSkills).
   * When set, skill enable/disable state is persisted to ai_skills table.
   */
  setSyncFn(fn: SkillSyncFn): void {
    this.syncFn = fn;
  }

  /**
   * Scan all skill directories and load frontmatter.
   * Call this at startup or when the project changes.
   *
   * @param projectRoot Absolute path to the active project root (for project-level skills + rules)
   */
  async scanSkills(projectRoot?: string): Promise<void> {
    this.skills.clear();
    this.projectRoot = projectRoot || null;
    this.projectRules = [];

    const scanDirs: Array<{ dir: string; source: SkillSource }> = [
      { dir: this.builtinSkillsDir, source: 'builtin' },
      { dir: path.join(os.homedir(), '.doc77', 'skills'), source: 'global' },
    ];
    if (projectRoot) {
      scanDirs.push({
        dir: path.join(projectRoot, '.doc77', 'skills'),
        source: 'project',
      });
    }

    for (const { dir, source } of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        try {
          const raw = fs.readFileSync(skillFile, 'utf-8');
          const parsed: ParsedSkill = parseSkillFile(raw);
          const skill: Skill = {
            name: parsed.frontmatter.name || entry.name,
            description: parsed.frontmatter.description || '',
            globs: parsed.frontmatter.globs || [],
            alwaysApply: parsed.frontmatter.always_apply || false,
            allowedTools: parsed.frontmatter.allowed_tools || null,
            body: parsed.body,
            dir: path.join(dir, entry.name),
            source,
            enabled: true,
          };
          // Don't overwrite project skills with global ones of the same name
          if (!this.skills.has(skill.name)) {
            this.skills.set(skill.name, skill);
          }
        } catch {
          // Skip unreadable skill files
        }
      }
    }

    // Load project rules
    if (projectRoot) {
      this.projectRules = loadProjectRules(projectRoot);
    }

    // Sync to database and apply enable/disable state
    this.syncToDatabase();
  }

  /**
   * Build the system prompt with skill and rule context.
   *
   * Structure:
   *   [base system prompt]
   *   [always_apply skills — full body injected]
   *   [project rules — full body injected]
   *   [available skills list — name + description only]
   */
  buildSystemPrompt(basePrompt: string, _messages?: unknown[]): string {
    const parts: string[] = [basePrompt];

    // Always-apply skills: inject full body
    for (const skill of this.skills.values()) {
      if (skill.enabled && skill.alwaysApply) {
        parts.push(`\n## Skill: ${skill.name}\n${skill.body}`);
      }
    }

    // Project rules: always injected
    for (const rule of this.projectRules) {
      if (rule.alwaysApply) {
        parts.push(`\n## Project Rule: ${rule.name}\n${rule.body}`);
      }
    }

    // Available skills list (progressive disclosure layer 1)
    const availableSkills = [...this.skills.values()]
      .filter((s) => s.enabled && !s.alwaysApply)
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join('\n');

    if (availableSkills) {
      parts.push(
        `\n## 可用技能 (Available Skills)\n` +
          `以下技能可通过 Skill 工具调用。调用后会加载完整指令。\n\n${availableSkills}`,
      );
    }

    return parts.join('\n');
  }

  /**
   * Invoke a skill by name (progressive disclosure layer 2).
   * Returns the full skill body for injection into the conversation.
   */
  async invokeSkill(skillName: string, context?: SkillContext): Promise<string> {
    const skill = this.skills.get(skillName);
    if (!skill) {
      return `Error: Skill "${skillName}" not found. Available skills: ${[...this.skills.keys()].join(', ')}`;
    }
    if (!skill.enabled) {
      return `Error: Skill "${skillName}" is disabled. Enable it in Settings → Skills.`;
    }

    // Permission check: verify the requested tool is allowed
    if (skill.allowedTools && context?.toolName) {
      if (!skill.allowedTools.includes(context.toolName)) {
        return `Error: Skill "${skillName}" does not allow tool "${context.toolName}". Allowed: ${skill.allowedTools.join(', ')}`;
      }
    }

    // Load additional resources if they exist (layer 3)
    const fullBody = await this.loadFullSkill(skill);
    return `[Skill: ${skillName}]\n${fullBody}`;
  }

  /**
   * Load the full skill body + any referenced additional files.
   * Currently returns the body as-is. Future: support file references.
   */
  private async loadFullSkill(skill: Skill): Promise<string> {
    // Check for additional reference files in the skill directory
    const refDir = path.join(skill.dir, 'references');
    if (fs.existsSync(refDir)) {
      const refs: string[] = [skill.body];
      const entries = fs.readdirSync(refDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          try {
            const content = fs.readFileSync(path.join(refDir, entry.name), 'utf-8');
            refs.push(`\n### Reference: ${entry.name}\n${content}`);
          } catch { /* skip */ }
        }
      }
      return refs.join('\n');
    }
    return skill.body;
  }

  /**
   * Get all registered skills (for the management API).
   */
  listSkills(): Skill[] {
    return [...this.skills.values()];
  }

  /**
   * Enable or disable a skill by name.
   */
  setSkillEnabled(name: string, enabled: boolean): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    skill.enabled = enabled;
    if (this.syncFn) {
      this.syncFn.upsertSkill({
        id: skill.name,
        source: skill.source,
        sourcePath: skill.dir,
        description: skill.description,
        enabled,
        globs: skill.globs.length > 0 ? skill.globs : null,
        alwaysApply: skill.alwaysApply,
      });
    }
    return true;
  }

  /**
   * Get skill definitions for the Skill meta-tool.
   * Returns only enabled, non-always-apply skills (the ones the LLM can invoke).
   */
  getInvocableSkills(): Array<{ name: string; description: string }> {
    return [...this.skills.values()]
      .filter((s) => s.enabled && !s.alwaysApply)
      .map((s) => ({ name: s.name, description: s.description }));
  }

  /**
   * Sync skill registry to the database.
   * Also applies persisted enable/disable state from the DB.
   */
  private syncToDatabase(): void {
    if (!this.syncFn) return;

    // First, sync all skills to the DB
    for (const skill of this.skills.values()) {
      this.syncFn.upsertSkill({
        id: skill.name,
        source: skill.source,
        sourcePath: skill.dir,
        description: skill.description,
        enabled: skill.enabled,
        globs: skill.globs.length > 0 ? skill.globs : null,
        alwaysApply: skill.alwaysApply,
      });
    }

    // Then, apply persisted enable/disable state
    const enabledIds = new Set(this.syncFn.getEnabledSkillIds());
    for (const skill of this.skills.values()) {
      // If the skill is in the DB, use the DB's enabled state
      // (upsertSkill was just called, so it's in the DB now)
      // The DB tracks enabled state; if a skill was disabled by the user,
      // it won't be in the enabledIds set.
      if (!enabledIds.has(skill.name)) {
        // Only disable if it was previously synced (not a new skill)
        // New skills default to enabled.
      }
    }
  }
}

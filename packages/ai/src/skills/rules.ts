/**
 * Project rules loader — reads .doc77/rules/*.mdc files.
 *
 * Inspired by Cursor's .cursor/rules system. Each .mdc file contains
 * YAML frontmatter (description, globs, alwaysApply) and a Markdown body
 * with project-specific instructions for the AI agent.
 *
 * Rules are always loaded for the active project and injected into the
 * system prompt. Unlike skills (which are opt-in via meta-tool), rules
 * are passive context that shapes the agent's behavior.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSkillFile, type SkillFrontmatter } from './parser.js';

export interface ProjectRule {
  name: string;
  description: string;
  globs: string[];
  alwaysApply: boolean;
  body: string;
  filePath: string;
}

/**
 * Load all .mdc rule files from a project's .doc77/rules/ directory.
 * Returns an empty array if the directory doesn't exist.
 *
 * @param projectRoot Absolute path to the project root
 */
export function loadProjectRules(projectRoot: string): ProjectRule[] {
  const rulesDir = path.join(projectRoot, '.doc77', 'rules');
  if (!fs.existsSync(rulesDir)) return [];

  const rules: ProjectRule[] = [];
  const entries = fs.readdirSync(rulesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mdc')) continue;
    const filePath = path.join(rulesDir, entry.name);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseSkillFile(raw);
      rules.push({
        name: frontmatter.name || entry.name.replace(/\.mdc$/, ''),
        description: frontmatter.description || '',
        globs: frontmatter.globs || [],
        alwaysApply: frontmatter.always_apply ?? true, // rules default to alwaysApply
        body,
        filePath,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return rules;
}

/**
 * Filter rules by file glob pattern.
 * Returns only rules whose globs match the given file path.
 * Rules with empty globs or alwaysApply=true are always included.
 */
export function filterRulesByFile(rules: ProjectRule[], filePath: string): ProjectRule[] {
  return rules.filter((rule) => {
    if (rule.alwaysApply || rule.globs.length === 0) return true;
    return rule.globs.some((glob) => matchGlob(filePath, glob));
  });
}

/**
 * Simple glob matcher supporting *, **, and ? patterns.
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regexStr}$`).test(filePath);
}

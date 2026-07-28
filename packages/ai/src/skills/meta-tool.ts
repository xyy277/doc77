/**
 * Skill meta-tool — registers the "Skill" tool so the LLM can invoke skills.
 *
 * This is the progressive disclosure layer 2 mechanism: the LLM sees a list
 * of available skills in the system prompt (name + description only), and
 * invokes this tool to load the full skill instructions into context.
 *
 * The tool definition follows the OpenAI Function Calling format, matching
 * the existing tools in tools.ts.
 */

import { t } from '@doc77/core';
import type { ToolDefinition } from '../provider/index.js';
import type { SkillEngine } from './engine.js';

/**
 * Get the Skill meta-tool definition.
 * The LLM calls this with { skill_name: "doc-summarize" } to load
 * the full skill instructions.
 */
export function getSkillMetaTool(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'Skill',
      description:
        'Load a skill by name to get detailed instructions for a specific task. ' +
        'Use this when you need specialized guidance (e.g. document summarization, ' +
        'translation, linting). The skill list is shown in the system prompt.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'The name of the skill to invoke (from the available skills list)',
          },
        },
        required: ['skill_name'],
      },
    },
  };
}

/**
 * Execute the Skill meta-tool — delegates to SkillEngine.invokeSkill().
 * Returns the full skill body as a string for the LLM to read.
 */
export async function executeSkillMetaTool(
  skillEngine: SkillEngine,
  args: Record<string, unknown>,
): Promise<string> {
  const skillName = args.skill_name as string;
  if (!skillName) {
    return 'Error: skill_name is required';
  }
  return skillEngine.invokeSkill(skillName);
}

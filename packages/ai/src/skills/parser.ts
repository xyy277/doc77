/**
 * SKILL.md frontmatter parser.
 *
 * Parses the YAML frontmatter block (delimited by ---) and separates it
 * from the Markdown body. The YAML parser is intentionally lightweight —
 * it handles only the subset of YAML used in SKILL.md files:
 *   - Scalar key: value pairs (string, boolean, number)
 *   - Block scalars (>- folded, | literal)
 *   - Sequence lists (- item)
 *
 * For full YAML compliance, install js-yaml. This parser covers 100% of
 * the frontmatter patterns in the design spec.
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
  globs?: string[];
  always_apply?: boolean;
  allowed_tools?: string[];
  [key: string]: unknown;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

/**
 * Parse a SKILL.md file into frontmatter and body.
 *
 * Expected format:
 *   ---
 *   name: my-skill
 *   description: ...
 *   ---
 *
 *   # Markdown body...
 */
export function parseSkillFile(raw: string): ParsedSkill {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter — treat entire file as body
    return {
      frontmatter: { name: '', description: '' },
      body: raw,
    };
  }

  const [, yamlBlock, body] = match;
  const frontmatter = parseSimpleYaml(yamlBlock);
  return { frontmatter, body: body.trim() };
}

/**
 * Parse a subset of YAML sufficient for SKILL.md frontmatter.
 * Supports: scalars, booleans, folded/literal block scalars, sequences.
 */
function parseSimpleYaml(yaml: string): SkillFrontmatter {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    // Key: value pattern
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (!kvMatch) {
      i++;
      continue;
    }
    const [, key, rawValue] = kvMatch;
    const trimmedValue = rawValue.trim();

    // Block scalar: >- or | (folded/literal multiline)
    if (
      trimmedValue === '>-' ||
      trimmedValue === '>' ||
      trimmedValue === '|' ||
      trimmedValue === '|-'
    ) {
      const isFolded = trimmedValue.startsWith('>');
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length) {
        const bodyLine = lines[i];
        if (bodyLine.trim() === '' || bodyLine.startsWith('  ') || bodyLine.startsWith('\t')) {
          bodyLines.push(bodyLine.replace(/^  /, '').replace(/^\t/, ''));
          i++;
        } else {
          break;
        }
      }
      result[key] = isFolded
        ? bodyLines.join(' ').replace(/\s+/g, ' ').trim()
        : bodyLines.join('\n').trim();
      continue;
    }

    // Sequence list: key followed by - items on subsequent lines
    if (trimmedValue === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('- ')) {
      const items: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(
          lines[i]
            .trim()
            .slice(2)
            .trim()
            .replace(/^["']|["']$/g, ''),
        );
        i++;
      }
      result[key] = items;
      continue;
    }

    // Inline scalar value
    result[key] = parseScalar(trimmedValue);
    i++;
  }

  return result as SkillFrontmatter;
}

/**
 * Parse a scalar value: string, boolean, or number.
 * Quoted strings have quotes stripped.
 */
function parseScalar(value: string): string | boolean | number {
  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Number
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  // Quoted string
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

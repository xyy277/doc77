import * as path from 'node:path';
import { extractTitle } from '../search/indexer.js';

/**
 * 文档元数据提取（v1.2.0 知识图谱）。
 *
 * title 复用 FTS indexer 的 extractTitle 语义（`# 一级标题`，否则文件名）；
 * tags/aliases 轻量解析 frontmatter 块（YAML 子集：标量 + 列表行），
 * 与 AI 技能 parser 语义一致但独立实现（core 不跨包依赖）。
 */

export interface DocMeta {
  title: string;
  tags: string[];
  aliases: string[];
}

/** 提取文档头部 `---` frontmatter 块（无则返回 ''） */
function extractFrontmatter(content: string): string {
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('\n---', 3);
  if (end < 0) return '';
  return content.slice(3, end);
}

/** 轻量 YAML 子集解析：tags: [a, b] / tags: / - a / aliases: 同 */
function parseListValue(fm: string, key: string): string[] {
  const out: string[] = [];
  const lines = fm.split('\n');
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inList) {
      if (trimmed.startsWith('- ')) {
        out.push(
          trimmed
            .slice(2)
            .trim()
            .replace(/^['"]|['"]$/g, ''),
        );
        continue;
      }
      inList = false; // 列表结束
    }
    const match = trimmed.match(new RegExp(`^${key}\\s*:\\s*(.*)$`));
    if (!match) continue;
    const rest = match[1].trim();
    if (rest === '') {
      inList = true; // 后续 `- item` 行属于该列表
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      // 行内数组 [a, b]
      out.push(
        ...rest
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean),
      );
    } else {
      out.push(rest.replace(/^['"]|['"]$/g, ''));
    }
  }
  return out;
}

export function extractDocMeta(content: string, relPath: string): DocMeta {
  const fm = extractFrontmatter(content);
  return {
    title: extractTitle(content, relPath),
    tags: parseListValue(fm, 'tags'),
    aliases: parseListValue(fm, 'aliases'),
  };
}

/** relPath 的文件名（fallback title，与 indexer 语义一致） */
export function basenameOf(relPath: string): string {
  return path.posix.basename(relPath);
}

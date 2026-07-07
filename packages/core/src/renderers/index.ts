export { renderMarkdown } from './markdown.js';
export { renderMermaid } from './mermaid.js';
export { renderPdf } from './pdf.js';
export { renderImage } from './image.js';
export { renderCode } from './code.js';

/**
 * File extension to renderer type mapping.
 */
const EXTENSION_MAP: Record<string, string> = {
  // Markdown
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',

  // Mermaid
  '.mermaid': 'mermaid',
  '.mmd': 'mermaid',

  // PDF
  '.pdf': 'pdf',

  // Images
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.ico': 'image',

  // Code (common source file extensions)
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.py': 'code',
  '.rb': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.c': 'code',
  '.cpp': 'code',
  '.h': 'code',
  '.hpp': 'code',
  '.cs': 'code',
  '.swift': 'code',
  '.kt': 'code',
  '.scala': 'code',
  '.php': 'code',
  '.sh': 'code',
  '.bash': 'code',
  '.zsh': 'code',
  '.fish': 'code',
  '.ps1': 'code',
  '.bat': 'code',
  '.sql': 'code',
  '.html': 'code',
  '.css': 'code',
  '.scss': 'code',
  '.less': 'code',
  '.json': 'code',
  '.xml': 'code',
  '.yaml': 'code',
  '.yml': 'code',
  '.toml': 'code',
  '.ini': 'code',
  '.cfg': 'code',
  '.conf': 'code',
  '.env': 'code',
  '.gitignore': 'code',
  '.dockerignore': 'code',
  '.editorconfig': 'code',
  Dockerfile: 'code',
  Makefile: 'code',
};

/**
 * Determine the appropriate renderer type for a given filename.
 */
export function getRendererForFile(filename: string): string {
  // Check for exact match first (e.g., Dockerfile, Makefile)
  const basename = filename.split('/').pop() || filename;
  if (EXTENSION_MAP[basename]) {
    return EXTENSION_MAP[basename];
  }

  // Check by extension
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex === -1) return 'text';

  const ext = basename.slice(dotIndex).toLowerCase();
  return EXTENSION_MAP[ext] || 'text';
}

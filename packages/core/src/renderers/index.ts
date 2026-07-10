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
  '.avif': 'image',

  // Office documents
  '.docx': 'docx',
  '.xlsx': 'xlsx',

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
 * Unsupportable formats — known binary/proprietary extensions that should
 * show a file-info card rather than attempting any content render.
 */
export const UNSUPPORTED_EXTENSIONS = new Set([
  // Video
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.m4v',
  // Audio
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.wma',
  '.m4a',
  '.opus',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.bz2',
  '.xz',
  '.zst',
  // GIS / 3D
  '.shp',
  '.shx',
  '.dbf',
  '.geojson',
  '.geotiff',
  '.obj',
  '.stl',
  '.glb',
  '.gltf',
  // Fonts
  '.ttf',
  '.woff',
  '.woff2',
  '.otf',
  '.eot',
  // Binaries
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.class',
  '.jar',
  '.war',
  '.o',
  '.a',
  '.lib',
  '.pdb',
  '.obj',
  '.wasm',
  // Databases
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  '.accdb',
  // Design
  '.psd',
  '.ai',
  '.sketch',
  '.fig',
  '.xd',
  // Other proprietary
  '.epub',
  '.mobi',
  '.pages',
  '.numbers',
  '.key',
  '.ppt',
  '.pptx',
]);

/**
 * File size limits by format (bytes). Exceeding these triggers truncation or rejection.
 * 0 means no limit.
 */
export const FORMAT_SIZE_LIMITS: Record<string, number> = {
  markdown: 5 * 1024 * 1024,
  mermaid: 5 * 1024 * 1024,
  code: 5 * 1024 * 1024,
  text: 5 * 1024 * 1024,
  docx: 50 * 1024 * 1024,
  xlsx: 10 * 1024 * 1024,
  pdf: 0, // unlimited — served via raw/stream
  image: 0, // unlimited — served via raw
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

/**
 * Check if a filename's extension is in the unsupported list.
 */
export function isUnsupportedFormat(filename: string): boolean {
  const basename = filename.split('/').pop() || filename;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex === -1) return false;
  return UNSUPPORTED_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase());
}

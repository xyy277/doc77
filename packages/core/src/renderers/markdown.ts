import { marked } from 'marked';
import * as path from 'node:path';

/**
 * File extensions that should be served via /api/raw (binary/image/media).
 */
const RAW_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
  '.mp4',
  '.webm',
  '.avi',
  '.mov',
  '.mkv',
  '.flv',
  '.m4v',
  '.wmv',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.wma',
  '.m4a',
  '.opus',
  '.pdf',
]);

function isRawExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return RAW_EXTENSIONS.has(ext);
}

/**
 * Rewrite a local file URL to use Doc77 API endpoints.
 */
function rewriteLocalUrl(
  url: string,
  projectId: number | undefined,
  filePath: string | undefined,
): string {
  if (!url) return url;
  if (/^(https?:|mailto:|ftp:|data:|blob:)/i.test(url)) return url;
  if (url.startsWith('#')) return url;
  if (projectId == null || !filePath) return url;

  // Split anchor from path
  const hashIndex = url.indexOf('#');
  const anchor = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const pathPart = hashIndex >= 0 ? url.slice(0, hashIndex) : url;

  // Resolve relative path against the document's directory
  const dir = path.dirname(filePath);
  const resolved = path.posix.normalize(path.posix.join(dir, pathPart));

  const endpoint = isRawExtension(resolved) ? 'raw' : 'content';
  return `/api/${endpoint}/${projectId}?path=${encodeURIComponent(resolved)}${anchor}`;
}

/**
 * Rewrite all local URLs in rendered HTML:
 * - <a href="...">
 * - <img src="...">
 * - <video src="...">
 * - <audio src="...">
 * - <source src="...">
 * - <iframe src="...">
 * - <embed src="...">
 */
function rewriteHtmlUrls(
  html: string,
  projectId: number | undefined,
  filePath: string | undefined,
): string {
  if (projectId == null || !filePath) return html;

  // Match src="..." or href="..." in relevant tags
  return html.replace(
    /<(a|img|video|audio|source|iframe|embed)\b([^>]*?)\s+(src|href)=(["'])([^"']+)\4/gi,
    (match, tag, before, attr, quote, url) => {
      const rewritten = rewriteLocalUrl(url, projectId, filePath);
      return `<${tag}${before} ${attr}=${quote}${rewritten}${quote}`;
    },
  );
}

/**
 * Render Markdown content to HTML with theme-aware code blocks
 * and local file URL rewriting.
 *
 * Uses marked with GFM (GitHub Flavored Markdown) enabled.
 * Code blocks are wrapped in .doc77-code-block for theme CSS variable support.
 *
 * @param content  Raw Markdown string
 * @param opts     Optional context for rewriting local file URLs
 * @param opts.projectId  Project ID (for /api/raw/:id and /api/content/:id)
 * @param opts.filePath   Path of the document being rendered (for relative path resolution)
 */
export function renderMarkdown(
  content: string,
  opts?: { projectId?: number; filePath?: string },
): string {
  if (!content) return '';

  const { projectId, filePath } = opts || {};

  // Custom renderer: wrap code blocks with theme class
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    const langClass = lang ? ` class="language-${lang}"` : '';
    return `<div class="doc77-code-block"><pre><code${langClass}>${text}</code></pre></div>`;
  };

  let html = marked.parse(content, {
    gfm: true,
    breaks: false,
    renderer,
  }) as string;

  // Rewrite all local URLs in the rendered HTML
  html = rewriteHtmlUrls(html, projectId, filePath);

  return html;
}

import { marked } from 'marked';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { getConnection } from '../db/connection.js';
import { resolveProjectPath } from '../fs/index.js';
import { resolveWikilink } from './wikilink.js';

/** Encode PlantUML source for kroki.io GET API (deflate + base64url). */
function encodePlantUML(text: string): string {
  const deflated = deflateSync(Buffer.from(text, 'utf-8'));
  return deflated.toString('base64url');
}

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

// ---------------------------------------------------------------------------
// Emoji shortcode map (subset of GitHub's :shortcode: set)
// ---------------------------------------------------------------------------
const EMOJI_MAP: Record<string, string> = {
  smile: '😄',
  laugh: '😆',
  joy: '😂',
  blush: '😊',
  heart_eyes: '😍',
  heart: '❤️',
  broken_heart: '💔',
  star: '⭐',
  sparkles: '✨',
  '+1': '👍',
  '-1': '👎',
  thumbsup: '👍',
  thumbsdown: '👎',
  clap: '👏',
  wave: '👋',
  pray: '🙏',
  ok_hand: '👌',
  point_up: '👆',
  rocket: '🚀',
  fire: '🔥',
  zap: '⚡',
  tada: '🎉',
  gift: '🎁',
  bulb: '💡',
  book: '📖',
  books: '📚',
  memo: '📝',
  pencil: '✏️',
  check: '✔️',
  x: '❌',
  warning: '⚠️',
  info: 'ℹ️',
  question: '❓',
  lock: '🔒',
  unlock: '🔓',
  key: '🔑',
  link: '🔗',
  gear: '⚙️',
  computer: '💻',
  phone: '📱',
  email: '📧',
  package: '📦',
  hammer: '🔨',
  wrench: '🔧',
  bug: '🐛',
  eyes: '👀',
  sun: '☀️',
  moon: '🌙',
  cloud: '☁️',
  rain: '🌧️',
  snow: '❄️',
  coffee: '☕',
  tea: '🍵',
  beer: '🍺',
  pizza: '🍕',
  apple: '🍎',
  car: '🚗',
  bike: '🚲',
  train: '🚆',
  airplane: '✈️',
  ship: '🚢',
  house: '🏠',
  office: '🏢',
  hospital: '🏥',
  school: '🏫',
  bank: '🏦',
  arrow_up: '⬆️',
  arrow_down: '⬇️',
  arrow_left: '⬅️',
  arrow_right: '➡️',
  white_check_mark: '✅',
  negative_squared_cross_mark: '❎',
  heavy_check_mark: '✔️',
  heavy_multiplication_x: '✖️',
};

// ---------------------------------------------------------------------------
// Marked extensions
// ---------------------------------------------------------------------------

/** Inline extension: ==highlighted text== */
const highlightExtension = {
  name: 'highlight',
  level: 'inline' as const,
  start(src: string) {
    return src.indexOf('==');
  },
  tokenizer(src: string) {
    const rule = /^==([^=\n]+)==/;
    const match = rule.exec(src);
    if (match) {
      return { type: 'highlight', raw: match[0], text: match[1] };
    }
    return undefined;
  },
  renderer(token: { text: string }) {
    return `<mark>${token.text}</mark>`;
  },
};

/** Inline extension: :emoji: shortcodes */
const emojiExtension = {
  name: 'emoji',
  level: 'inline' as const,
  start(src: string) {
    return src.indexOf(':');
  },
  tokenizer(src: string) {
    const rule = /^:([a-z0-9_+-]+):/i;
    const match = rule.exec(src);
    if (match && EMOJI_MAP[match[1]]) {
      return { type: 'emoji', raw: match[0], name: match[1] };
    }
    return undefined;
  },
  renderer(token: { name: string }) {
    return EMOJI_MAP[token.name] || `:${token.name}:`;
  },
};

/** Block extension: footnotes */
const footnoteRefRE = /^\[\^([^\]]+)\]/;
const footnoteDefRE = /^\[\^([^\]]+)\]:\s*/;

const footnoteExtension = {
  name: 'footnote',
  level: 'block' as const,
  start(src: string) {
    return src.search(footnoteDefRE);
  },
  tokenizer(src: string) {
    const match = footnoteDefRE.exec(src);
    if (!match) return undefined;
    const id = match[1];
    const start = match[0].length;
    // Consume lines until blank line or next footnote def
    let end = src.indexOf('\n\n', start);
    if (end === -1) end = src.length;
    let body = src.slice(start, end).trim();
    // Inline footnote refs within body
    body = body.replace(
      /\[\^([^\]]+)\]/g,
      (_, refId: string) =>
        `<sup class="footnote-ref" id="fnref-${refId}"><a href="#fn-${refId}">${refId}</a></sup>`,
    );
    return { type: 'footnote', raw: src.slice(0, end), id, body };
  },
  renderer(token: { id: string; body: string }) {
    return `<div class="footnote" id="fn-${token.id}"><sup>${token.id}</sup> ${token.body} <a href="#fnref-${token.id}" class="footnote-backref">↩</a></div>`;
  },
};

/** Inline extension: [[wikilink]] syntax for Obsidian vault mode */
const wikilinkExtension = {
  name: 'wikilink',
  level: 'inline' as const,
  start(src: string) {
    return src.indexOf('[[');
  },
  tokenizer(src: string) {
    const match = /^\[\[([^\[\]]+?)(?:\|([^\[\]]*?))?\]\]/.exec(src);
    if (!match) return undefined;
    const title = match[1].trim();
    const display = (match[2] || match[1]).trim();
    return {
      type: 'wikilink',
      raw: match[0],
      title,
      display,
    };
  },
  renderer(token: { title: string; display: string }) {
    const escapedDisplay = token.display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return `<a href="doc77-wikilink:${encodeURIComponent(token.title)}" data-display="${escapedDisplay}">${escapedDisplay}</a>`;
  },
};

// Register extensions
marked.use({ extensions: [highlightExtension, emojiExtension, footnoteExtension, wikilinkExtension] });

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

function rewriteLocalUrl(
  url: string,
  projectId: number | undefined,
  filePath: string | undefined,
): string {
  if (!url) return url;
  if (/^(https?:|mailto:|ftp:|data:|blob:|doc77-wikilink:)/i.test(url)) return url;
  if (url.startsWith('#')) return url;
  if (projectId == null || !filePath) return url;

  const hashIndex = url.indexOf('#');
  const anchor = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const pathPart = hashIndex >= 0 ? url.slice(0, hashIndex) : url;

  const dir = path.dirname(filePath);
  const resolved = path.posix.normalize(path.posix.join(dir, pathPart));

  const endpoint = isRawExtension(resolved) ? 'raw' : 'content';
  return `/api/${endpoint}/${projectId}?path=${encodeURIComponent(resolved)}${anchor}`;
}

function rewriteHtmlUrls(
  html: string,
  projectId: number | undefined,
  filePath: string | undefined,
): string {
  if (projectId == null || !filePath) return html;
  return html.replace(
    /<(a|img|video|audio|source|iframe|embed)\b([^>]*?)\s+(src|href)=(["'])([^"']+)\4/gi,
    (match, tag, before, attr, quote, url) => {
      const rewritten = rewriteLocalUrl(url, projectId, filePath);
      return `<${tag}${before} ${attr}=${quote}${rewritten}${quote}`;
    },
  );
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

/** Convert inline footnote references [^id] to sup links. */
function renderFootnoteRefs(html: string): string {
  return html.replace(
    /\[\^([^\]]+)\]/g,
    (_, id: string) =>
      `<sup class="footnote-ref" id="fnref-${id}"><a href="#fn-${id}">${id}</a></sup>`,
  );
}

/** Convert GH-style alerts (> [!NOTE]) to styled divs. */
function renderAlerts(html: string): string {
  const ALERT_TYPES: Record<string, string> = {
    NOTE: '📝',
    TIP: '💡',
    IMPORTANT: '❗',
    WARNING: '⚠️',
    CAUTION: '🔥',
  };
  return html.replace(
    /<blockquote>\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/gi,
    (_, type: string) => {
      const icon = ALERT_TYPES[type.toUpperCase()] || '';
      const cls = `markdown-alert markdown-alert-${type.toLowerCase()}`;
      return `<blockquote class="${cls}"><p><strong>${icon} ${type}</strong></p>\n<p>`;
    },
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function renderMarkdown(
  content: string,
  opts?: { projectId?: number; filePath?: string; obsidianMode?: boolean },
): string {
  if (!content) return '';

  const { projectId, filePath, obsidianMode } = opts || {};

  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    if (lang === 'mermaid') {
      return `<pre class="mermaid">${text}</pre>`;
    }
    // PlantUML — render via kroki.io, fallback to source on error
    if (lang === 'plantuml') {
      const enc = encodePlantUML(text);
      return (
        `<div class="doc77-code-block plantuml-block">` +
        `<img src="https://kroki.io/plantuml/svg/${enc}" ` +
        `onerror="this.style.display='none';this.nextElementSibling.style.display='block'" ` +
        `alt="PlantUML diagram" loading="lazy">` +
        `<pre style="display:none"><code class="language-plantuml">${text}</code></pre>` +
        `</div>`
      );
    }
    const langClass = lang ? ` class="language-${lang}"` : '';
    return (
      `<div class="doc77-code-block">` +
      `<button class="code-copy-btn" title="复制" onclick="copyCode(this)"></button>` +
      `<pre><code${langClass}>${text}</code></pre>` +
      `</div>`
    );
  };

  // Generate heading IDs for anchor links (e.g. [跳至](#my-heading))
  renderer.heading = ({ tokens, depth }: { tokens: { text: string }[]; depth: number }) => {
    const text = tokens.map((t) => t.text).join('');
    const id = text
      .toLowerCase()
      .replace(/[^\w一-鿿\s-]/g, '')
      .replace(/\s+/g, '-');
    return `<h${depth} id="${id}">${text}</h${depth}>`;
  };

  let html = marked.parse(content, {
    gfm: true,
    breaks: false,
    headerIds: true,
    renderer,
  }) as string;

  // Post-processing
  html = rewriteHtmlUrls(html, projectId, filePath);
  html = renderAlerts(html);
  html = renderFootnoteRefs(html);

  // Wikilink resolution (only in obsidian mode)
  if (obsidianMode && projectId != null && filePath) {
    html = resolveWikilinks(html, projectId, filePath);
  }

  return html;
}

// ---------------------------------------------------------------------------
// Wikilink resolution (Obsidian mode)
// ---------------------------------------------------------------------------

/** Post-process wikilink placeholder anchors into real links or dead-link spans */
function resolveWikilinks(html: string, projectId: number, filePath: string): string {
  const projectRoot = getProjectRoot(projectId);
  if (!projectRoot) return html;

  return html.replace(
    /<a href="doc77-wikilink:([^"]+)"[^>]*>([^<]+)<\/a>/g,
    (_match: string, encoded: string, display: string) => {
      const title = decodeURIComponent(encoded);
      const resolved = resolveWikilink(title, projectId, projectRoot);
      if (resolved) {
        // Convert resolved absolute path to doc77 API URL
        const rootPrefix = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
        const relative = resolved.startsWith(rootPrefix)
          ? path.posix.normalize(resolved.slice(rootPrefix.length))
          : path.posix.normalize(resolved);
        const apiUrl = `/api/content/${projectId}?path=${encodeURIComponent(relative)}`;
        return `<a href="${apiUrl}" class="wikilink">${display}</a>`;
      }
      // Dead link
      const escapedTitle = title.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      return `<span class="wikilink-dead" title="未找到笔记: ${escapedTitle}">[[${escapedTitle}]]</span>`;
    },
  );
}

/** Get project root path from DB */
function getProjectRoot(projectId: number): string | null {
  try {
    const db = getConnection();
    const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined;
    if (!row) return null;
    return resolveProjectPath(row.path);
  } catch {
    return null;
  }
}

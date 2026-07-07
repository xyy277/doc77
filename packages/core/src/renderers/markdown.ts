import { marked } from 'marked';

/**
 * Render Markdown content to HTML with theme-aware code blocks.
 * Uses marked with GFM (GitHub Flavored Markdown) enabled.
 * Code blocks are wrapped in .doc77-code-block for theme CSS variable support.
 */
export function renderMarkdown(content: string): string {
  if (!content) return '';

  // Custom renderer to wrap code blocks with theme class
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    const langClass = lang ? ` class="language-${lang}"` : '';
    return `<div class="doc77-code-block"><pre><code${langClass}>${text}</code></pre></div>`;
  };

  return marked.parse(content, {
    gfm: true,
    breaks: false,
    renderer,
  }) as string;
}

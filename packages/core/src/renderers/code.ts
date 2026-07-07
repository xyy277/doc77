/**
 * Generate an HTML wrapper for syntax-highlighted code display.
 * Uses CSS classes for theme-aware styling (--bg-code / --text-code).
 *
 * @param content - The raw code content
 * @param language - Programming language identifier
 */
export function renderCode(content: string, language: string): string {
  const escapedContent = escapeHtml(content);
  return `<div class="doc77-code-block"><pre><code class="language-${escapeHtml(language)}">${escapedContent}</code></pre></div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

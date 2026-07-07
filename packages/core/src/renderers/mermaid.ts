/**
 * Generate an HTML wrapper for client-side Mermaid.js rendering.
 * The browser will use mermaid.js to render the diagram on load.
 */
export function renderMermaid(content: string): string {
  return `<pre class="mermaid">\n${content}\n</pre>`;
}

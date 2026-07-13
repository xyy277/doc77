import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/renderers/markdown.js';
import { renderMermaid } from '../src/renderers/mermaid.js';
import { renderPdf } from '../src/renderers/pdf.js';
import { renderImage } from '../src/renderers/image.js';
import { renderCode } from '../src/renderers/code.js';
import { getRendererForFile } from '../src/renderers/index.js';

describe('Markdown renderer', () => {
  it('should render headings', () => {
    const html = renderMarkdown('# Hello World');
    expect(html).toContain('<h1');
    expect(html).toContain('Hello World');
  });

  it('should render GFM tables', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const html = renderMarkdown(md);
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('1');
    expect(html).toContain('2');
  });

  it('should render GFM task lists', () => {
    const md = '- [x] Done\n- [ ] Todo';
    const html = renderMarkdown(md);
    expect(html).toContain('checked');
    expect(html).toContain('Done');
    expect(html).toContain('Todo');
  });

  it('should render fenced code blocks with language', () => {
    const md = '```typescript\nconst x = 1;\n```';
    const html = renderMarkdown(md);
    expect(html).toContain('<code');
    expect(html).toContain('language-typescript');
  });

  it('should handle empty input', () => {
    const html = renderMarkdown('');
    expect(html).toBe('');
  });

  it('should handle empty url gracefully', () => {
    const html = renderMarkdown('[]( )', { projectId: 1, filePath: 'docs/readme.md' });
    expect(html).toContain('<a');
  });
});

describe('Markdown renderer — local URL rewriting', () => {
  const opts = { projectId: 1, filePath: 'docs/notes.md' };

  it('should rewrite Markdown image src to /api/raw', () => {
    const html = renderMarkdown('![alt](./images/photo.png)', opts);
    expect(html).toContain('/api/raw/1?path=docs%2Fimages%2Fphoto.png');
    expect(html).not.toContain('./images/photo.png');
  });

  it('should rewrite Markdown link to /api/content', () => {
    const html = renderMarkdown('[doc](./other.md)', opts);
    expect(html).toContain('/api/content/1?path=docs%2Fother.md');
  });

  it('should rewrite GIF images', () => {
    const html = renderMarkdown('![gif](./anim.gif)', opts);
    expect(html).toContain('/api/raw/1?path=docs%2Fanim.gif');
  });

  it('should rewrite relative paths with .. traversal', () => {
    const html = renderMarkdown('![img](../images/logo.png)', opts);
    expect(html).toContain('images%2Flogo.png');
    expect(html).not.toContain('..');
  });

  it('should preserve anchor in rewritten URLs', () => {
    const html = renderMarkdown('[link](./other.md#section)', opts);
    expect(html).toContain('/api/content/1?path=docs%2Fother.md#section');
  });

  it('should not rewrite external https URLs', () => {
    const md = '[ext](https://example.com/page) ![img](https://cdn.example.com/img.png)';
    const html = renderMarkdown(md, opts);
    expect(html).toContain('https://example.com/page');
    expect(html).toContain('https://cdn.example.com/img.png');
  });

  it('should not rewrite mailto links', () => {
    const html = renderMarkdown('[email](mailto:a@b.com)', opts);
    expect(html).toContain('mailto:a@b.com');
  });

  it('should not rewrite pure anchor links', () => {
    const html = renderMarkdown('[top](#top)', opts);
    expect(html).toContain('href="#top"');
  });

  it('should not rewrite when no projectId provided (backward compat)', () => {
    const html = renderMarkdown('![img](./photo.png)');
    expect(html).toContain('./photo.png');
    expect(html).not.toContain('/api/raw');
  });

  it('should rewrite raw HTML img src', () => {
    const html = renderMarkdown('<img src="./photo.jpg" alt="pic">', opts);
    expect(html).toContain('/api/raw/1?path=docs%2Fphoto.jpg');
  });

  it('should rewrite raw HTML video src', () => {
    const html = renderMarkdown('<video src="./demo.mp4" controls></video>', opts);
    expect(html).toContain('/api/raw/1?path=docs%2Fdemo.mp4');
  });

  it('should rewrite raw HTML audio src', () => {
    const html = renderMarkdown('<audio src="./song.mp3" controls></audio>', opts);
    expect(html).toContain('/api/raw/1?path=docs%2Fsong.mp3');
  });

  it('should rewrite raw HTML source src inside video', () => {
    const html = renderMarkdown('<video><source src="./vid.webm"></video>', opts);
    expect(html).toContain('/api/raw/1?path=docs%2Fvid.webm');
  });

  it('should rewrite raw HTML iframe src', () => {
    const html = renderMarkdown('<iframe src="./page.html"></iframe>', opts);
    expect(html).toContain('/api/content/1?path=docs%2Fpage.html');
  });

  it('should rewrite raw HTML embed src', () => {
    const html = renderMarkdown('<embed src="./doc.pdf">', opts);
    expect(html).toContain('/api/raw/1?path=docs%2Fdoc.pdf');
  });

  it('should handle data: URIs as-is', () => {
    const html = renderMarkdown('<img src="data:image/png;base64,ABC">', opts);
    expect(html).toContain('data:image/png;base64,ABC');
  });
});

describe('Mermaid renderer', () => {
  it('should wrap mermaid content in a pre.mermaid tag', () => {
    const diagram = 'graph TD\nA-->B';
    const html = renderMermaid(diagram);
    expect(html).toContain('class="mermaid"');
    expect(html).toContain('graph TD');
    expect(html).toContain('A-->B');
  });

  it('should preserve diagram content exactly', () => {
    const diagram = 'sequenceDiagram\nAlice->>Bob: Hello';
    const html = renderMermaid(diagram);
    expect(html).toContain('Alice->>Bob: Hello');
  });
});

describe('PDF renderer', () => {
  it('should generate PDF.js viewer HTML', () => {
    const url = '/api/content/1?path=doc.pdf';
    const html = renderPdf(url);
    expect(html).toContain('pdf-viewer');
    expect(html).toContain('data-pdf-url');
    expect(html).toContain(url);
    expect(html).toContain('canvas');
  });

  it('should include page navigation', () => {
    const html = renderPdf('/files/doc.pdf');
    expect(html).toContain('page');
  });
});

describe('Image renderer', () => {
  it('should generate img tag', () => {
    const html = renderImage('/api/content/1?path=photo.png', 'photo.png');
    expect(html).toContain('<img');
    expect(html).toContain('src="/api/content/1?path=photo.png"');
    expect(html).toContain('alt="photo.png"');
  });
});

describe('Code renderer', () => {
  it('should wrap code in pre/code tags', () => {
    const html = renderCode('const x = 1;', 'typescript');
    expect(html).toContain('<pre');
    expect(html).toContain('<code');
    expect(html).toContain('language-typescript');
    expect(html).toContain('const x = 1;');
  });
});

describe('Renderer dispatcher', () => {
  it('should return markdown renderer for .md files', () => {
    expect(getRendererForFile('readme.md')).toBe('markdown');
  });

  it('should return mermaid renderer for .mermaid files', () => {
    expect(getRendererForFile('diagram.mermaid')).toBe('mermaid');
  });

  it('should return mermaid renderer for .mmd files', () => {
    expect(getRendererForFile('diagram.mmd')).toBe('mermaid');
  });

  it('should return pdf renderer for .pdf files', () => {
    expect(getRendererForFile('doc.pdf')).toBe('pdf');
  });

  it('should return image renderer for image files', () => {
    expect(getRendererForFile('photo.png')).toBe('image');
    expect(getRendererForFile('photo.jpg')).toBe('image');
    expect(getRendererForFile('photo.jpeg')).toBe('image');
    expect(getRendererForFile('photo.svg')).toBe('image');
    expect(getRendererForFile('photo.gif')).toBe('image');
    expect(getRendererForFile('photo.webp')).toBe('image');
  });

  it('should return code renderer for known code file types', () => {
    expect(getRendererForFile('app.ts')).toBe('code');
    expect(getRendererForFile('app.js')).toBe('code');
    expect(getRendererForFile('app.py')).toBe('code');
    expect(getRendererForFile('app.json')).toBe('code');
    expect(getRendererForFile('Dockerfile')).toBe('code');
  });

  it('should return text fallback for unknown types', () => {
    expect(getRendererForFile('data.bin')).toBe('text');
  });
});

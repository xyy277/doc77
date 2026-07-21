import { describe, it, expect } from 'vitest';
import { bundleHTML, type BundleParams } from './html-bundler.js';

describe('bundleHTML', () => {
  const minimalParams: BundleParams = {
    title: 'test-doc',
    content: '<p>Hello world</p>',
    styles: ['.doc-content p { color: red; }'],
    images: [],
    theme: 'light',
  };

  it('should produce a complete HTML document', () => {
    const result = bundleHTML(minimalParams);
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('</html>');
  });

  it('should contain the title in <title> tag', () => {
    const result = bundleHTML(minimalParams);
    expect(result).toContain('<title>test-doc</title>');
  });

  it('should inline the given CSS', () => {
    const result = bundleHTML(minimalParams);
    expect(result).toContain('.doc-content p { color: red; }');
  });

  it('should replace image URLs with base64 data URIs', () => {
    const params: BundleParams = {
      ...minimalParams,
      content: '<img src="/api/raw/1?path=img.png" alt="test">',
      images: [{ url: '/api/raw/1?path=img.png', base64: 'data:image/png;base64,iVBORw0KGgo=' }],
    };
    const result = bundleHTML(params);
    expect(result).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(result).not.toContain('/api/raw/1?path=img.png');
  });

  it('should remove code-copy-btn elements', () => {
    const params: BundleParams = {
      ...minimalParams,
      content:
        '<div class="doc77-code-block"><button class="code-copy-btn" title="复制"></button><pre><code>hi</code></pre></div>',
    };
    const result = bundleHTML(params);
    expect(result).not.toContain('code-copy-btn');
  });

  it('should apply dark theme variables when theme is dark', () => {
    const result = bundleHTML({ ...minimalParams, theme: 'dark' });
    expect(result).toContain('data-theme="dark"');
    expect(result).toContain('--bg-body:#0f172a');
  });

  it('should add class="dark" on <html> for dark exports (Tailwind dark: variants)', () => {
    const dark = bundleHTML({ ...minimalParams, theme: 'dark' });
    expect(dark).toMatch(/<html [^>]*class="dark"/);
    const light = bundleHTML(minimalParams);
    expect(light).not.toContain('class="dark"');
  });

  it('should force themed background after collected CSS (export chrome wins)', () => {
    // Simulate collected app CSS that would otherwise repaint the page white
    const result = bundleHTML({
      ...minimalParams,
      theme: 'dark',
      styles: ['html{background:#f8fafc}html.dark{background:#0f172a}body{padding:0}'],
    });
    const chromeIdx = result.indexOf('Doc77 export chrome');
    const collectedIdx = result.indexOf('html{background:#f8fafc}');
    expect(collectedIdx).toBeGreaterThan(-1);
    expect(chromeIdx).toBeGreaterThan(collectedIdx); // chrome block comes after collected CSS
    expect(result).toContain('html{background:var(--bg-body)!important}');
    expect(result).toContain('background:var(--bg-body)!important;');
  });

  it('should use two-column layout with comfortable padding', () => {
    const result = bundleHTML(minimalParams);
    // Layout container provides the spacing (not body padding as before)
    expect(result).toContain('class="doc77-layout"');
    expect(result).toContain('padding:2rem 1.5rem');
  });

  it('should escape HTML in title', () => {
    const result = bundleHTML({ ...minimalParams, title: 'test <script>alert("xss")</script>' });
    // Title tag content is HTML-escaped
    expect(result).toContain('<title>test &lt;script&gt;alert');
    // Title text in the HTML body is also escaped (via escapeHTML)
    expect(result).toContain('&lt;script&gt;alert');
  });
});

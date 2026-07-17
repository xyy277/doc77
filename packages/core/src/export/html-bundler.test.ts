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
      content: '<div class="doc77-code-block"><button class="code-copy-btn" title="复制"></button><pre><code>hi</code></pre></div>',
    };
    const result = bundleHTML(params);
    expect(result).not.toContain('code-copy-btn');
  });

  it('should apply dark theme variables when theme is dark', () => {
    const result = bundleHTML({ ...minimalParams, theme: 'dark' });
    expect(result).toContain('data-theme="dark"');
    expect(result).toContain('--bg-body:#0f172a');
  });

  it('should escape HTML in title', () => {
    const result = bundleHTML({ ...minimalParams, title: 'test <script>alert("xss")</script>' });
    expect(result).toContain('&lt;script&gt;alert');
    expect(result).not.toContain('<script>');
  });
});

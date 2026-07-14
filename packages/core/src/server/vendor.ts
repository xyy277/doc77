/**
 * Vendor asset management — download CDN resources for offline use.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface VendorAsset {
  name: string; // local filename under vendor/
  url: string; // CDN URL
  type: 'js' | 'css' | 'font' | 'wasm';
  size?: string; // human-readable size hint
}

export const VENDOR_ASSETS: VendorAsset[] = [
  { name: 'tailwind.js', url: 'https://cdn.tailwindcss.com', type: 'js', size: '~500KB' },
  {
    name: 'mermaid.min.js',
    url: 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js',
    type: 'js',
    size: '~2MB',
  },
  {
    name: 'highlight.min.js',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
    type: 'js',
    size: '~500KB',
  },
  {
    name: 'highlight-github-dark.css',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
    type: 'css',
    size: '~10KB',
  },
  {
    name: 'pdf.min.mjs',
    url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs',
    type: 'js',
    size: '~350KB',
  },
  {
    name: 'pdf.worker.min.mjs',
    url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
    type: 'js',
    size: '~1.4MB',
  },
  {
    name: 'xlsx.mini.min.js',
    url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.mini.min.js',
    type: 'js',
    size: '~150KB',
  },
  {
    name: 'mammoth.browser.min.js',
    url: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
    type: 'js',
    size: '~160KB',
  },
  {
    name: 'pyodide.js',
    url: 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.js',
    type: 'js',
    size: '~600KB',
  },
  {
    name: 'pyodide-pyodide.asm.wasm',
    url: 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.asm.wasm',
    type: 'wasm',
    size: '~9MB',
  },
  {
    name: 'pyodide-python_stdlib.zip',
    url: 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/python_stdlib.zip',
    type: 'wasm',
    size: '~2MB',
  },
  {
    name: 'katex.min.css',
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
    type: 'css',
    size: '~25KB',
  },
  {
    name: 'katex.min.js',
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
    type: 'js',
    size: '~280KB',
  },
  {
    name: 'katex-auto-render.min.js',
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js',
    type: 'js',
    size: '~10KB',
  },
];

/**
 * Download vendor assets to the given directory.
 */
export async function fetchVendorAssets(vendorDir: string, assets: VendorAsset[]): Promise<void> {
  fs.mkdirSync(vendorDir, { recursive: true });

  for (const asset of assets) {
    const dest = path.join(vendorDir, asset.name);
    if (fs.existsSync(dest)) {
      console.log(`  ✓ ${asset.name} (已存在)`);
      continue;
    }
    try {
      console.log(`  ↓ ${asset.name} (${asset.size || '?'})...`);
      const resp = await fetch(asset.url, { signal: AbortSignal.timeout(120000) });
      if (!resp.ok) {
        console.error(`  ✗ ${asset.name}: HTTP ${resp.status}`);
        continue;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(dest, buffer);
      console.log(`  ✓ ${asset.name} (${(buffer.length / 1024).toFixed(0)} KB)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error(`  ✗ ${asset.name}: ${msg}`);
    }
  }

  // Write a marker file to indicate vendor is ready
  fs.writeFileSync(path.join(vendorDir, '.ready'), Date.now().toString());
}

/**
 * Check if the vendor directory is populated.
 */
export function isVendorReady(vendorDir: string): boolean {
  return fs.existsSync(path.join(vendorDir, '.ready'));
}

/**
 * Resolve a vendor asset path — returns null if not available.
 */
export function vendorAssetPath(vendorDir: string, name: string): string | null {
  const p = path.join(vendorDir, name);
  return fs.existsSync(p) ? p : null;
}

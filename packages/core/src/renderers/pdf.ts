/**
 * Generate an HTML wrapper for client-side PDF.js rendering.
 * Provides a canvas-based viewer with page navigation.
 *
 * @param fileUrl - The URL to fetch the PDF file
 */
export function renderPdf(fileUrl: string): string {
  const escapedUrl = escapeHtml(fileUrl);
  return `
<div class="pdf-viewer" data-pdf-url="${escapedUrl}">
  <div class="pdf-toolbar">
    <button class="pdf-prev" onclick="this.closest('.pdf-viewer').dispatchEvent(new CustomEvent('pdf-prev'))">◀ 上一页</button>
    <span class="pdf-page-info">第 <span class="pdf-current-page">1</span> / <span class="pdf-total-pages">?</span> 页</span>
    <button class="pdf-next" onclick="this.closest('.pdf-viewer').dispatchEvent(new CustomEvent('pdf-next'))">下一页 ▶</button>
  </div>
  <div class="pdf-canvas-wrapper">
    <canvas class="pdf-canvas"></canvas>
  </div>
  <div class="pdf-loading">加载 PDF 中...</div>
</div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

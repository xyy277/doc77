import { t } from '../i18n/index.js';

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
    <button class="pdf-prev" onclick="this.closest('.pdf-viewer').dispatchEvent(new CustomEvent('pdf-prev'))">${t('web.preview.pdfPrev')}</button>
    <span class="pdf-page-info">${t('web.preview.pdfPageInfo')}</span>
    <button class="pdf-next" onclick="this.closest('.pdf-viewer').dispatchEvent(new CustomEvent('pdf-next'))">${t('web.preview.pdfNext')}</button>
  </div>
  <div class="pdf-canvas-wrapper">
    <canvas class="pdf-canvas"></canvas>
  </div>
  <div class="pdf-loading">${t('web.preview.pdfLoading')}</div>
</div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

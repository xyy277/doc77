/**
 * Generate an HTML img tag for image preview.
 *
 * @param url - The URL to fetch the image
 * @param alt - Alt text (typically the filename)
 */
export function renderImage(url: string, alt: string): string {
  const escapedUrl = escapeHtml(url);
  const escapedAlt = escapeHtml(alt);
  return `<img src="${escapedUrl}" alt="${escapedAlt}" class="preview-image" loading="lazy" />`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

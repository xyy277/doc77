// gallery-core.js — Shared masonry grid and card rendering
// Reused by both gallery.html and preview.html

const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.svg','.webp','.bmp','.ico','.avif']);
const VIDEO_EXTS = new Set(['.mp4','.webm','.mov','.mkv','.avi','.m4v']);

function isMediaFile(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

/**
 * Create a masonry grid card element.
 * @param {Object} item - Gallery entry from API
 * @returns {HTMLElement}
 */
function createMediaCard(item) {
  // Directory card — folder icon, no thumbnail
  if (item.type === 'directory') {
    const wrapper = document.createElement('div');
    wrapper.className = 'masonry-item gallery-item directory-card relative rounded-lg overflow-hidden group cursor-pointer bg-doc77-100 dark:bg-doc77-800 image-card-hover border border-doc77-200 dark:border-doc77-700/50 transition-colors duration-200';
    wrapper.dataset.id = item.path;

    const inner = document.createElement('div');
    inner.className = 'flex flex-col items-center justify-center aspect-square p-4 gap-2';

    const icon = document.createElement('div');
    icon.className = 'text-yellow-500/80 dark:text-yellow-400/80 group-hover:scale-110 transition-transform duration-300';
    icon.innerHTML = '<i class="ph-fill ph-folder text-5xl"></i>';

    const name = document.createElement('span');
    name.className = 'text-xs font-medium text-doc77-700 dark:text-doc77-200 text-center truncate w-full';
    name.textContent = item.name;

    inner.appendChild(icon);
    inner.appendChild(name);
    wrapper.appendChild(inner);
    return wrapper;
  }

  // Media card (image/video)
  const wrapper = document.createElement('div');
  wrapper.className = 'masonry-item gallery-item relative rounded-lg overflow-hidden group cursor-pointer bg-doc77-100 dark:bg-doc77-800 image-card-hover border border-doc77-200 dark:border-doc77-700/50 transition-colors duration-200';
  wrapper.dataset.id = item.path;

  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'img-wrapper relative w-full';

  const img = document.createElement('img');
  img.src = item.thumbnail_url;
  img.className = 'absolute top-0 left-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = item.name;
  // Fallback: if thumbnail fails to load, show a placeholder icon instead of a broken image
  img.onerror = function() {
    img.style.display = 'none';
    var placeholder = document.createElement('div');
    placeholder.className = 'absolute inset-0 flex items-center justify-center bg-doc77-100 dark:bg-doc77-800';
    placeholder.innerHTML = '<i class="ph ph-image text-3xl text-doc77-300 dark:text-doc77-600"></i>';
    imgWrapper.insertBefore(placeholder, img);
  };

  // Preserve aspect ratio to prevent layout shift
  if (item.width && item.height) {
    imgWrapper.style.paddingBottom = `${(item.height / item.width) * 100}%`;
    img.onload = function() { imgWrapper.style.paddingBottom = ''; };
  } else {
    imgWrapper.style.paddingBottom = '75%';
  }

  // Bottom gradient overlay
  const overlay = document.createElement('div');
  overlay.className = 'absolute inset-0 img-overlay opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-3';
  const nameText = document.createElement('span');
  nameText.className = 'text-white text-xs font-medium truncate drop-shadow-md';
  nameText.textContent = item.name;
  overlay.appendChild(nameText);

  // Timeline badge (month label + count)
  if (item.isTimeline) {
    var tlBadge = document.createElement('div');
    tlBadge.className = 'absolute bottom-2 left-2 right-2 bg-black/60 backdrop-blur-md rounded-md px-2 py-1 text-xs text-white font-medium text-center shadow-sm';
    tlBadge.innerHTML = (item.name || '') + ' <span class="text-white/60">(' + (item.count || 0) + ')</span>';
    imgWrapper.appendChild(tlBadge);
  }

  // Video badge
  if (item.type === 'video') {
    const vidBadge = document.createElement('div');
    vidBadge.className = 'absolute top-2 right-2 bg-black/60 backdrop-blur-md rounded-md px-1.5 py-0.5 flex items-center gap-1 text-[10px] text-white font-medium shadow-sm border border-white/10';
    vidBadge.innerHTML = '<i class="ph-fill ph-play-circle"></i> ' + (item.duration || '');
    imgWrapper.appendChild(vidBadge);
  }

  // Selection checkbox
  const checkbox = document.createElement('div');
  checkbox.className = 'gallery-item-checkbox absolute top-2 left-2 w-5 h-5 rounded-full border-2 border-white/70 bg-black/20 backdrop-blur-sm items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-all z-10';
  checkbox.innerHTML = '<i class="ph-bold ph-check text-xs opacity-0 scale-50 transition-all"></i>';

  imgWrapper.appendChild(img);
  imgWrapper.appendChild(overlay);
  imgWrapper.appendChild(checkbox);
  wrapper.appendChild(imgWrapper);

  return wrapper;
}

/**
 * Render media items into a masonry grid container.
 * Groups items by month if grouping is enabled.
 * @param {HTMLElement} container
 * @param {Array} items
 * @param {Object} options - { grouped: boolean, onCardClick: function, projectId: number }
 */
function renderGrid(container, items, options = {}) {
  container.innerHTML = '';

  if (options.grouped && items.length > 0) {
    // Separate directories from media items — directories render first, ungrouped
    const dirs = items.filter(i => i.type === 'directory');
    const mediaItems = items.filter(i => i.type !== 'directory');

    // Render directory section first (if any) — folders before date groups
    if (dirs.length > 0) {
      const dirSection = document.createElement('div');
      dirSection.className = 'mb-8';
      const dirHeader = document.createElement('div');
      dirHeader.className = 'section-header sticky top-0 bg-white/95 dark:bg-[#0b1121]/95 backdrop-blur-sm z-10 py-2 mb-4 flex items-center justify-between border-b border-doc77-100 dark:border-doc77-800/50 transition-colors duration-200';
      dirHeader.innerHTML = '<div class="flex items-center gap-2"><i class="ph-fill ph-folder text-yellow-500/80 text-lg"></i><h2 class="text-lg font-bold text-doc77-900 dark:text-doc77-100">Folders</h2><span class="text-doc77-500 text-sm font-medium bg-doc77-100 dark:bg-doc77-800/50 px-2 py-0.5 rounded-full">' + dirs.length + '</span></div>';
      dirSection.appendChild(dirHeader);
      const dirGrid = document.createElement('div');
      dirGrid.className = 'masonry-grid';
      for (const item of dirs) {
        const card = createMediaCard(item);
        card.addEventListener('click', (e) => {
          if (options.onCardClick) options.onCardClick(item, e);
        });
        dirGrid.appendChild(card);
      }
      dirSection.appendChild(dirGrid);
      container.appendChild(dirSection);
    }

    // Group media by month (from exif_date or modified)
    const groups = new Map();
    for (const item of mediaItems) {
      const month = (item.exif_date || item.modified).slice(0, 7);
      if (!groups.has(month)) groups.set(month, []);
      groups.get(month).push(item);
    }

    for (const [label, groupItems] of groups) {
      const section = document.createElement('div');
      section.className = 'mb-8';

      const header = document.createElement('div');
      header.className = 'section-header sticky top-0 bg-white/95 dark:bg-[#0b1121]/95 backdrop-blur-sm z-10 py-2 mb-4 flex items-center justify-between border-b border-doc77-100 dark:border-doc77-800/50 transition-colors duration-200';
      header.innerHTML = '<div class="flex items-center gap-2"><h2 class="text-lg font-bold text-doc77-900 dark:text-doc77-100">' + label + '</h2><span class="text-doc77-500 text-sm font-medium bg-doc77-100 dark:bg-doc77-800/50 px-2 py-0.5 rounded-full">' + groupItems.length + ' items</span></div>';
      section.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'masonry-grid';
      for (const item of groupItems) {
        const card = createMediaCard(item);
        card.addEventListener('click', (e) => {
          if (options.onCardClick) options.onCardClick(item, e);
        });
        grid.appendChild(card);
      }
      section.appendChild(grid);
      container.appendChild(section);
    }
  } else {
    const grid = document.createElement('div');
    grid.className = 'masonry-grid';
    for (const item of items) {
      const card = createMediaCard(item);
      card.addEventListener('click', (e) => {
        if (options.onCardClick) options.onCardClick(item, e);
      });
      grid.appendChild(card);
    }
    container.appendChild(grid);
  }
}

/**
 * Setup Intersection Observer for lazy loading images.
 */
function setupLazyLoading() {
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
          }
          observer.unobserve(img);
        }
      }
    }, { rootMargin: '200px' });

    document.querySelectorAll('img[loading="lazy"]').forEach(img => observer.observe(img));
  }
}

// Export for use in other scripts
window.GalleryCore = { createMediaCard, renderGrid, setupLazyLoading, isMediaFile };

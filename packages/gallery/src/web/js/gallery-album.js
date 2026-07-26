/**
 * Doc77 Gallery Album Management UI Module
 *
 * Consumes: /api/albums, /api/albums/:albumId, /api/albums/:albumId/items
 * Produces: Album CRUD operations and sidebar rendering
 */

window.GalleryAlbum = (function() {
  async function fetchAlbums() {
    const resp = await fetch('/api/albums');
    return resp.json();
  }

  async function createAlbum(name, description) {
    const resp = await fetch('/api/albums', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    return resp.json();
  }

  async function addToAlbum(albumId, projectId, filePaths) {
    for (const filePath of filePaths) {
      await fetch(`/api/albums/${albumId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, file_path: filePath }),
      });
    }
  }

  async function deleteAlbum(albumId) {
    await fetch(`/api/albums/${albumId}`, { method: 'DELETE' });
  }

  async function renderAlbumSidebar(container, projectId) {
    const albums = await fetchAlbums();
    container.innerHTML = albums.map(a =>
      `<li class="flex items-center group/album gap-0.5">
        <a href="#" class="flex items-center gap-3 px-3 py-1.5 rounded-lg text-doc77-600 dark:text-doc77-300 hover:bg-doc77-100 dark:hover:bg-doc77-800 transition-colors album-nav-item flex-1 min-w-0" data-album-id="${a.id}" data-album-name="${escHtml(a.name)}">
          <div class="w-6 h-6 rounded bg-gradient-to-br from-blue-400 to-indigo-600 flex items-center justify-center shrink-0 shadow-sm">
            <i class="ph-fill ph-images text-white text-xs"></i>
          </div>
          <span class="truncate flex-1">${escHtml(a.name)}</span>
          <span class="text-xs text-doc77-500">${a.item_count || 0}</span>
        </a>
        <button class="shrink-0 p-1.5 rounded-lg text-doc77-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover/album:opacity-100" title="Delete album" data-delete-album-id="${a.id}" data-delete-album-name="${escHtml(a.name)}">
          <i class="ph ph-trash text-sm"></i>
        </button>
      </li>`
    ).join('');
    // Wire album click handlers
    container.querySelectorAll('.album-nav-item').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.preventDefault();
        var albumId = parseInt(this.dataset.albumId);
        var albumName = this.dataset.albumName;
        if (typeof window.loadAlbumGallery === 'function') {
          window.loadAlbumGallery(albumId, albumName);
        }
      });
    });
    // Wire delete button clicks via delegation (avoids XSS via inline onclick)
    container.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-delete-album-id]');
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      var albumId = parseInt(btn.dataset.deleteAlbumId, 10);
      var albumName = btn.dataset.deleteAlbumName;
      // confirmDeleteAlbum is defined in gallery.html
      if (typeof window.confirmDeleteAlbum === 'function') {
        window.confirmDeleteAlbum(albumId, albumName);
      } else if (typeof confirmDeleteAlbum === 'function') {
        confirmDeleteAlbum(albumId, albumName);
      }
    });
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  return { fetchAlbums, createAlbum, addToAlbum, deleteAlbum, renderAlbumSidebar };
})();

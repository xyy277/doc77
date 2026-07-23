// gallery-lightbox.js — Enhanced lightbox with EXIF info panel
// Replaces the simple lightbox in preview.js
// API: /api/exif/:projectId for metadata, /api/raw/:projectId for full image

window.GalleryLightbox = (function() {
  let state = {
    items: [],
    currentIndex: -1,
    projectId: null,
    visible: false,
  };

  /**
   * Open the lightbox at a specific media item.
   * @param {Object} item - The target media item
   * @param {Array} allItems - Full list of items for navigation
   * @param {number} projectId - Current project ID
   */
  function open(item, allItems, projectId) {
    state.items = allItems;
    state.currentIndex = allItems.findIndex(i => i.path === item.path);
    state.projectId = projectId;
    state.visible = true;
    render();
    document.addEventListener('keydown', onKeydown);
  }

  /**
   * Close the lightbox with fade-out transition.
   */
  function close() {
    state.visible = false;
    const lb = document.getElementById('galleryLightbox');
    if (lb) {
      lb.style.opacity = '0';
      setTimeout(() => {
        lb.remove();
        const imgEl = document.getElementById('lb-image');
        if (imgEl) imgEl.src = ''; // clear memory
      }, 300);
    }
    document.removeEventListener('keydown', onKeydown);
  }

  /**
   * Navigate to the next or previous item (wraps around).
   * @param {number} direction - -1 for prev, +1 for next
   */
  function nav(direction) {
    let newIdx = state.currentIndex + direction;
    if (newIdx < 0) newIdx = state.items.length - 1;
    if (newIdx >= state.items.length) newIdx = 0;
    state.currentIndex = newIdx;
    updateImage(direction);
    fetchExif();
  }

  /**
   * Update the displayed media element (image or video).
   * Applies a subtle slide+fade transition during navigation.
   * @param {number} direction - Direction offset for animation
   */
  function updateImage(direction) {
    direction = direction || 0;
    const item = state.items[state.currentIndex];
    const imgEl = document.getElementById('lb-image');

    // Fade/slide the current image out
    if (imgEl) {
      imgEl.style.opacity = '0.5';
      imgEl.style.transform = 'scale(0.98) translateX(' + (direction * 20) + 'px)';
    }

    setTimeout(function() {
      if (item.type === 'video') {
        if (imgEl) imgEl.style.display = 'none';
        var vid = document.getElementById('lb-video');
        if (!vid) {
          vid = document.createElement('video');
          vid.id = 'lb-video';
          vid.controls = true;
          vid.className = 'max-w-full max-h-full object-contain';
          document.getElementById('lightbox-content-area').appendChild(vid);
        }
        vid.src = item.raw_url || item.url;
        vid.style.display = '';
      } else {
        var vid = document.getElementById('lb-video');
        if (vid) vid.style.display = 'none';
        if (imgEl) {
          imgEl.style.display = '';
          imgEl.src = item.preview_url || item.raw_url || item.url;
        }
      }

      document.getElementById('lb-filename').textContent = item.name;
      var dateEl = document.getElementById('lb-date');
      if (item.exif_date) {
        dateEl.textContent = new Date(item.exif_date).toLocaleString();
      } else if (item.modified) {
        dateEl.textContent = item.modified;
      } else {
        dateEl.textContent = '';
      }

      // Fade/slide the new image in
      if (imgEl) {
        imgEl.style.opacity = '1';
        imgEl.style.transform = 'scale(1) translateX(0)';
      }
    }, 150);
  }

  /**
   * Fetch EXIF metadata for the current image from the API.
   */
  async function fetchExif() {
    var item = state.items[state.currentIndex];
    if (item.type !== 'image') return;
    try {
      var resp = await fetch('/api/exif/' + state.projectId + '?path=' + encodeURIComponent(item.path));
      var data = await resp.json();
      if (data) updateInfoPanel(data);
    } catch (_) {
      // silently ignore fetch errors
    }
  }

  /**
   * Populate the info sidebar with EXIF data.
   * DOM structure matches gallery_ui.html lines 416-484.
   * @param {Object} data - ExifData from the API
   */
  function updateInfoPanel(data) {
    var content = document.getElementById('lb-info-content');
    if (!content) return;

    // Helper: format file size from bytes
    function formatFileSize(bytes) {
      if (bytes == null) return '--';
      var units = ['B', 'KB', 'MB', 'GB'];
      var i = 0;
      var size = bytes;
      while (size >= 1024 && i < units.length - 1) { size = size / 1024; i++; }
      return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
    }

    // Helper: safely escape HTML in text values
    function esc(str) {
      if (str == null) return '--';
      var d = document.createElement('div');
      d.textContent = String(str);
      return d.innerHTML;
    }

    var resolution = '--';
    if (data.dimensions && data.dimensions.width && data.dimensions.height) {
      resolution = data.dimensions.width + ' x ' + data.dimensions.height;
    }

    var fileDate = '--';
    if (data.date) {
      fileDate = new Date(data.date).toLocaleDateString();
    }

    var gpsHtml = '';
    if (data.gps && data.gps.latitude != null && data.gps.longitude != null) {
      gpsHtml = '<span class="text-xs z-10">'
        + esc(data.gps.latitude.toFixed(6)) + ', ' + esc(data.gps.longitude.toFixed(6))
        + '</span>';
    } else {
      gpsHtml = '<span class="text-xs z-10">No GPS data</span>';
    }

    content.innerHTML =
      '<!-- File Info -->'
      + '<div class="space-y-3">'
      + '  <h4 class="text-xs uppercase tracking-wider text-doc77-500 font-semibold">File Info</h4>'
      + '  <div class="bg-doc77-950 rounded-lg p-3 space-y-2 text-sm border border-doc77-800/50">'
      + '    <div class="flex justify-between">'
      + '      <span class="text-doc77-400">Name</span>'
      + '      <span class="text-doc77-100 font-medium break-all text-right ml-4">' + esc(data.file_name || data.name || data.file_name) + '</span>'
      + '    </div>'
      + '    <div class="flex justify-between">'
      + '      <span class="text-doc77-400">Date</span>'
      + '      <span class="text-doc77-100">' + fileDate + '</span>'
      + '    </div>'
      + '    <div class="flex justify-between">'
      + '      <span class="text-doc77-400">Size</span>'
      + '      <span class="text-doc77-100">' + formatFileSize(data.file_size) + '</span>'
      + '    </div>'
      + '    <div class="flex justify-between">'
      + '      <span class="text-doc77-400">Resolution</span>'
      + '      <span class="text-doc77-100">' + resolution + '</span>'
      + '    </div>'
      + '  </div>'
      + '</div>'
      // Camera EXIF
      + '<div class="space-y-3">'
      + '  <h4 class="text-xs uppercase tracking-wider text-doc77-500 font-semibold">Camera EXIF</h4>'
      + '  <div class="bg-doc77-950 rounded-lg p-3 space-y-3 text-sm border border-doc77-800/50">'
      + '    <div class="flex items-center gap-3">'
      + '      <div class="w-8 h-8 rounded bg-doc77-800 flex items-center justify-center shrink-0">'
      + '        <i class="ph ph-camera text-doc77-300"></i>'
      + '      </div>'
      + '      <div>'
      + '        <div class="text-doc77-100 font-medium">' + esc(data.camera || '--') + '</div>'
      + '        <div class="text-xs text-doc77-400">' + esc(data.lens || '') + '</div>'
      + '      </div>'
      + '    </div>'
      + '    <div class="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-doc77-800/50 text-xs">'
      + '      <div class="bg-doc77-900 rounded p-1.5 text-center">'
      + '        <div class="text-doc77-500">ISO</div>'
      + '        <div class="text-doc77-200 font-medium mt-0.5">' + esc(data.iso) + '</div>'
      + '      </div>'
      + '      <div class="bg-doc77-900 rounded p-1.5 text-center">'
      + '        <div class="text-doc77-500">Aperture</div>'
      + '        <div class="text-doc77-200 font-medium mt-0.5">' + esc(data.aperture) + '</div>'
      + '      </div>'
      + '      <div class="bg-doc77-900 rounded p-1.5 text-center">'
      + '        <div class="text-doc77-500">Shutter</div>'
      + '        <div class="text-doc77-200 font-medium mt-0.5">' + esc(data.shutter_speed) + '</div>'
      + '      </div>'
      + '      <div class="bg-doc77-900 rounded p-1.5 text-center">'
      + '        <div class="text-doc77-500">Focal Length</div>'
      + '        <div class="text-doc77-200 font-medium mt-0.5">' + esc(data.focal_length) + '</div>'
      + '      </div>'
      + '    </div>'
      + '  </div>'
      + '</div>'
      // Location
      + '<div class="space-y-3">'
      + '  <h4 class="text-xs uppercase tracking-wider text-doc77-500 font-semibold">Location</h4>'
      + '  <div class="h-32 bg-doc77-950 rounded-lg border border-doc77-800/50 flex flex-col items-center justify-center text-doc77-500 relative overflow-hidden">'
      + '    <i class="ph ph-map-pin text-2xl mb-1 z-10"></i>'
      + '    ' + gpsHtml
      + '    <div class="absolute inset-0 opacity-10" style="background-image: radial-gradient(#334155 1px, transparent 1px); background-size: 10px 10px;"></div>'
      + '  </div>'
      + '</div>';
  }

  /**
   * Toggle the EXIF info sidebar visibility.
   */
  function toggleInfoPanel() {
    var panel = document.getElementById('lb-info-panel');
    if (panel) panel.classList.toggle('translate-x-full');
  }

  /**
   * Global keyboard event handler.
   * Escape: close | ArrowLeft: prev | ArrowRight: next | I: toggle info panel
   */
  function onKeydown(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') nav(1);
    else if (e.key === 'ArrowLeft') nav(-1);
    else if (e.key === 'i' || e.key === 'I') toggleInfoPanel();
  }

  /**
   * Build and inject the lightbox DOM into the document body.
   * DOM structure matches gallery_ui.html lines 360-486.
   */
  function render() {
    var overlay = document.createElement('div');
    overlay.id = 'galleryLightbox';
    overlay.className = 'fixed inset-0 z-50 bg-black/95 flex flex-col';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s';

    overlay.innerHTML =
      '<div class="flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent absolute top-0 left-0 right-0 z-10">'
      + '  <div class="flex items-center gap-3">'
      + '    <button class="text-white hover:text-doc77-300 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" onclick="GalleryLightbox.close()">'
      + '      <i class="ph ph-arrow-left text-xl"></i>'
      + '    </button>'
      + '    <div>'
      + '      <div class="text-white font-medium drop-shadow-md" id="lb-filename"></div>'
      + '      <div class="text-doc77-300 text-xs drop-shadow-md" id="lb-date"></div>'
      + '    </div>'
      + '  </div>'
      + '  <div class="flex items-center gap-2">'
      + '    <button class="text-white hover:text-doc77-300 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" title="Download">'
      + '      <i class="ph ph-download-simple text-xl"></i>'
      + '    </button>'
      + '    <button class="text-white hover:text-doc77-300 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" title="Info" onclick="GalleryLightbox.toggleInfoPanel()">'
      + '      <i class="ph ph-info text-xl"></i>'
      + '    </button>'
      + '  </div>'
      + '</div>'
      + '<div class="flex-1 flex items-center justify-center relative overflow-hidden" id="lightbox-content-area">'
      + '  <button class="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white p-3 bg-black/20 hover:bg-black/50 rounded-full backdrop-blur-sm transition-all z-10 hidden sm:flex" onclick="GalleryLightbox.nav(-1)">'
      + '    <i class="ph ph-caret-left text-3xl"></i>'
      + '  </button>'
      + '  <img src="" alt="" id="lb-image" class="max-w-full max-h-full object-contain select-none">'
      + '  <button class="absolute right-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white p-3 bg-black/20 hover:bg-black/50 rounded-full backdrop-blur-sm transition-all z-10 hidden sm:flex" onclick="GalleryLightbox.nav(1)">'
      + '    <i class="ph ph-caret-right text-3xl"></i>'
      + '  </button>'
      + '</div>'
      + '<div id="lb-info-panel" class="absolute top-0 right-0 bottom-0 w-80 bg-doc77-900 border-l border-doc77-800 transform translate-x-full transition-transform duration-300 overflow-y-auto no-scrollbar shadow-2xl flex flex-col z-20">'
      + '  <div class="p-4 border-b border-doc77-800 flex items-center justify-between sticky top-0 bg-doc77-900 z-10">'
      + '    <h3 class="font-semibold text-doc77-100 flex items-center gap-2"><i class="ph ph-info"></i> Details</h3>'
      + '    <button class="text-doc77-400 hover:text-white" onclick="GalleryLightbox.toggleInfoPanel()"><i class="ph ph-x"></i></button>'
      + '  </div>'
      + '  <div class="p-4 space-y-6" id="lb-info-content">'
      + '    <!-- Populated by updateInfoPanel() -->'
      + '  </div>'
      + '</div>';

    document.body.appendChild(overlay);

    // Trigger fade-in on next frame so the transition plays
    requestAnimationFrame(function() {
      overlay.style.opacity = '1';
    });

    updateImage(0);
    fetchExif();
  }

  return { open, close, nav, toggleInfoPanel };
})();

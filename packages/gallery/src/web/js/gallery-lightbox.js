// gallery-lightbox.js — Enhanced lightbox with EXIF info panel
// Replaces the simple lightbox in preview.js
// API: /api/exif/:projectId for metadata, /api/raw/:projectId for full image

window.GalleryLightbox = (function() {
  let state = {
    items: [],
    currentIndex: -1,
    projectId: null,
    visible: false,
    // Zoom
    zoomLevel: 1,
    panX: 0,
    panY: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    // Auto-play
    playing: false,
    playInterval: null,
    playSpeed: 4000,
    // Transition effect
    transitionEffect: (function(){ try { return localStorage.getItem('doc77-gallery-transition-effect') || 'dissolve'; } catch(e) { return 'dissolve'; } })(),
    // Particle canvas
    particleCanvas: null,
    particleCtx: null,
    particleAnimId: null,
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
    stopSlideshow();
    resetZoom();
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

  // ═══════════ Zoom System ═══════════
  function applyZoom() {
    var img = document.getElementById('lb-image');
    var navEl = document.getElementById('lb-thumb-nav');
    if (img) {
      img.style.transform = 'scale(' + state.zoomLevel + ') translate(' + state.panX + 'px, ' + state.panY + 'px)';
      img.style.cursor = state.zoomLevel > 1 ? (state.isDragging ? 'grabbing' : 'grab') : 'default';
    }
    if (navEl) {
      navEl.style.display = state.zoomLevel > 1 ? 'block' : 'none';
    }
    updateThumbNav();
  }

  function zoomIn() {
    state.zoomLevel = Math.min(5, state.zoomLevel + 0.5);
    applyZoom();
  }

  function zoomOut() {
    state.zoomLevel = Math.max(0.5, state.zoomLevel - 0.5);
    if (state.zoomLevel <= 1) { state.panX = 0; state.panY = 0; }
    applyZoom();
  }

  function resetZoom() {
    state.zoomLevel = 1;
    state.panX = 0; state.panY = 0;
    applyZoom();
  }

  function setupZoomEvents() {
    var area = document.getElementById('lightbox-content-area');
    if (!area) return;
    // Mouse wheel zoom
    area.addEventListener('wheel', function(e) {
      if (!state.visible) return;
      e.preventDefault();
      var delta = e.deltaY > 0 ? -0.25 : 0.25;
      state.zoomLevel = Math.max(0.5, Math.min(5, state.zoomLevel + delta));
      if (state.zoomLevel <= 1) { state.panX = 0; state.panY = 0; }
      applyZoom();
    }, { passive: false });
    // Drag to pan (when zoomed)
    area.addEventListener('pointerdown', function(e) {
      if (!state.visible || state.zoomLevel <= 1) return;
      state.isDragging = true;
      state.dragStartX = e.clientX - state.panX;
      state.dragStartY = e.clientY - state.panY;
      area.setPointerCapture(e.pointerId);
      applyZoom();
    });
    area.addEventListener('pointermove', function(e) {
      if (!state.isDragging) return;
      state.panX = e.clientX - state.dragStartX;
      state.panY = e.clientY - state.dragStartY;
      applyZoom();
    });
    area.addEventListener('pointerup', function() { state.isDragging = false; applyZoom(); });
  }

  // Thumbnail navigator
  function updateThumbNav() {
    var nav = document.getElementById('lb-thumb-nav');
    if (!nav || state.zoomLevel <= 1) return;
    var img = document.getElementById('lb-image');
    if (!img || !img.naturalWidth) return;
    var tnImg = nav.querySelector('.lb-thumb-img');
    var tnBox = nav.querySelector('.lb-thumb-box');
    if (tnImg && tnImg.src !== img.src) tnImg.src = img.src;
    // Viewport rect indicator
    var area = document.getElementById('lightbox-content-area');
    if (area && tnBox) {
      var aw = area.clientWidth, ah = area.clientHeight;
      var iw = img.naturalWidth * state.zoomLevel, ih = img.naturalHeight * state.zoomLevel;
      var vx = (-state.panX / iw) * 100, vy = (-state.panY / ih) * 100;
      var vw = (aw / iw) * 100, vh = (ah / ih) * 100;
      tnBox.style.left = Math.max(0, Math.min(100 - vw, vx)) + '%';
      tnBox.style.top = Math.max(0, Math.min(100 - vh, vy)) + '%';
      tnBox.style.width = Math.min(100, vw) + '%';
      tnBox.style.height = Math.min(100, vh) + '%';
    }
  }

  // ═══════════ Auto-Play / Slideshow ═══════════
  function toggleSlideshow() {
    if (state.playing) { stopSlideshow(); return; }
    startSlideshow();
  }

  function startSlideshow() {
    state.playing = true;
    var btn = document.getElementById('lb-slideshow-btn');
    if (btn) { btn.innerHTML = '<i class="ph ph-pause text-xl"></i>'; btn.title = 'Pause'; }
    // Hide prev/next arrows during slideshow
    var prev = document.querySelector('#galleryLightbox button[onclick*="nav(-1)"]');
    var next = document.querySelector('#galleryLightbox button[onclick*="nav(1)"]');
    if (prev) prev.style.display = 'none';
    if (next) next.style.display = 'none';
    scheduleNextSlide();
  }

  function stopSlideshow() {
    state.playing = false;
    if (state.playInterval) { clearTimeout(state.playInterval); state.playInterval = null; }
    var btn = document.getElementById('lb-slideshow-btn');
    if (btn) { btn.innerHTML = '<i class="ph ph-play text-xl"></i>'; btn.title = 'Auto-play'; }
    var prev = document.querySelector('#galleryLightbox button[onclick*="nav(-1)"]');
    var next = document.querySelector('#galleryLightbox button[onclick*="nav(1)"]');
    if (prev) prev.style.display = '';
    if (next) next.style.display = '';
  }

  function scheduleNextSlide() {
    if (!state.playing) return;
    state.playInterval = setTimeout(function() {
      if (!state.playing) return;
      doTransition(1);
      scheduleNextSlide();
    }, state.playSpeed);
  }

  function setPlaySpeed(speed) {
    state.playSpeed = speed;
    try { localStorage.setItem('doc77-gallery-play-speed', speed); } catch(e) {}
    if (state.playing) {
      if (state.playInterval) clearTimeout(state.playInterval);
      scheduleNextSlide();
    }
  }

  // ═══════════ Transition Effects ═══════════
  function doTransition(direction) {
    switch (state.transitionEffect) {
      case 'dissolve': particleTransition(direction); break;
      case 'fade': fadeTransition(direction); break;
      case 'slide': slideTransition(direction); break;
      default: simpleTransition(direction); break;
    }
  }

  function simpleTransition(direction) {
    resetZoom();
    nav(direction);
  }

  function fadeTransition(direction) {
    resetZoom();
    var img = document.getElementById('lb-image');
    if (img) { img.style.opacity = '0'; img.style.transition = 'opacity 0.3s'; }
    setTimeout(function() {
      nav(direction);
      if (img) { img.style.opacity = '1'; setTimeout(function() { img.style.transition = ''; }, 350); }
    }, 300);
  }

  function slideTransition(direction) {
    resetZoom();
    var img = document.getElementById('lb-image');
    if (img) { img.style.transform = 'translateX(' + (direction * 60) + 'px)'; img.style.opacity = '0'; img.style.transition = 'transform 0.3s, opacity 0.3s'; }
    setTimeout(function() {
      nav(direction);
      if (img) { img.style.transform = 'translateX(' + (-direction * 20) + 'px)'; img.style.opacity = '0.7'; }
      requestAnimationFrame(function() {
        if (img) { img.style.transform = 'translateX(0)'; img.style.opacity = '1'; setTimeout(function() { img.style.transition = ''; }, 350); }
      });
    }, 300);
  }

  function particleTransition(direction) {
    resetZoom();
    var img = document.getElementById('lb-image');
    var area = document.getElementById('lightbox-content-area');
    if (!img || !area) { simpleTransition(direction); return; }

    // Create canvas overlay
    var canvas = document.createElement('canvas');
    canvas.id = 'lb-particle-canvas';
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;pointer-events:none';
    var rect = area.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    area.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    // Determine particle grid density
    var gridSize = Math.max(4, Math.floor(Math.min(rect.width, rect.height) / 80));
    var particles = [];
    // Sample current image into particles
    var iw = img.naturalWidth, ih = img.naturalHeight;
    if (iw && ih) {
      // Draw image to an offscreen canvas to sample pixels
      var offCanvas = document.createElement('canvas');
      offCanvas.width = Math.min(iw, rect.width);
      offCanvas.height = Math.min(ih, rect.height);
      var offCtx = offCanvas.getContext('2d');
      // Draw the displayed image region
      try {
        offCtx.drawImage(img, 0, 0, offCanvas.width, offCanvas.height);
        for (var y = 0; y < offCanvas.height; y += gridSize) {
          for (var x = 0; x < offCanvas.width; x += gridSize) {
            var pixel = offCtx.getImageData(x, y, 1, 1).data;
            if (pixel[3] < 10) continue; // skip transparent
            particles.push({
              sx: x, sy: y,
              x: x, y: y,
              color: 'rgb(' + pixel[0] + ',' + pixel[1] + ',' + pixel[2] + ')',
              size: gridSize,
              vx: (Math.random() - 0.5) * 8,
              vy: (Math.random() - 0.5) * 8 - 3,
              life: 1
            });
          }
        }
      } catch(e) { /* fall through to simple transition */ }
    }

    if (particles.length === 0) {
      canvas.remove();
      simpleTransition(direction);
      return;
    }

    // Phase 1: Dissolve (particles fly apart)
    var startTime = performance.now();
    var dissolveDuration = 500;

    function animateDissolve(time) {
      var elapsed = time - startTime;
      var progress = Math.min(1, elapsed / dissolveDuration);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        var alpha = 1 - progress;
        p.x = p.sx + p.vx * progress * 60;
        p.y = p.sy + p.vy * progress * 60;
        p.size = gridSize * (1 - progress * 0.7);
        ctx.fillStyle = p.color.replace(')', ', ' + alpha + ')').replace('rgb', 'rgba');
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, Math.max(1, p.size), Math.max(1, p.size));
      }

      if (progress < 1) {
        state.particleAnimId = requestAnimationFrame(animateDissolve);
      } else {
        // Phase 2: Switch image + rebuild
        nav(direction);
        // Reset particles for rebuild
        for (var j = 0; j < particles.length; j++) {
          var q = particles[j];
          var angle = Math.random() * Math.PI * 2;
          var dist = 60 + Math.random() * 200;
          q.sx = q.x; q.sy = q.y; // current position becomes start
          q.tx = (canvas.width / 2) + Math.cos(angle) * dist;
          q.ty = (canvas.height / 2) + Math.sin(angle) * dist;
          q.vx = (q.x - q.tx) / 10;
          q.vy = (q.y - q.ty) / 10;
          q.life = 1;
        }
        startTime = performance.now();
        state.particleAnimId = requestAnimationFrame(animateRebuild);
      }
    }

    function animateRebuild(time) {
      var elapsed = time - startTime;
      var progress = Math.min(1, elapsed / dissolveDuration);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        var alpha = progress;
        p.x = p.sx + (p.tx - p.sx) * progress;
        p.y = p.sy + (p.ty - p.sy) * progress;
        p.size = gridSize * (0.3 + progress * 0.7);
        ctx.fillStyle = p.color.replace(')', ', ' + alpha + ')').replace('rgb', 'rgba');
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, Math.max(1, p.size), Math.max(1, p.size));
      }

      if (progress < 1) {
        state.particleAnimId = requestAnimationFrame(animateRebuild);
      } else {
        canvas.remove();
        state.particleAnimId = null;
      }
    }

    state.particleAnimId = requestAnimationFrame(animateDissolve);
  }

  function setTransitionEffect(effect) {
    state.transitionEffect = effect;
    try { localStorage.setItem('doc77-gallery-transition-effect', effect); } catch(e) {}
  }

  /**
   * Global keyboard event handler.
   * Escape: close | ArrowLeft: prev | ArrowRight: next | I: toggle info panel
   */
  function onKeydown(e) {
    if (e.key === 'Escape') { stopSlideshow(); close(); }
    else if (e.key === 'ArrowRight') nav(1);
    else if (e.key === 'ArrowLeft') nav(-1);
    else if (e.key === 'i' || e.key === 'I') toggleInfoPanel();
    else if (e.key === '+' || e.key === '=') zoomIn();
    else if (e.key === '-') zoomOut();
    else if (e.key === '0') resetZoom();
    else if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggleSlideshow(); }
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
      + '    <button class="text-white hover:text-blue-400 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" title="Zoom Out" onclick="GalleryLightbox.zoomOut()">'
      + '      <i class="ph ph-magnifying-glass-minus text-xl"></i>'
      + '    </button>'
      + '    <button class="text-white hover:text-blue-400 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" title="Zoom In" onclick="GalleryLightbox.zoomIn()">'
      + '      <i class="ph ph-magnifying-glass-plus text-xl"></i>'
      + '    </button>'
      + '    <button class="text-white hover:text-blue-400 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" title="Reset Zoom" onclick="GalleryLightbox.resetZoom()">'
      + '      <i class="ph ph-arrows-clockwise text-xl"></i>'
      + '    </button>'
      + '    <div class="w-px h-5 bg-white/20 mx-1"></div>'
      + '    <button class="text-white hover:text-blue-400 p-2 bg-black/20 hover:bg-black/40 rounded-full backdrop-blur-sm transition-all" title="Auto-play" id="lb-slideshow-btn" onclick="GalleryLightbox.toggleSlideshow()">'
      + '      <i class="ph ph-play text-xl"></i>'
      + '    </button>'
      + '    <select id="lb-speed-select" class="bg-black/30 text-white/80 text-xs rounded px-2 py-1 border border-white/20 focus:outline-none" onchange="GalleryLightbox.setPlaySpeed(parseInt(this.value))" title="Speed">'
      + '      <option value="2000">2s</option><option value="4000" selected>4s</option><option value="6000">6s</option><option value="10000">10s</option>'
      + '    </select>'
      + '    <select id="lb-effect-select" class="bg-black/30 text-white/80 text-xs rounded px-2 py-1 border border-white/20 focus:outline-none" onchange="GalleryLightbox.setTransitionEffect(this.value)" title="Transition">'
      + '      <option value="dissolve">Particles</option><option value="fade">Fade</option><option value="slide">Slide</option><option value="none">None</option>'
      + '    </select>'
      + '    <div class="w-px h-5 bg-white/20 mx-1"></div>'
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
      + '  <img src="" alt="" id="lb-image" class="max-w-full max-h-full object-contain select-none" style="transition:transform 0.15s">'
      + '  <div id="lb-thumb-nav" class="lb-thumb-nav" style="display:none"><img class="lb-thumb-img" src="" alt=""><div class="lb-thumb-box"></div></div>'
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

    // Init zoom events on the content area
    setupZoomEvents();

    // Set saved play speed and effect
    var speedSel = document.getElementById('lb-speed-select');
    var effectSel = document.getElementById('lb-effect-select');
    if (speedSel) { try { var ss = localStorage.getItem('doc77-gallery-play-speed'); if (ss) speedSel.value = ss; state.playSpeed = parseInt(ss); } catch(e) {} }
    if (effectSel) { effectSel.value = state.transitionEffect; }

    // Trigger fade-in on next frame so the transition plays
    requestAnimationFrame(function() {
      overlay.style.opacity = '1';
    });

    updateImage(0);
    fetchExif();
  }

  return { open, close, nav, toggleInfoPanel, zoomIn, zoomOut, resetZoom, toggleSlideshow, setPlaySpeed, setTransitionEffect };
})();

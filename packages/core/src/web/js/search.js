/**
 * Doc77 Global Search — Ctrl+K Spotlight-style search modal.
 * Uses FTS5 full-text search API.
 */
(function () {
  'use strict';

  var overlay = null;
  var input = null;
  var resultsEl = null;
  var debounceTimer = null;
  var selectedIndex = -1;
  var currentResults = [];

  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'fts-overlay';
    overlay.className = 'fts-overlay';
    overlay.innerHTML =
      '<div class="fts-modal">' +
        '<div class="fts-input-row">' +
          '<span class="fts-search-icon">🔍</span>' +
          '<input type="text" class="fts-input" placeholder="Search documents... (Ctrl+K)" autocomplete="off" spellcheck="false">' +
          '<kbd class="fts-esc">esc</kbd>' +
        '</div>' +
        '<div class="fts-results" id="ftsResults"></div>' +
        '<div class="fts-footer">' +
          '<span class="fts-hint">↑↓ Navigate</span>' +
          '<span class="fts-hint">Enter Open</span>' +
          '<span class="fts-stats" id="ftsStats"></span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    input = overlay.querySelector('.fts-input');
    resultsEl = overlay.querySelector('.fts-results');

    // Events
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeSearch();
    });
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(doSearch, 300);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeSearch(); e.preventDefault(); }
      if (e.key === 'ArrowDown') { moveSelection(1); e.preventDefault(); }
      if (e.key === 'ArrowUp') { moveSelection(-1); e.preventDefault(); }
      if (e.key === 'Enter') { openSelected(); e.preventDefault(); }
    });
  }

  function openSearch() {
    createOverlay();
    overlay.classList.add('visible');
    input.value = '';
    resultsEl.innerHTML = '<div class="fts-empty">Type to search across all projects</div>';
    selectedIndex = -1;
    currentResults = [];
    document.getElementById('ftsStats').textContent = '';
    setTimeout(function () { input.focus(); }, 50);
  }

  function closeSearch() {
    if (overlay) overlay.classList.remove('visible');
  }

  function doSearch() {
    var q = input.value.trim();
    if (!q) {
      resultsEl.innerHTML = '<div class="fts-empty">Type to search across all projects</div>';
      currentResults = [];
      return;
    }

    resultsEl.innerHTML = '<div class="fts-loading">Searching...</div>';

    fetch('/api/fts?q=' + encodeURIComponent(q) + '&limit=10')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderResults(data);
      })
      .catch(function () {
        resultsEl.innerHTML = '<div class="fts-empty">Search failed. Is the index built?</div>';
      });
  }

  function renderResults(data) {
    currentResults = [];
    var html = '';

    if (!data.groups || data.groups.length === 0) {
      html = '<div class="fts-empty">No results found for "' + escH(input.value) + '"</div>';
      resultsEl.innerHTML = html;
      document.getElementById('ftsStats').textContent = '';
      return;
    }

    var totalAll = 0;
    data.groups.forEach(function (group) {
      totalAll += group.total;
      html += '<div class="fts-group">';
      html += '<div class="fts-group-title">📁 ' + escH(group.project_name) + ' <span class="fts-count">' + group.total + '</span></div>';
      group.results.forEach(function (r) {
        var idx = currentResults.length;
        currentResults.push({ project_id: group.project_id, file_path: r.file_path });
        html += '<div class="fts-item" data-idx="' + idx + '" onclick="window.__ftsOpen(' + idx + ')">';
        html += '<div class="fts-item-title">📄 ' + escH(r.title) + '</div>';
        html += '<div class="fts-item-path">' + escH(r.file_path) + '</div>';
        if (r.snippets && r.snippets.length > 0) {
          html += '<div class="fts-item-snippet">' + r.snippets[0] + '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    });

    resultsEl.innerHTML = html;
    document.getElementById('ftsStats').textContent = totalAll + ' results';
  }

  function moveSelection(dir) {
    var items = resultsEl.querySelectorAll('.fts-item');
    if (!items.length) return;
    if (selectedIndex >= 0 && items[selectedIndex]) items[selectedIndex].classList.remove('selected');
    selectedIndex += dir;
    if (selectedIndex < 0) selectedIndex = items.length - 1;
    if (selectedIndex >= items.length) selectedIndex = 0;
    items[selectedIndex].classList.add('selected');
    items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }

  function openSelected() {
    if (selectedIndex >= 0 && currentResults[selectedIndex]) {
      openFile(currentResults[selectedIndex]);
    }
  }

  window.__ftsOpen = function (idx) {
    if (currentResults[idx]) openFile(currentResults[idx]);
  };

  function openFile(item) {
    closeSearch();
    // Navigate to preview page with project and file
    window.location.href = '/preview.html?id=' + item.project_id + '&path=' + encodeURIComponent(item.file_path);
  }

  function escH(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Global keyboard shortcut: Ctrl+K / Cmd+K
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (overlay && overlay.classList.contains('visible')) {
        closeSearch();
      } else {
        openSearch();
      }
    }
  });

  // Expose for external use
  window.__doc77_openSearch = openSearch;
})();

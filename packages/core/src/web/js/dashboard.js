/**
 * Doc77 Dashboard JS — greeting + project grid + search/sort + view toggle + recent browsing
 */
var projects = [];
var sortBy = 'last_opened';
var filterText = '';
var currentViewMode = localStorage.getItem('doc77-view-mode') || 'grid';

// ═══ Init ═══
async function load() {
  // Greeting
  updateGreeting();

  // Load projects
  try {
    var r = await fetch('/api/projects');
    projects = await r.json();
    document.getElementById('projCount').textContent = projects.length;
    syncHeaderCounts();
    applyViewMode();
    filterAndSort();
    window.renderFavorites(projects);
    window.renderStats();
    window.renderRecent();
  } catch(e) {
    document.getElementById('projGrid').innerHTML =
      '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">' + t('web.dashboard.loadFailed') + '</div></div>';
  }
}

// ═══ Greeting ═══
function updateGreeting() {
  var now = new Date();
  var hour = now.getHours();
  var greeting;
  if (hour < 6) greeting = t('web.dashboard.greeting.lateNight');
  else if (hour < 12) greeting = t('web.dashboard.greeting.morning');
  else if (hour < 14) greeting = t('web.dashboard.greeting.noon');
  else if (hour < 18) greeting = t('web.dashboard.greeting.afternoon');
  else greeting = t('web.dashboard.greeting.evening');
  var timeStr = String(hour).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  document.getElementById('greeting').innerHTML = t('web.dashboard.greeting.withTime', { greeting: greeting, time: timeStr });
}

// ═══ View Mode ═══
window.setViewMode = function(mode) {
  currentViewMode = mode;
  localStorage.setItem('doc77-view-mode', mode);
  applyViewMode();
};

function applyViewMode() {
  var grid = document.getElementById('projGrid');
  var btnGrid = document.getElementById('btnViewGrid');
  var btnList = document.getElementById('btnViewList');

  if (currentViewMode === 'list') {
    grid.classList.add('list-view');
    btnGrid.classList.remove('active');
    btnList.classList.add('active');
  } else {
    grid.classList.remove('list-view');
    btnGrid.classList.add('active');
    btnList.classList.remove('active');
  }
}

// ═══ Filter & Sort ═══
window.filterAndSort = function() {
  var lang = window.__doc77_lang || 'zh-CN';
  var q = filterText.toLowerCase();
  var filtered = projects.filter(function(p) {
    return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.path.toLowerCase().indexOf(q) >= 0;
  });

  filtered.sort(function(a, b) {
    if (sortBy === 'name') return a.name.localeCompare(b.name, lang);
    if (sortBy === 'created') return new Date(b.created_at) - new Date(a.created_at);
    // last_opened (default)
    if (!a.last_opened && !b.last_opened) return a.name.localeCompare(b.name, lang);
    if (!a.last_opened) return 1;
    if (!b.last_opened) return -1;
    return new Date(b.last_opened) - new Date(a.last_opened);
  });

  window.renderGrid(filtered);
};

window.onFilterInput = function(val) {
  filterText = val;
  window.filterAndSort();
};

window.onSortChange = function(val) {
  sortBy = val;
  window.filterAndSort();
};

// ═══ Render Project Grid ═══
window.renderGrid = function(items) {
  var grid = document.getElementById('projGrid');

  if (!items.length) {
    grid.innerHTML = filterText
      ? '<div class="empty-state"><div class="empty-text">' + t('web.dashboard.filterNoMatch', { filter: esc(filterText) }) + '</div></div>'
      : '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">' + t('web.dashboard.projectsEmpty') + '</div><div class="empty-hint">' + t('web.dashboard.projectsEmptyHint') + '</div></div>';
    return;
  }

  grid.innerHTML = items.map(function(p) {
    return renderCompactCard(p, false);
  }).join('');
};

// ═══ Path truncation helper ═══
function shortPath(fullPath) {
  var parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 3) return fullPath;
  return '…/' + parts.slice(-3).join('/');
}

// ═══ Shared: Render a compact card (used by dashboard.js and favorites.js) ═══
var TAG_ICONS = {
  nodejs: '🟢',
  typescript: '🔷',
  python: '🐍',
  go: '🔵',
  rust: '🦀',
  java: '☕',
  dotnet: '💠',
  git: '📦',
};
var TAG_LABELS = {
  nodejs: 'Node',
  typescript: 'TS',
  python: 'Py',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  dotnet: '.NET',
  git: 'Git',
};

function renderCompactCard(p, inFavorites) {
  var lang = window.__doc77_lang || 'zh-CN';
  var starClass = p.favorited ? 'fav-star favorited' : 'fav-star';
  var starIcon = p.favorited ? '★' : '☆';
  var dateLabel = sortBy === 'last_opened' && p.last_opened
    ? t('web.dashboard.dateRecent') + ' ' + new Date(p.last_opened).toLocaleDateString(lang, {month:'short',day:'numeric'})
    : t('web.dashboard.dateCreated') + ' ' + new Date(p.created_at).toLocaleDateString(lang, {month:'short',day:'numeric'});
  var obsidianIcon = p.obsidian_mode ? '🗃️' : '📂';
  var obsidianBadge = p.obsidian_mode ? ' <span class="badge-obsidian">[[=]]</span>' : '';

  // Build tag badges
  var tags = Array.isArray(p.tags) ? p.tags.slice() : [];
  var tagsHtml = '';
  if (tags.length > 0) {
    var visible = tags.slice(0, 3);
    var extra = tags.length - 3;
    tagsHtml = '<div class="card-tags">' +
      visible.map(function(tag) {
        var icon = TAG_ICONS[tag] || '';
        var label = TAG_LABELS[tag] || tag;
        return '<span class="tag-badge tag-' + tag + '">' + icon + ' ' + label + '</span>';
      }).join('') +
      (extra > 0 ? '<span class="tag-badge tag-more">+' + extra + '</span>' : '') +
      '</div>';
  }

  return '<div class="card card-compact animate-in" data-id="' + p.id + '" onclick="openProject(' + p.id + ')">' +
    '<button class="' + starClass + '" data-id="' + p.id + '" onclick="event.stopPropagation();toggleFavorite(' + p.id + ')">' + starIcon + '</button>' +
    '<div class="card-icon">' + obsidianIcon + '</div>' +
    '<div class="card-body">' +
      '<div class="card-name">' + esc(p.name) + obsidianBadge + '</div>' +
      '<div class="card-path" title="' + escAttr(p.path) + '">' + esc(shortPath(p.path)) + '</div>' +
      '<div class="card-date">' + dateLabel + '</div>' +
      tagsHtml +
    '</div>' +
    '<div class="card-actions">' +
      '<button class="btn-icon" onclick="event.stopPropagation();startEdit(' + p.id + ')" title="' + t('web.dashboard.edit') + '">✏️</button>' +
      '<button class="btn-icon" onclick="event.stopPropagation();doDelete(' + p.id + ')" title="' + t('web.dashboard.delete') + '">🗑</button>' +
    '</div>' +
    // Inline edit form (hidden by default)
    '<div class="edit-form hidden" id="editForm-' + p.id + '" onclick="event.stopPropagation()">' +
      '<input id="editName-' + p.id + '" value="' + escAttr(p.name) + '" placeholder="' + t('web.dashboard.projectName') + '" class="input" style="width:100%;margin-bottom:8px">' +
      '<div class="form-row" style="margin-bottom:8px">' +
        '<input id="editPath-' + p.id + '" value="' + escAttr(p.path) + '" placeholder="' + t('web.dashboard.projectPath') + '" class="input">' +
        '<button onclick="openDirDialog(' + p.id + ')" class="btn">📂</button>' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:8px">' +
        '<input type="checkbox" id="editObsidian-' + p.id + '" ' + (p.obsidian_mode ? 'checked' : '') + '>' +
        ' Obsidian vault</label>' +
      '<div style="display:flex;gap:8px">' +
        '<button onclick="doUpdate(' + p.id + ')" class="btn btn-primary" style="font-size:12px">💾 ' + t('web.dashboard.save') + '</button>' +
        '<button onclick="cancelEdit(' + p.id + ')" class="btn" style="font-size:12px">✕ ' + t('common.confirm.cancel') + '</button>' +
      '</div>' +
      '<div id="editError-' + p.id + '" style="color:var(--danger);font-size:12px;display:none;margin-top:6px"></div>' +
    '</div>' +
  '</div>';
}

// ═══ Project navigation ═══
window.openProject = function(id) {
  // Touch project (update last_opened) — use sendBeacon to ensure delivery before navigation
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/projects/' + id + '/touch');
  } else {
    fetch('/api/projects/' + id + '/touch', { method: 'POST', keepalive: true }).catch(function() {});
  }
  location.href = '/preview.html?id=' + id;
};

// ═══ Recent browsing ═══
window.renderRecent = async function() {
  var panel = document.getElementById('recentContent');
  try {
    // Recent projects (from last_opened)
    var recentProjects = projects
      .filter(function(p) { return p.last_opened; })
      .sort(function(a, b) { return new Date(b.last_opened) - new Date(a.last_opened); })
      .slice(0, 3);

    // Recent files (from API)
    var rf = await fetch('/api/recent-files?limit=3');
    var recentFiles = await rf.json();

    // Sync header recent count
    var hrc = document.getElementById('headerRecentCount');
    if (hrc) hrc.textContent = recentFiles.filter(function(f) { return f.viewedAt; }).length;

    if (!recentProjects.length && !recentFiles.length) {
      panel.innerHTML = '<span class="recent-strip-empty">' + t('web.dashboard.recentEmpty') + '</span>';
      return;
    }

    var parts = [];

    // Project pills — each pill is a direct flex child
    if (recentProjects.length) {
      recentProjects.forEach(function(p) {
        parts.push('<a href="/preview.html?id=' + p.id + '" class="recent-pill" title="' + escAttr(p.name) + '" onclick="fetch(\'/api/projects/' + p.id + '/touch\',{method:\'POST\'})">📂 ' + esc(p.name) + '</a>');
      });
    }

    // File links
    if (recentFiles.length) {
      // Separator between projects and files
      if (parts.length) parts.push('<span class="recent-strip-sep"></span>');

      recentFiles.forEach(function(f) {
        var href = '/preview.html?id=' + f.projectId + '&path=' + encodeURIComponent(f.filePath);
        var label = esc(f.fileName) + ' · ' + esc(f.projectName) + ' · ' + relativeTime(f.viewedAt);
        parts.push('<a href="' + href + '" class="recent-file-link" title="' + escAttr(f.projectName + ' / ' + f.fileName) + '">📄 ' + label + '</a>');
      });
    }

    panel.innerHTML = parts.join('');
  } catch(e) {
    panel.innerHTML = '<span class="recent-strip-empty">' + t('web.dashboard.loadFailed') + '</span>';
  }
};

function relativeTime(epochMs) {
  if (!epochMs || isNaN(epochMs)) return '';
  var diff = Math.floor((Date.now() - epochMs) / 1000);
  if (diff < 0) return '';
  if (diff < 60) return t('web.dashboard.time.justNow');
  if (diff < 3600) return t('web.dashboard.time.minutesAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('web.dashboard.time.hoursAgo', { n: Math.floor(diff / 3600) });
  return t('web.dashboard.time.daysAgo', { n: Math.floor(diff / 86400) });
}

// ═══ Edit / Delete / Register ═══
window.startEdit = function(id) {
  document.querySelectorAll('.edit-form').forEach(function(f) { f.classList.add('hidden'); });
  var form = document.getElementById('editForm-' + id);
  if (form) form.classList.remove('hidden');
};

window.cancelEdit = function(id) {
  var form = document.getElementById('editForm-' + id);
  if (form) form.classList.add('hidden');
};

window.doUpdate = async function(id) {
  var name = document.getElementById('editName-' + id).value.trim();
  var pth = document.getElementById('editPath-' + id).value.trim();
  var obsidianEl = document.getElementById('editObsidian-' + id);
  var newObsidian = obsidianEl ? obsidianEl.checked : undefined;
  var errEl = document.getElementById('editError-' + id);
  var btn = document.querySelector('#editForm-' + id + ' .btn-primary');
  errEl.style.display = 'none';
  if (!name && !pth) { errEl.textContent = t('web.dashboard.nameOrPathRequired'); errEl.style.display = 'block'; return; }
  if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }
  var body = {};
  if (name) body.name = name;
  if (pth) body.path = pth;
  if (newObsidian !== undefined) body.obsidian_mode = newObsidian;
  try {
    var r = await fetch('/api/projects/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { var d = await r.json(); errEl.textContent = d.error || t('web.dashboard.updateFailed'); errEl.style.display = 'block'; return; }
    toast(t('web.dashboard.projectUpdated'), 'success');
    load();
  } catch(e) {
    errEl.textContent = t('web.dashboard.networkError') + ': ' + e.message; errEl.style.display = 'block';
  } finally {
    if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
  }
};

window.doDelete = async function(id) {
  if (!await confirmDialog(t('web.dashboard.confirmDelete'))) return;
  await fetch('/api/projects/' + id, { method: 'DELETE' });
  load();
};

window.doRegister = async function() {
  var name = document.getElementById('regName').value.trim();
  var pth = document.getElementById('regPath').value.trim();
  var err = document.getElementById('regError');
  var btn = document.querySelector('#tab-manual .btn-primary');
  err.style.display = 'none';
  if (!name || !pth) { err.textContent = t('web.dashboard.nameAndPathRequired'); err.style.display = 'block'; return; }
  if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }
  try {
    var isObsidian = document.getElementById('regObsidian').checked;
    var r = await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:name, path:pth, obsidian_mode:isObsidian}) });
    if (!r.ok) { var d = await r.json(); err.textContent = d.error || t('web.dashboard.registerFailed'); err.style.display = 'block'; return; }
    document.getElementById('regName').value = '';
    document.getElementById('regPath').value = '';
    closeRegisterModal();
    load();
  } catch(e) {
    err.textContent = t('web.dashboard.networkError') + ': ' + e.message; err.style.display = 'block';
  } finally {
    if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
  }
};

// ═══ Folder Picker — local/remote dual-mode ═══
function isLocalMode() {
  var host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

var _dirPickTarget = null;

window.openDirDialog = async function(forEditId) {
  var btn = event.target;
  var origHTML = btn.innerHTML;
  btn.innerHTML = '⏳';
  btn.disabled = true;
  _dirPickTarget = forEditId;

  // Strategy 1: Electron native dialog (returns real absolute path)
  if (window.doc77 && window.doc77.openNativeDialog) {
    try {
      var nativePath = await window.doc77.openNativeDialog();
      if (nativePath) {
        fillPath(forEditId, nativePath);
        btn.innerHTML = origHTML; btn.disabled = false;
        return;
      }
    } catch(e) { /* user cancelled or error — fall through */ }
  }

  // Strategy 2: Server-side file browser (always available)
  showServerFileBrowser(forEditId);
  btn.innerHTML = origHTML;
  btn.disabled = false;
};

// ═══ Server-side file browser modal ═══

function showServerFileBrowser(forEditId) {
  navigateFsBrowser(forEditId, '');
}

window.navigateFsBrowser = function(forEditId, dirPath) {
  var overlayId = 'fsBrowserOverlay';
  var existing = document.getElementById(overlayId);
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.className = 'confirm-overlay';
  overlay.style.zIndex = '102';
  overlay.innerHTML = '<div class="confirm-box" style="max-width:600px;max-height:80vh;display:flex;flex-direction:column" id="fsBrowserBox"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0"><span style="font-weight:600;font-size:13px">' + t('web.dashboard.fsBrowserTitle') + '</span><button onclick="document.getElementById(\'fsBrowserOverlay\').remove()" class="btn-icon" style="font-size:18px">✕</button></div><div id="fsBrowserContent" style="font-size:11px;color:var(--text-muted)">' + t('web.dashboard.loading') + '</div></div>';
  document.body.appendChild(overlay);

  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  // Fetch directory listing
  var url = '/api/browse-fs' + (dirPath ? '?path=' + encodeURIComponent(dirPath) : '');
  fetch(url).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) {
      document.getElementById('fsBrowserContent').innerHTML = '<p style="color:var(--danger)">❌ ' + esc(d.error) + '</p>';
      return;
    }
    renderFsBrowser(forEditId, d);
  }).catch(function() {
    document.getElementById('fsBrowserContent').innerHTML = '<p style="color:var(--danger)">' + t('web.dashboard.loadFailed') + '</p>';
  });
};

function renderFsBrowser(forEditId, data) {
  var html = '';

  // Breadcrumb + back
  html += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:8px;flex-wrap:wrap;font-size:12px">';
  if (data.parent) {
    html += '<button onclick="navigateFsBrowser(' + forEditId + ',\'' + escAttr(data.parent) + '\')" style="padding:2px 8px;background:var(--bg-hover);border:1px solid var(--border-light);border-radius:4px;cursor:pointer;font-size:11px;color:var(--text-primary)">⬆ ' + t('web.dashboard.fsParentDir') + '</button>';
  }
  // Root shortcuts
  if (data.roots && data.roots.length > 0) {
    for (var ri = 0; ri < data.roots.length; ri++) {
      var root = data.roots[ri];
      html += '<button onclick="navigateFsBrowser(' + forEditId + ',\'' + escAttr(root) + '\')" style="padding:2px 8px;border:1px solid var(--accent);border-radius:4px;cursor:pointer;font-size:10px;color:var(--accent);background:var(--accent-light-bg)">' + esc(root) + '</button>';
    }
  }
  html += '</div>';

  // Current path
  html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:10px;color:var(--text-muted)">' + t('web.dashboard.fsCurrentDir') + ':</span><span style="font-size:12px;font-family:monospace;color:var(--text-secondary);background:var(--bg-hover);padding:2px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(data.path) + '</span></div>';

  // "Select this directory" button
  html += '<button onclick="fillPath(' + forEditId + ',\'' + escAttr(data.path) + '\');document.getElementById(\'fsBrowserOverlay\').remove();' +
    'toast(\'' + t('web.dashboard.pathSelected') + ': ' + escAttr(data.path) + '\',\'success\')" style="width:100%;padding:8px 0;margin-bottom:8px;background:#059669;color:#fff;font-size:13px;border:none;border-radius:6px;cursor:pointer;font-weight:500">✅ ' + t('web.dashboard.fsSelectDir') + '</button>';

  // Directory listing
  if (data.entries.length === 0) {
    html += '<p style="font-size:12px;color:var(--text-muted);padding:16px 0;text-align:center">' + t('web.dashboard.fsEmptyDir') + '</p>';
  } else {
    html += '<div style="overflow-y:auto;flex:1;max-height:300px"><div style="display:flex;flex-direction:column;gap:2px">';
    for (var i = 0; i < data.entries.length; i++) {
      var e = data.entries[i];
      if (e.type === 'directory') {
        html += '<button onclick="navigateFsBrowser(' + forEditId + ',\'' + escAttr(data.path + '/' + e.name) + '\')" style="width:100%;text-align:left;padding:6px 12px;font-size:13px;border:none;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:8px;color:var(--text-primary);background:transparent" onmouseover="this.style.background=\'var(--accent-light-bg)\'" onmouseout="this.style.background=\'transparent\'"><span>📁</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.name) + '</span></button>';
      }
    }
    html += '</div></div>';
  }

  document.getElementById('fsBrowserContent').innerHTML = html;
}

window.fillPath = function(forEditId, path) {
  var targetId = forEditId ? 'editPath-' + forEditId : 'regPath';
  var input = document.getElementById(targetId);
  if (input) input.value = path;
};

// ═══ Sync header counts ═══
function syncHeaderCounts() {
  var hpc = document.getElementById('headerProjCount');
  if (hpc) hpc.textContent = projects.length;
}

// ═══ Mobile Companion QR Code ═══
window.initMobileQR = async function () {
  try {
    var r = await fetch('/api/server-info');
    var info = await r.json();
    if (info.bindAddress === '0.0.0.0' || info.isLocal) {
      var el = document.getElementById('mobileCompanion');
      if (el) el.style.display = 'block';
    }
    var hostname = window.location.hostname || '127.0.0.1';
    var url = 'http://' + hostname + ':' + (info.port || 27777) + '/mobile/';
    document.getElementById('mobileUrlDisplay').textContent = url;
    renderQR(url);
  } catch (e) {}
};

function renderQR(url) {
  var container = document.getElementById('mobileQrCode');
  if (!container) return;
  // Use external API as fallback since QRCode lib isn't loaded client-side
  container.innerHTML =
    '<img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=' +
    encodeURIComponent(url) +
    '" alt="QR" style="width:100px;height:100px;border-radius:4px" onerror="this.innerHTML=\'' +
    url.replace(/^https?:\/\//, '') +
    '" style="font-size:10px;color:var(--text-muted);word-break:break-all">';
}

window.refreshMobileQR = function () {
  var c = document.getElementById('mobileQrCode');
  if (c) c.innerHTML = '<span style="font-size:10px;color:var(--text-muted)">⟳</span>';
  window.initMobileQR();
};

// Init QR after page loads
setTimeout(window.initMobileQR, 2000);

// ═══ Init ═══
__doc77_i18n_ready.then(load);

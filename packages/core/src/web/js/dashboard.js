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
    applyViewMode();
    filterAndSort();
    window.renderFavorites(projects);
    window.renderStats();
    window.renderRecent();
  } catch(e) {
    document.getElementById('projGrid').innerHTML =
      '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败</div></div>';
  }
}

// ═══ Greeting ═══
function updateGreeting() {
  var now = new Date();
  var hour = now.getHours();
  var greeting;
  if (hour < 6) greeting = '🌙 夜深了';
  else if (hour < 12) greeting = '👋 早上好';
  else if (hour < 14) greeting = '👋 中午好';
  else if (hour < 18) greeting = '👋 下午好';
  else greeting = '🌆 晚上好';
  var timeStr = String(hour).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  document.getElementById('greeting').innerHTML = greeting + '，现在 ' + timeStr;
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
  var q = filterText.toLowerCase();
  var filtered = projects.filter(function(p) {
    return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.path.toLowerCase().indexOf(q) >= 0;
  });

  filtered.sort(function(a, b) {
    if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (sortBy === 'created') return new Date(b.created_at) - new Date(a.created_at);
    // last_opened (default)
    if (!a.last_opened && !b.last_opened) return a.name.localeCompare(b.name, 'zh-CN');
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
      ? '<div class="empty-state"><div class="empty-text">没有匹配 "' + esc(filterText) + '" 的项目</div></div>'
      : '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">暂无项目，点击 [➕ 注册项目] 开始</div><div class="empty-hint">或使用 doc77 register 命令注册</div></div>';
    return;
  }

  grid.innerHTML = items.map(function(p) {
    return renderCompactCard(p, false);
  }).join('');
};

// ═══ Shared: Render a compact card (used by dashboard.js and favorites.js) ═══
function renderCompactCard(p, inFavorites) {
  var starClass = p.favorited ? 'fav-star favorited' : 'fav-star';
  var starIcon = p.favorited ? '★' : '☆';
  var dateLabel = sortBy === 'last_opened' && p.last_opened
    ? '最近: ' + new Date(p.last_opened).toLocaleDateString('zh-CN', {month:'short',day:'numeric'})
    : '创建: ' + new Date(p.created_at).toLocaleDateString('zh-CN', {month:'short',day:'numeric'});

  return '<div class="card card-compact animate-in" data-id="' + p.id + '" onclick="openProject(' + p.id + ')">' +
    '<button class="' + starClass + '" data-id="' + p.id + '" onclick="event.stopPropagation();toggleFavorite(' + p.id + ')">' + starIcon + '</button>' +
    '<div class="card-icon">📂</div>' +
    '<div class="card-body">' +
      '<div class="card-name">' + esc(p.name) + '</div>' +
      '<div class="card-path">' + esc(p.path) + '</div>' +
      '<div class="card-date">' + dateLabel + '</div>' +
    '</div>' +
    '<div class="card-actions">' +
      '<button class="btn-icon" onclick="event.stopPropagation();startEdit(' + p.id + ')" title="编辑">✏️</button>' +
      '<button class="btn-icon" onclick="event.stopPropagation();doDelete(' + p.id + ')" title="删除">🗑</button>' +
    '</div>' +
    // Inline edit form (hidden by default)
    '<div class="edit-form hidden" id="editForm-' + p.id + '" onclick="event.stopPropagation()">' +
      '<input id="editName-' + p.id + '" value="' + escAttr(p.name) + '" placeholder="项目名称" class="input" style="width:100%;margin-bottom:8px">' +
      '<div class="form-row" style="margin-bottom:8px">' +
        '<input id="editPath-' + p.id + '" value="' + escAttr(p.path) + '" placeholder="项目路径" class="input">' +
        '<button onclick="openDirDialog(' + p.id + ')" class="btn">📂</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button onclick="doUpdate(' + p.id + ')" class="btn btn-primary" style="font-size:12px">💾 保存</button>' +
        '<button onclick="cancelEdit(' + p.id + ')" class="btn" style="font-size:12px">✕ 取消</button>' +
      '</div>' +
      '<div id="editError-' + p.id + '" style="color:var(--danger);font-size:12px;display:none;margin-top:6px"></div>' +
    '</div>' +
  '</div>';
}

// ═══ Project navigation ═══
window.openProject = function(id) {
  // Touch project (update last_opened)
  fetch('/api/projects/' + id + '/touch', { method: 'POST' }).catch(function() {});
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

    if (!recentProjects.length && !recentFiles.length) {
      panel.innerHTML = '<div class="empty-state"><div class="empty-text">打开项目或文档后自动出现在这里</div></div>';
      return;
    }

    var html = '';

    // Project pills
    if (recentProjects.length) {
      html += '<div class="recent-pills" style="margin-bottom:8px">';
      recentProjects.forEach(function(p) {
        html += '<a href="/preview.html?id=' + p.id + '" class="recent-pill" onclick="fetch(\'/api/projects/' + p.id + '/touch\',{method:\'POST\'})">📂 ' + esc(p.name) + '</a>';
      });
      html += '</div>';
    }

    // File links
    if (recentFiles.length) {
      recentFiles.forEach(function(f) {
        html += '<a href="/preview.html?id=' + f.projectId + '&path=' + encodeURIComponent(f.filePath) + '" class="recent-file-link">📄 ' + esc(f.fileName) + ' · ' + esc(f.projectName) + ' · ' + relativeTime(f.viewedAt) + '</a>';
      });
    }

    panel.innerHTML = html;
  } catch(e) {
    panel.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
  }
};

function relativeTime(isoString) {
  var now = Date.now();
  var then = new Date(isoString).getTime();
  var diff = Math.floor((now - then) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}

// ═══ Edit / Delete / Register (legacy functions preserved) ═══
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
  var errEl = document.getElementById('editError-' + id);
  errEl.style.display = 'none';
  if (!name && !pth) { errEl.textContent = '名称或路径至少填一项'; errEl.style.display = 'block'; return; }
  var body = {};
  if (name) body.name = name;
  if (pth) body.path = pth;
  var r = await fetch('/api/projects/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { var d = await r.json(); errEl.textContent = d.error || '更新失败'; errEl.style.display = 'block'; return; }
  toast('项目已更新', 'success');
  load();
};

window.doDelete = async function(id) {
  if (!await confirmDialog('确定移除此项目？文件不会被删除。')) return;
  await fetch('/api/projects/' + id, { method: 'DELETE' });
  load();
};

window.doRegister = async function() {
  var name = document.getElementById('regName').value.trim();
  var pth = document.getElementById('regPath').value.trim();
  var err = document.getElementById('regError');
  err.style.display = 'none';
  if (!name || !pth) { err.textContent = '请填写项目名称和路径'; err.style.display = 'block'; return; }
  var r = await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:name, path:pth}) });
  if (!r.ok) { var d = await r.json(); err.textContent = d.error || '注册失败'; err.style.display = 'block'; return; }
  document.getElementById('regName').value = '';
  document.getElementById('regPath').value = '';
  closeRegisterModal();
  load();
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
  overlay.innerHTML = '<div class="confirm-box" style="max-width:600px;max-height:80vh;display:flex;flex-direction:column" id="fsBrowserBox"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0"><span style="font-weight:600;font-size:13px">📂 服务端文件浏览</span><button onclick="document.getElementById(\'fsBrowserOverlay\').remove()" class="btn-icon" style="font-size:18px">✕</button></div><div id="fsBrowserContent" style="font-size:11px;color:var(--text-muted)">加载中...</div></div>';
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
    document.getElementById('fsBrowserContent').innerHTML = '<p style="color:var(--danger)">加载失败</p>';
  });
};

function renderFsBrowser(forEditId, data) {
  var html = '';

  // Breadcrumb + back
  html += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:8px;flex-wrap:wrap;font-size:12px">';
  if (data.parent) {
    html += '<button onclick="navigateFsBrowser(' + forEditId + ',\'' + escAttr(data.parent) + '\')" style="padding:2px 8px;background:var(--bg-hover);border:1px solid var(--border-light);border-radius:4px;cursor:pointer;font-size:11px;color:var(--text-primary)">⬆ 上级</button>';
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
  html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:10px;color:var(--text-muted)">当前:</span><span style="font-size:12px;font-family:monospace;color:var(--text-secondary);background:var(--bg-hover);padding:2px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(data.path) + '</span></div>';

  // "Select this directory" button
  html += '<button onclick="fillPath(' + forEditId + ',\'' + escAttr(data.path) + '\');document.getElementById(\'fsBrowserOverlay\').remove();toast(\'路径已选择: ' + escAttr(data.path) + '\',\'success\')" style="width:100%;padding:8px 0;margin-bottom:8px;background:#059669;color:#fff;font-size:13px;border:none;border-radius:6px;cursor:pointer;font-weight:500">✅ 选择此目录</button>';

  // Directory listing
  if (data.entries.length === 0) {
    html += '<p style="font-size:12px;color:var(--text-muted);padding:16px 0;text-align:center">此目录为空</p>';
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

// ═══ Init ═══
load();

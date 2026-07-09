/**
 * Doc77 Dashboard JS — 首页（index.html）专用
 */
var projects = [];
var sortBy = 'last_opened'; // default: recently opened first
var filterText = '';

async function load() {
  try { var r = await fetch('/api/projects'); projects = await r.json(); filterAndSort(); }
  catch(e) { document.getElementById('grid').innerHTML = '<div class="col-span-full text-center py-16 text-slate-400"><p>⚠️ 加载失败</p></div>'; }
}

function filterAndSort() {
  var q = filterText.toLowerCase();
  var filtered = projects.filter(function(p) {
    return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.path.toLowerCase().indexOf(q) >= 0;
  });
  // Sort
  filtered.sort(function(a, b) {
    if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (sortBy === 'created') return new Date(b.created_at) - new Date(a.created_at);
    // last_opened (default): nulls at bottom
    if (sortBy === 'last_opened') {
      if (!a.last_opened && !b.last_opened) return a.name.localeCompare(b.name, 'zh-CN');
      if (!a.last_opened) return 1;
      if (!b.last_opened) return -1;
      return new Date(b.last_opened) - new Date(a.last_opened);
    }
    return 0;
  });
  renderGrid(filtered);
}

function renderGrid(items) {
  var grid = document.getElementById('grid');
  if (!items.length) {
    grid.className = '';
    grid.innerHTML = filterText
      ? '<div class="text-center py-16 text-slate-400 dark:text-slate-500"><p class="text-sm">没有匹配 "' + esc(filterText) + '" 的项目</p></div>'
      : '<div class="text-center py-20 text-slate-400 dark:text-slate-500"><div class="text-6xl mb-4 text-slate-300 dark:text-slate-600">📋</div><p class="text-sm">暂无项目，请注册一个本地目录</p><p class="text-xs text-slate-400 dark:text-slate-500 mt-1">支持 ~ 路径和 Windows 路径（WSL 自动转换）</p></div>';
    return;
  }
  grid.className = 'grid gap-4 sm:grid-cols-2';
  grid.innerHTML = items.map(function(p) {
    var dateLabel = sortBy === 'last_opened' && p.last_opened
      ? '最近: ' + new Date(p.last_opened).toLocaleDateString('zh-CN')
      : '创建: ' + new Date(p.created_at).toLocaleDateString('zh-CN');
    return '<div class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-5 transition-all hover:shadow-lg hover:border-blue-300 dark:hover:border-blue-600 animate-in group" data-id="' + p.id + '">' +
      '<div class="flex items-start justify-between mb-1.5">' +
      '<h3 class="text-base font-semibold text-slate-800 dark:text-slate-100 truncate flex-1 cursor-pointer" onclick="location.href=\'/preview.html?id=' + p.id + '\'">📂 ' + esc(p.name) + '</h3>' +
      '<div class="flex items-center gap-0.5 ml-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">' +
      '<button onclick="event.stopPropagation();startEdit(' + p.id + ')" class="text-slate-400 dark:text-slate-500 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 px-1.5 py-1 rounded-md text-xs transition-colors" title="编辑项目">✏️</button>' +
      '<button onclick="event.stopPropagation();doDelete(' + p.id + ')" class="text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-1.5 py-1 rounded-md text-xs transition-colors" title="删除项目">🗑</button>' +
      '</div></div>' +
      '<p class="text-xs text-slate-400 dark:text-slate-500 font-mono truncate mb-4 cursor-pointer" onclick="location.href=\'/preview.html?id=' + p.id + '\'">' + esc(p.path) + '</p>' +
      '<div class="flex justify-between items-center text-[11px]">' +
      '<span class="text-slate-400 dark:text-slate-500">' + dateLabel + '</span>' +
      '</div>' +
      // Inline edit form (hidden by default)
      '<div class="edit-form hidden mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 space-y-2" id="editForm-' + p.id + '">' +
      '<input id="editName-' + p.id + '" value="' + escAttr(p.name) + '" placeholder="项目名称" class="w-full px-3 py-2 border border-slate-200 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200">' +
      '<div class="flex gap-2"><input id="editPath-' + p.id + '" value="' + escAttr(p.path) + '" placeholder="项目路径" class="flex-1 px-3 py-2 border border-slate-200 dark:border-slate-600 rounded-lg text-xs font-mono bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200">' +
      '<button onclick="openDirDialog(' + p.id + ')" class="px-2 py-2 text-sm border border-slate-200 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shrink-0" title="浏览文件夹">📂</button></div>' +
      '<div class="flex gap-2"><button onclick="doUpdate(' + p.id + ')" class="px-4 py-1.5 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 transition-colors">💾 保存</button>' +
      '<button onclick="cancelEdit(' + p.id + ')" class="px-4 py-1.5 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors">✕ 取消</button></div>' +
      '<div id="editError-' + p.id + '" class="text-red-500 text-xs hidden"></div></div></div>';
  }).join('');
}

function startEdit(id) {
  document.querySelectorAll('.edit-form').forEach(function(f) { f.classList.add('hidden'); });
  var form = document.getElementById('editForm-' + id);
  if (form) form.classList.remove('hidden');
}

function cancelEdit(id) {
  var form = document.getElementById('editForm-' + id);
  if (form) form.classList.add('hidden');
}

async function doUpdate(id) {
  var name = document.getElementById('editName-' + id).value.trim();
  var pth = document.getElementById('editPath-' + id).value.trim();
  var errEl = document.getElementById('editError-' + id);
  errEl.classList.add('hidden');
  if (!name && !pth) { errEl.textContent = '名称或路径至少填一项'; errEl.classList.remove('hidden'); return; }
  var body = {};
  if (name) body.name = name;
  if (pth) body.path = pth;
  var r = await fetch('/api/projects/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { var d = await r.json(); errEl.textContent = d.error || '更新失败'; errEl.classList.remove('hidden'); return; }
  toast('项目已更新', 'success');
  load();
}

async function doRegister() {
  var name = document.getElementById('projName').value.trim(), pth = document.getElementById('projPath').value.trim(), err = document.getElementById('regError');
  err.classList.add('hidden');
  if (!name || !pth) { err.textContent = '请填写项目名称和路径'; err.classList.remove('hidden'); return; }
  var r = await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:name, path:pth}) });
  if (!r.ok) { var d = await r.json(); err.textContent = d.error || '注册失败'; err.classList.remove('hidden'); return; }
  document.getElementById('projName').value = ''; document.getElementById('projPath').value = '';
  load();
}

async function doDelete(id) { if (!await confirmDialog('确定移除此项目？文件不会被删除。')) return; await fetch('/api/projects/' + id, { method:'DELETE' }); load(); }

// ═══ Folder Picker — local/remote dual-mode ═══
// Local (localhost): native dialog → fingerprint matching
// Remote (LAN): server-side file browser

function isLocalMode() {
  var host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

var _dirPickTarget = null;

async function openDirDialog(forEditId) {
  var btn = event.target;
  var origHTML = btn.innerHTML;
  btn.innerHTML = '⏳';
  btn.disabled = true;
  _dirPickTarget = forEditId;

  // Strategy 1: Server-side native dialog (macOS / Linux+X11 / native Windows)
  try {
    var r = await fetch('/api/dialog/open-directory', { method: 'POST' });
    var d = await r.json();
    if (d.path) {
      fillPath(forEditId, d.path);
      btn.innerHTML = origHTML; btn.disabled = false;
      return;
    }
  } catch (e) { /* fall through */ }

  // Strategy 2: Local mode → browser folder picker + fingerprint match
  // Only when browser & server are on the SAME machine (localhost)
  if (isLocalMode() && typeof window.showDirectoryPicker === 'function') {
    var folderName = '';
    try {
      var handle = await window.showDirectoryPicker({ mode: 'read' });
      folderName = handle.name || '';
      toast('🔍 正在识别文件夹位置...', 'info');

      var fingerprint = [];
      try {
        var entries = handle.entries();
        var count = 0;
        while (count < 20) {
          try { var nxt = await entries.next(); if (!nxt.value || nxt.done) break; } catch { break; }
          count++;
          var entry = nxt.value, eName = entry[0], eHandle = entry[1];
          var fp = { name: eName, size: 0, type: eHandle.kind === 'directory' ? 'directory' : 'file' };
          if (eHandle.kind === 'file') {
            try { var file = await eHandle.getFile(); fp.size = file.size; } catch (e) {}
          }
          fingerprint.push(fp);
        }
      } catch (e) {}

      // Try fingerprint search
      if (fingerprint.length > 0) {
        var fr = await fetch('/api/find-folder', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderName: folderName, fingerprint: fingerprint })
        });
        var fd = await fr.json();
        if (fd.matches && fd.matches.length > 0) {
          var best = fd.matches[0];
          if (best.score >= 0.7) {
            fillPath(forEditId, best.path);
            toast('✅ 已识别: ' + best.path, 'success');
            btn.innerHTML = origHTML; btn.disabled = false;
            return;
          }
          // Low-confidence matches — show picker with "open server browser" option
          showMatchPicker(folderName, fd.matches, forEditId);
          btn.innerHTML = origHTML; btn.disabled = false;
          return;
        }
      }
      // Fingerprint failed — show server file browser, pre-navigated to likely paths
      toast('未自动匹配到路径，请从服务器文件系统中选择', 'info');
    } catch (e) {
      if (e.name === 'AbortError') { btn.innerHTML = origHTML; btn.disabled = false; return; }
    }
  }

  // Strategy 3: Server-side file browser
  // Used for: remote access, fingerprint failure, or unsupported browsers
  if (!isLocalMode()) {
    // Remote mode: server file browser is the ONLY option (showDirectoryPicker
    // would open the CLIENT's filesystem which is irrelevant)
    toast('远程访问模式，请从服务器文件系统中选择目录', 'info');
  }
  showServerFileBrowser(forEditId);
  btn.innerHTML = origHTML;
  btn.disabled = false;
}

// ═══ Server-side file browser modal ═══

function showServerFileBrowser(forEditId) {
  navigateFsBrowser(forEditId, '');
}

function navigateFsBrowser(forEditId, dirPath) {
  var overlayId = 'fsBrowserOverlay';
  var existing = document.getElementById(overlayId);
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.className = 'confirm-overlay';
  overlay.style.zIndex = '102';
  overlay.innerHTML = '<div class="confirm-box" style="max-width:600px;max-height:80vh;display:flex;flex-direction:column" id="fsBrowserBox"><div class="flex items-center justify-between mb-3 shrink-0"><span class="font-semibold text-sm">📂 服务端文件浏览</span><button onclick="document.getElementById(\'fsBrowserOverlay\').remove()" class="text-slate-400 hover:text-slate-600 text-lg">✕</button></div><div id="fsBrowserContent" class="text-xs text-slate-400">加载中...</div></div>';
  document.body.appendChild(overlay);

  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  // Fetch directory listing
  var url = '/api/browse-fs' + (dirPath ? '?path=' + encodeURIComponent(dirPath) : '');
  fetch(url).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) {
      document.getElementById('fsBrowserContent').innerHTML = '<p class="text-red-500">❌ ' + esc(d.error) + '</p>';
      return;
    }
    renderFsBrowser(forEditId, d);
  }).catch(function() {
    document.getElementById('fsBrowserContent').innerHTML = '<p class="text-red-500">加载失败</p>';
  });
}

function renderFsBrowser(forEditId, data) {
  var html = '';

  // Breadcrumb + back
  html += '<div class="flex items-center gap-1 mb-2 text-xs flex-wrap">';
  if (data.parent) {
    html += '<button onclick="navigateFsBrowser(' + forEditId + ',\'' + escAttr(data.parent) + '\')" class="px-2 py-0.5 bg-slate-100 dark:bg-slate-700 rounded hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">⬆ 上级</button>';
  }
  // Root shortcuts
  if (data.roots && data.roots.length > 0) {
    for (var ri = 0; ri < data.roots.length; ri++) {
      var root = data.roots[ri];
      html += '<button onclick="navigateFsBrowser(' + forEditId + ',\'' + escAttr(root) + '\')" class="px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors text-[10px]">' + esc(root) + '</button>';
    }
  }
  html += '</div>';

  // Current path
  html += '<div class="flex items-center gap-2 mb-2"><span class="text-[10px] text-slate-400">当前:</span><span class="text-xs font-mono text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800 px-2 py-0.5 rounded truncate">' + esc(data.path) + '</span></div>';

  // "Select this directory" button
  html += '<button onclick="fillPath(' + forEditId + ',\'' + escAttr(data.path) + '\');document.getElementById(\'fsBrowserOverlay\').remove();toast(\'路径已选择: ' + escAttr(data.path) + '\',\'success\')" class="w-full py-2 mb-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 transition-colors font-medium">✅ 选择此目录</button>';

  // Directory listing
  if (data.entries.length === 0) {
    html += '<p class="text-xs text-slate-400 py-4 text-center">此目录为空</p>';
  } else {
    html += '<div class="overflow-y-auto flex-1" style="max-height:300px"><div class="space-y-0.5">';
    for (var i = 0; i < data.entries.length; i++) {
      var e = data.entries[i];
      if (e.type === 'directory') {
        html += '<button onclick="navigateFsBrowser(' + forEditId + ',\'' + escAttr(data.path + '/' + e.name) + '\')" class="w-full text-left px-3 py-1.5 text-sm rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center gap-2 transition-colors text-slate-700 dark:text-slate-300"><span>📁</span><span class="truncate">' + esc(e.name) + '</span></button>';
      }
    }
    html += '</div></div>';
  }

  document.getElementById('fsBrowserContent').innerHTML = html;
}

function fillPath(forEditId, path) {
  var targetId = forEditId ? 'editPath-' + forEditId : 'projPath';
  var input = document.getElementById(targetId);
  if (input) input.value = path;
}

function showMatchPicker(folderName, matches, forEditId) {
  var overlay = document.createElement('div');
  overlay.className = 'confirm-overlay'; overlay.style.zIndex = '101';
  var items = matches.map(function(m) {
    return '<button class="match-item w-full text-left px-3 py-2 text-sm rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/30 border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 transition-colors mb-1.5" data-path="' + escAttr(m.path) + '"><span class="font-mono text-xs">' + esc(m.path) + '</span><span class="ml-2 text-[10px] text-slate-400">匹配度 ' + Math.round(m.score * 100) + '%</span></button>';
  }).join('');
  overlay.innerHTML =
    '<div class="confirm-box" style="max-width:560px">' +
    '<p class="text-sm font-semibold mb-1">📂 已选择: <span class="text-blue-600">' + esc(folderName) + '</span></p>' +
    '<p class="text-xs text-slate-500 mb-3">找到以下匹配路径，请选择一个：</p>' + items +
    '<button class="w-full py-2 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cancel-btn">打开服务端文件浏览器</button></div>';
  document.body.appendChild(overlay);
  overlay.querySelectorAll('.match-item').forEach(function(btn) {
    btn.addEventListener('click', function() {
      fillPath(forEditId, btn.dataset.path);
      toast('路径已填入: ' + btn.dataset.path, 'success');
      overlay.remove();
    });
  });
  overlay.querySelector('.cancel-btn').onclick = function() {
    overlay.remove();
    showServerFileBrowser(forEditId);
  };
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
}

// Remove the old openDirDialog — we redefined it above

// ═══ Search & Sort ═══
function onFilterInput(val) {
  filterText = val;
  filterAndSort();
}
function onSortChange(val) {
  sortBy = val;
  filterAndSort();
}

load();

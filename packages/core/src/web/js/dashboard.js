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

async function openDirDialog(forEditId) {
  var btn = event.target;
  var origHTML = btn.innerHTML;
  btn.innerHTML = '⏳';
  btn.disabled = true;
  try {
    var r = await fetch('/api/dialog/open-directory', { method: 'POST' });
    var d = await r.json();
    if (d.path) {
      var targetId = forEditId ? 'editPath-' + forEditId : 'projPath';
      var input = document.getElementById(targetId);
      if (input) input.value = d.path;
    } else {
      // Native dialog unavailable — fall back to browser file picker
      browserDirPick(forEditId);
    }
  } catch (e) { /* dialog cancelled or failed */ }
  btn.innerHTML = origHTML;
  btn.disabled = false;
}

// Browser-side fallback: use File System Access API (showDirectoryPicker)
// This opens the OS-native folder picker with correct "选择文件夹" button text.
// Falls back to webkitdirectory input if the API is unavailable.
var _dirPickTarget = null;
async function browserDirPick(forEditId) {
  _dirPickTarget = forEditId;

  // Method 1: File System Access API (Chrome 86+, Edge 86+)
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      var handle = await window.showDirectoryPicker({ mode: 'read' });
      var folderName = handle.name || '';
      // Collect file summary from the directory
      var fileCount = 0, subDirs = {};
      try {
        var entries = handle.entries();
        var _a, entry;
        while (true) {
          try { _a = await entries.next(); entry = _a.value; }
          catch { break; }
          if (!entry) break;
          if (_a.done) break;
          fileCount++;
          if (entry[1] && entry[1].kind === 'directory' && fileCount <= 30) subDirs[entry[0]] = 1;
        }
      } catch(e) { /* best-effort enumeration */ }
      var dirNames = Object.keys(subDirs);
      var summary = '已选择文件夹: ' + folderName;
      if (dirNames.length > 0) summary += ' (含 ' + dirNames.slice(0, 4).join(', ') + (dirNames.length > 4 ? '...' : '') + ', 共 ' + fileCount + ' 项)';
      else if (fileCount > 0) summary += ' (共 ' + fileCount + ' 项)';

      // Fill the path input
      var targetId = _dirPickTarget ? 'editPath-' + _dirPickTarget : 'projPath';
      var input = document.getElementById(targetId);
      if (input && folderName) {
        var curVal = input.value.trim();
        if (curVal && curVal.indexOf('/') >= 0) {
          input.value = curVal.replace(/\/[^/]*$/, '') + '/' + folderName;
        } else {
          input.value = (curVal || '~/projects') + '/' + folderName;
        }
      }
      toast(summary, 'info');
      return;
    } catch(e) {
      // User cancelled or API error — fall through to Method 2
      if (e.name === 'AbortError') return; // user cancelled, silent
    }
  }

  // Method 2: webkitdirectory input (Safari, older browsers)
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.webkitdirectory = true;
  inp.directory = true;
  inp.style.display = 'none';
  inp.onchange = function() {
    var files = inp.files;
    if (!files || files.length === 0) return;
    var firstPath = files[0].webkitRelativePath || files[0].name;
    var folderName = firstPath.split('/')[0] || '';
    var dirs = {}, fc = 0;
    for (var i = 0; i < Math.min(files.length, 50); i++) {
      var rp = files[i].webkitRelativePath || files[i].name;
      var parts = rp.split('/');
      if (parts.length > 2) dirs[parts[1]] = 1;
      fc++;
    }
    var sub = Object.keys(dirs);
    var summary = '已识别文件夹: ' + folderName;
    if (sub.length > 0) summary += ' (含 ' + sub.slice(0, 3).join(', ') + (sub.length > 3 ? '...' : '') + ', 共 ' + fc + ' 项)';
    else summary += ' (共 ' + fc + ' 个文件)';

    var targetId = _dirPickTarget ? 'editPath-' + _dirPickTarget : 'projPath';
    var input = document.getElementById(targetId);
    if (input && folderName) {
      var curVal = input.value.trim();
      if (curVal && curVal.indexOf('/') >= 0) {
        input.value = curVal.replace(/\/[^/]*$/, '') + '/' + folderName;
      } else {
        input.value = '~/projects/' + folderName;
      }
    }
    toast(summary, 'info');
  };
  document.body.appendChild(inp);
  inp.click();
  setTimeout(function() { document.body.removeChild(inp); }, 60000);
}

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

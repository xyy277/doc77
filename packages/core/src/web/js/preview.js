/**
 * Doc77 Preview JS — 预览页（preview.html）专用
 * 包含: File tree, Content, TTS, Auto-scroll, AI Summary,
 *        Reading progress, Recent files, Bookmarks, Search, Outline, Chat, Queue
 */

//══════════ Vendor (Offline CDN) ══════════
// VENDOR_MAP: CDN URL patterns → local vendor filenames
var VENDOR_MAP = {
  'highlight.min.js': 'highlight.min.js',
  'highlight.js/11.9.0/highlight.min.js': 'highlight.min.js',
  'mermaid.min.js': 'mermaid.min.js',
  'mermaid@11/dist/mermaid.min.js': 'mermaid.min.js',
  'xlsx.mini.min.js': 'xlsx.mini.min.js',
  'mammoth.browser.min.js': 'mammoth.browser.min.js',
  'pyodide': 'pyodide.js',
  'katex.min.css': 'katex.min.css',
  'katex@0.16.11/dist/katex.min.css': 'katex.min.css',
  'katex.min.js': 'katex.min.js',
  'katex@0.16.11/dist/katex.min.js': 'katex.min.js',
  'katex-auto-render.min.js': 'katex-auto-render.min.js',
};

/**
 * Resolve a URL: try local vendor cache first, fallback to original URL.
 * @param {string} originalUrl - The CDN URL
 * @param {string} [localName] - Optional explicit local filename
 * @returns {string} The best available URL
 */
function vsrc(originalUrl, localName) {
  if (!window.__VENDOR_READY) return originalUrl;
  if (!localName) {
    for (var key in VENDOR_MAP) {
      if (originalUrl.indexOf(key) >= 0) { localName = VENDOR_MAP[key]; break; }
    }
  }
  if (!localName) return originalUrl;
  return '/vendor/' + localName;
}

/** Check vendor readiness asynchronously and call callback with boolean. */
function vendorReady(cb) {
  if (window.__VENDOR_READY) { cb(true); return; }
  fetch('/vendor/.ready').then(function(r) {
    window.__VENDOR_READY = r.ok;
    cb(r.ok);
  }).catch(function() { cb(false); });
}

//══════════ Data ══════════
var pid = new URLSearchParams(location.search).get('id');
var directPath = new URLSearchParams(location.search).get('path') || '';
if (!pid) location.href = '/';
var proj = null, projects = [], currentFile = null, activeTab = 'outline';

//══════════ Edit mode state ══════════
var editMode = false;
var editDirty = false;
var editModifiedTime = null;
var editSplitRatio = parseInt(localStorage.getItem('doc77_edit_ratio') || '50', 10);
var editAutoSave = true;
var editAutoSaveTimer = null;
var editAutoSaveMs = 2000;
var editOutlineWasManualCollapsed = false;

//══════════ 多 tab 状态 ══════════
// tabStore: 纯逻辑（顺序/活动/容量淘汰/渲染 LRU），来自 tabs.js
var tabStore = TabStore.createTabStore({ maxTabs: 8, maxRendered: 3 });
var activeTabPath = null;
var tabDataCache = {}; // path -> /api/content response (cached, no re-fetch on tab switch)
var tabScroll = {}; // path -> contentArea.scrollTop (save/restore reading position)
var paneCache = {}; // path -> rendered content DOM nodes (lightweight types only)
function basename(p) { return p.split('/').pop() || p; }
function tabsStorageKey() { return 'doc77-tabs-' + pid; }

var CAPABILITIES = { ai: false, mcp: false };
// Server-pushed write-task lifecycle events (executed/failed) via SSE.
var taskEventSrc = null;
function initTaskEvents() {
  if (taskEventSrc || typeof EventSource === 'undefined') return;
  try {
    taskEventSrc = new EventSource('/api/events');
    taskEventSrc.addEventListener('task:executed', function(e){
      var d = {}; try { d = JSON.parse(e.data); } catch(_){}
      toast(t('web.preview.task.toastExecuted', {id: d.task_id||'?'}), 'success');
      loadTasks(); appendTaskReceipt(t('web.preview.task.taskExecuted', {id: d.task_id||'?'}));
    });
    taskEventSrc.addEventListener('task:failed', function(e){
      var d = {}; try { d = JSON.parse(e.data); } catch(_){}
      toast(t('web.preview.task.toastFailed', {id: d.task_id||'?'}), 'error');
      loadTasks(); appendTaskReceipt(t('web.preview.task.taskFailed', {id: d.task_id||'?'}) + (d.error_message ? '：' + d.error_message : ''));
    });
    taskEventSrc.onerror = function(){ /* EventSource auto-reconnects */ };
  } catch(_){}
}
// 在聊天区追加一条居中的任务回执（若聊天区存在）
function appendTaskReceipt(text) {
  var msgs = document.getElementById('chatMessages'); if (!msgs) return;
  var div = document.createElement('div');
  div.className = 'text-xs text-slate-500 dark:text-slate-400 my-2 text-center';
  div.textContent = text; msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
}
function applyCapabilities() {
  if (!CAPABILITIES.ai) {
    var aiBtn = document.getElementById('aiBtn'); if (aiBtn) aiBtn.style.display = 'none';
    var tabChat = document.getElementById('tabChat'); if (tabChat) tabChat.style.display = 'none';
  }
  if (!CAPABILITIES.mcp) {
    var tabQueue = document.getElementById('tabQueue'); if (tabQueue) tabQueue.style.display = 'none';
    // 智能归类 relies on write tools (batch_operations) — hide when MCP absent.
    var btnClassify = document.getElementById('btnClassify'); if (btnClassify) btnClassify.style.display = 'none';
  }
  if (CAPABILITIES.translate) {
    var tBtn = document.getElementById('translateBtn');
    if (tBtn) { tBtn.classList.remove('hidden'); tBtn.disabled = false; }
  }
}

(async function boot() {
  // Fetch capabilities first (non-blocking, apply when ready)
  fetch('/api/capabilities').then(function(r){ return r.json(); }).then(function(c){
    CAPABILITIES = c; applyCapabilities();
    if (CAPABILITIES.mcp) initTaskEvents();
  }).catch(function(){});
  // Preload editor module in background
  if (window.EditorCore) window.EditorCore.load();
  try {
    var r = await fetch('/api/projects');
    projects = await r.json();
    proj = projects.find(function(p) { return p.id === parseInt(pid); });
    if (!proj) { toast(t('web.preview.projectNotFound'),'error'); location.href='/'; return; }
    document.getElementById('projName').textContent = '💼 ' + proj.name;
    document.title = 'Doc77 — ' + proj.name;
    renderProjMenu(); loadTree(''); loadTasks(); setActiveTab('outline');
    renderBookmarks(); renderRecentFiles();
    // 恢复上次打开的 tab 列表（仅活动 tab 立即加载，其余惰性）
    restoreTabs(directPath || null);
    // Navigate to specific file if path param provided (from recent-files link) — 展开左侧树
    if (directPath) { setTimeout(function(){ navigateToFile(directPath); }, 400); }
    fetch('/api/projects/' + pid + '/touch', { method: 'POST' }).catch(function(){});
  } catch(e) { document.getElementById('projName').textContent = t('web.preview.loadFailed'); }
})();

//══════════ Project Switcher ══════════
function toggleProjMenu() {
  var menu = document.getElementById('projMenu');
  menu.classList.toggle('hidden');
  if (!menu.classList.contains('hidden')) {
    // Focus search input when menu opens
    setTimeout(function(){ var s = document.getElementById('projSearch'); if (s) s.focus(); }, 50);
  }
}
function renderProjMenu(filter) {
  filter = (filter || '').toLowerCase();
  // Sort: current project first, then by last_opened desc
  var sorted = projects.slice().sort(function(a, b) {
    if (proj && a.id === proj.id) return -1;
    if (proj && b.id === proj.id) return 1;
    var aLo = a.last_opened ? new Date(a.last_opened) : null;
    var bLo = b.last_opened ? new Date(b.last_opened) : null;
    if (aLo && bLo) return bLo - aLo;
    if (aLo) return -1;
    if (bLo) return 1;
    return a.name.localeCompare(b.name, window.__doc77_lang || 'zh-CN');
  });
  var filtered = filter ? sorted.filter(function(p) { return p.name.toLowerCase().indexOf(filter) >= 0 || p.path.toLowerCase().indexOf(filter) >= 0; }) : sorted;
  var items = filtered.map(function(p) {
    return '<button onclick="switchProject(' + p.id + ')" class="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 flex flex-col transition-colors"><span class="font-medium">' + (p.id===proj.id?'✓ ':'') + '💼 ' + esc(p.name) + '</span><span class="text-xs text-slate-500 truncate">' + esc(p.path) + '</span></button>';
  }).join('');
  if (!items) items = '<div class="px-3 py-2 text-xs text-slate-500">' + t('web.preview.noMatchingProjects') + '</div>';
  document.getElementById('projMenu').innerHTML =
    '<div class="px-2 pt-2 pb-1 sticky top-0 bg-slate-800 z-10"><div class="relative"><span class="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs">🔍</span><input id="projSearch" placeholder="' + t('web.preview.searchProject') + '" oninput="renderProjMenu(this.value)" class="w-full bg-slate-700 border border-slate-600 rounded-md pl-7 pr-2 py-1.5 text-xs text-slate-200 outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-slate-500"></div></div>' +
    '<div class="max-h-72 overflow-y-auto scrollbar-dark">' + items + '</div>' +
    '<div class="h-px bg-slate-700 my-1"></div><a href="/" class="block w-full text-left px-3 py-2 text-sm text-blue-400 hover:bg-slate-700 transition-colors">' + t('web.preview.registerNewProject') + '</a>';
}
function switchProject(id) { location.href = '/preview.html?id=' + id; }

//══════════ Panels ══════════
var leftPanelExpandedWidth = 288; // remembered expanded width

function toggleCollapse() {
  var panel = document.getElementById('leftPanel');
  var isCollapsed = panel.classList.contains('collapsed');

  if (isCollapsed) {
    // Expand
    panel.style.width = leftPanelExpandedWidth + 'px';
    panel.classList.remove('collapsed');
  } else {
    // Save current width (if not already collapsed by another mechanism)
    var curW = parseInt(panel.style.width);
    if (curW > 60) leftPanelExpandedWidth = curW;
    // Collapse
    panel.style.width = '56px';
    panel.classList.add('collapsed');
  }

  // Toggle visibility of collapsible content sections
  panel.querySelectorAll('.collapsible-content').forEach(function(el) {
    el.classList.toggle('hidden', !isCollapsed);
  });

  // Toggle logo: collapsed → icon only, expanded → full logo
  var logoIcon = document.getElementById('logoIconCollapsed');
  if (logoIcon) logoIcon.style.display = !isCollapsed ? 'block' : 'none';
}

function togglePanel(side) {
  var panel = document.getElementById(side === 'left' ? 'leftPanel' : 'rightPanel');
  var h = panel.classList.toggle('hidden');
  if (side === 'left') {
    document.getElementById('showLeftBtn').classList.toggle('hidden', !h);
    // When showing left panel from full hide, ensure expanded state
    if (!h && panel.classList.contains('collapsed')) {
      toggleCollapse();
    }
  } else {
    var capsule = document.getElementById('capsuleBtn');
    var icon = document.getElementById('capsuleIcon');
    if (h) { capsule.style.right = '16px'; capsule.title = t('web.preview.expandPanel'); }
    else { capsule.style.right = (parseInt(panel.style.width) || 320) - 4 + 'px'; capsule.title = t('web.preview.collapsePanel'); }
    icon.textContent = h ? '◀' : '▶';
  }
}
// Panel drag resize
(function(){
  var r = false, t = null;
  document.querySelectorAll('.cursor-col-resize').forEach(function(h, i) {
    h.addEventListener('mousedown', function(e) {
      // If left panel is collapsed, auto-expand before dragging
      if (i === 0) {
        var lp = document.getElementById('leftPanel');
        if (lp && lp.classList.contains('collapsed')) {
          lp.style.width = leftPanelExpandedWidth + 'px';
          lp.classList.remove('collapsed');
          lp.querySelectorAll('.collapsible-content').forEach(function(el) { el.classList.remove('hidden'); });
          var licon = document.getElementById('logoIconCollapsed');
          if (licon) licon.style.display = 'none';
        }
      }
      r = true; t = i === 0 ? 'left' : 'right';
      document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault();
    });
  });
  document.addEventListener('mousemove', function(e) {
    if (!r) return;
    if (t === 'left') { var w = Math.max(200, Math.min(500, e.clientX)); document.getElementById('leftPanel').style.width = w + 'px'; leftPanelExpandedWidth = w; }
    else { var rp = document.getElementById('rightPanel'); var maxW = Math.floor(window.innerWidth / 3); var w = Math.max(200, Math.min(maxW, window.innerWidth - e.clientX)); rp.style.width = w + 'px'; var cb = document.getElementById('capsuleBtn'); if (cb && !rp.classList.contains('hidden')) cb.style.right = (w - 4) + 'px'; }
  });
  document.addEventListener('mouseup', function() { if (r) { r = false; t = null; document.body.style.cursor = ''; document.body.style.userSelect = ''; } });
})();

function setActiveTab(t) {
  activeTab = t;
  ['tabOutline','tabChat','tabQueue'].forEach(function(id) {
    var el = document.getElementById(id);
    var isChat = id === 'tabChat', isOutline = id === 'tabOutline', isQueue = id === 'tabQueue';
    var active = (isChat && t === 'chat') || (isOutline && t === 'outline') || (isQueue && t === 'queue');
    el.className = 'flex-1 py-3 text-sm font-medium flex items-center justify-center gap-1.5 transition-colors ' +
      (active ? (isOutline ? 'text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-600 dark:border-emerald-400 bg-white dark:bg-slate-900' :
        isChat ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-white dark:bg-slate-900' :
        'text-amber-600 dark:text-amber-400 border-b-2 border-amber-600 dark:border-amber-400 bg-white dark:bg-slate-900') :
        'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200');
  });
  document.getElementById('chatPanel').classList.toggle('hidden', t !== 'chat');
  document.getElementById('outlinePanel').classList.toggle('hidden', t !== 'outline');
  document.getElementById('queuePanel').classList.toggle('hidden', t !== 'queue');
  if (t === 'queue') loadTasks();
  if (t === 'outline') ensureOutlineBuilt();
}

//══════════ File Tree ══════════
async function loadTree(dirPath) {
  var tree = document.getElementById('tree');
  tree.innerHTML = '<div class="text-center py-4"><div class="skeleton h-4 w-3/4 mx-auto mb-2"></div></div>';
  try {
    var r = await fetch('/api/tree/' + pid + '?path=' + encodeURIComponent(dirPath||''));
    var d = await r.json();
    tree.innerHTML = '';
    var fld = d.entries.filter(function(e) { return e.type === 'directory'; });
    var fls = d.entries.filter(function(e) { return e.type === 'file'; });
    fld.concat(fls).forEach(function(e) { tree.appendChild(makeNode(e, dirPath||'')); });
    if (!fld.length && !fls.length) tree.innerHTML = '' + t('web.preview.emptyDir') + '';
  } catch(e) { tree.innerHTML = '' + t('web.preview.loadFailed') + ''; }
}
function refreshTree() { loadTree(''); }
function applyFilter() {
  var q = document.getElementById('fileFilter').value.toLowerCase();
  document.querySelectorAll('#tree [data-name]').forEach(function(el) { el.style.display = (q && !el.dataset.name.toLowerCase().includes(q)) ? 'none' : ''; });
}

function makeNode(entry, parentPath) {
  var frag = document.createDocumentFragment();
  var isDir = entry.type === 'directory';
  var childPath = parentPath ? parentPath + '/' + entry.name : entry.name;
  var row = document.createElement('div');
  row.dataset.name = entry.name;
  row.dataset.path = childPath;
  row.className = 'flex items-center gap-1.5 py-1.5 px-2 rounded-md cursor-pointer transition-colors text-sm hover:bg-slate-800 text-slate-300';
  row.innerHTML = '<span class="w-4 shrink-0 text-center text-slate-500 text-xs">' + (isDir?'▸':'') + '</span>' +
    '<span class="' + (isDir?'text-blue-400':'text-slate-400') + ' shrink-0">' + (isDir?'📁':iconFor(entry.name)) + '</span>' +
    '<span class="truncate flex-1 tree-name">' + entry.name + '</span>' +
    (entry.size ? '<span class="text-[10px] text-slate-500 shrink-0">' + fmtSize(entry.size) + '</span>' : '');
  frag.appendChild(row);

  if (isDir) {
    var wrapper = document.createElement('div'); wrapper.className = 'ml-4 hidden';
    var loaded = false;
    row.addEventListener('click', function(e) {
      e.stopPropagation();
      if (wrapper.classList.contains('hidden')) {
        if (!loaded) {
          wrapper.classList.remove('hidden'); wrapper.innerHTML = '<div class="text-slate-500 text-xs py-1 pl-2">' + t('web.preview.loading') + '</div>';
          fetch('/api/tree/' + pid + '?path=' + encodeURIComponent(childPath)).then(function(r) { return r.json(); }).then(function(d) {
            wrapper.innerHTML = '';
            var f = d.entries.filter(function(e){ return e.type === 'directory'; });
            var l = d.entries.filter(function(e){ return e.type === 'file'; });
            if (!f.length && !l.length) wrapper.innerHTML = '<div class="text-slate-600 text-xs py-1 pl-2">' + t('web.preview.emptyDir') + '</div>';
            else f.concat(l).forEach(function(e) { wrapper.appendChild(makeNode(e, childPath)); });
            var cb = document.createElement('div');
            cb.className = 'tree-collapse-btn text-[10px] text-slate-500 hover:text-slate-300 cursor-pointer py-1 pl-2 select-none';
            cb.textContent = t('web.preview.collapseDir');
            cb.onclick = function(ev) { ev.stopPropagation(); wrapper.classList.add('hidden'); row.querySelector('span').textContent = '▸'; };
            wrapper.appendChild(cb);
            loaded = true;
          }).catch(function() { wrapper.innerHTML = '<div class="text-red-400 text-xs py-1 pl-2">' + t('web.preview.loadFailed') + '</div>'; });
        } else { wrapper.classList.remove('hidden'); }
        row.querySelector('span').textContent = '▾';
      } else { wrapper.classList.add('hidden'); row.querySelector('span').textContent = '▸'; }
    });
    frag.appendChild(wrapper);
  } else {
    row.addEventListener('click', function() {
      openTab(childPath);
    });
    row.addEventListener('contextmenu', function(e) { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, childPath); });
  }
  return frag;
}

function iconFor(n) { var e = n.split('.').pop().toLowerCase(); return ['md','markdown'].indexOf(e)>=0?'📝':['mermaid','mmd'].indexOf(e)>=0?'📊':e==='pdf'?'📕':['png','jpg','jpeg','gif','svg','webp','bmp'].indexOf(e)>=0?'🖼':['ts','js','py','rb','go','rs','java','c','cpp'].indexOf(e)>=0?'💻':['json','yaml','yml','toml'].indexOf(e)>=0?'⚙':'📄'; }


//────────── Tree Item Hover Tooltip ──────────
(function initTreeTooltip() {
  var tooltip = document.createElement('div');
  tooltip.className = 'tree-tooltip';
  document.body.appendChild(tooltip);
  var activeTarget = null;
  var hideTimer = null;

  function position(e) {
    var rect = tooltip.getBoundingClientRect();
    var x = e.clientX + 14;
    var y = e.clientY + 10;
    if (x + rect.width > window.innerWidth - 12) x = e.clientX - rect.width - 14;
    if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - 10;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function show(target, e) {
    if (activeTarget === target && tooltip.classList.contains('visible')) return;
    clearTimeout(hideTimer);
    tooltip.textContent = target.textContent || target.innerText || '';
    tooltip.classList.add('visible');
    activeTarget = target;
    position(e);
  }

  function hide() {
    hideTimer = setTimeout(function() {
      tooltip.classList.remove('visible');
      activeTarget = null;
    }, 120);
  }

  document.getElementById('tree').addEventListener('mouseover', function(e) {
    var nameEl = e.target.closest('.tree-name');
    if (!nameEl) { hide(); return; }
    if (nameEl.scrollWidth <= nameEl.clientWidth) return;
    show(nameEl, e);
  });

  document.getElementById('tree').addEventListener('mousemove', function(e) {
    if (tooltip.classList.contains('visible') && activeTarget) {
      position(e);
    }
  });

  document.getElementById('tree').addEventListener('mouseout', function(e) {
    var nameEl = e.target.closest('.tree-name');
    if (nameEl && nameEl === activeTarget) hide();
  });
})();
//══════════ Navigation ══════════
/** Poll for an element matching selector, up to maxMs. Returns null if not found. */
async function waitForNode(tree, selector, maxMs) {
  maxMs = maxMs || 2000;
  var deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    var el = tree.querySelector(selector);
    if (el) return el;
    await new Promise(function(r) { setTimeout(r, 80); });
  }
  return tree.querySelector(selector);
}

var _pendingLine = 0;
function scrollToLine(lineNum) {
  var area = document.getElementById('contentArea');
  if (!area) return;
  // Estimate scroll position: find total text content and calculate proportion
  var text = area.textContent || '';
  var totalLines = text.split('\n').length || 1;
  var ratio = Math.min(lineNum / totalLines, 1);
  area.scrollTop = area.scrollHeight * ratio - area.clientHeight * 0.3;
  // Flash a temporary marker at the estimated position
  var marker = document.createElement('div');
  marker.style.cssText = 'position:absolute;left:0;right:0;height:2px;background:var(--accent,#2563eb);opacity:0.8;z-index:10;pointer-events:none;transition:opacity .5s';
  marker.style.top = (area.scrollHeight * ratio) + 'px';
  area.style.position = 'relative';
  area.appendChild(marker);
  setTimeout(function(){ marker.style.opacity = '0'; }, 800);
  setTimeout(function(){ marker.remove(); }, 1500);
}
async function navigateToFile(filePath, lineNumber) {
  _pendingLine = lineNumber || 0;
  var parts = filePath.split('/');
  var tree = document.getElementById('tree');
  // Ensure left panel is visible
  var lp = document.getElementById('leftPanel');
  if (lp.classList.contains('hidden')) togglePanel('left');
  if (lp.classList.contains('collapsed')) toggleCollapse();
  // Expand each directory level
  for (var i = 0; i < parts.length - 1; i++) {
    var dirPath = parts.slice(0, i + 1).join('/');
    var selector = '[data-path="' + CSS.escape(dirPath) + '"]';
    // Expand parent if needed
    if (i > 0 && !tree.querySelector(selector)) {
      var parentSelector = '[data-path="' + CSS.escape(parts.slice(0, i).join('/')) + '"]';
      var parentRow = tree.querySelector(parentSelector);
      if (parentRow) {
        var pw = parentRow.nextElementSibling;
        if (pw && pw.classList.contains('hidden')) parentRow.click();
        // Wait for parent children to load
        if (!pw || pw.querySelector('.tree-collapse-btn') === null) {
          await waitForNode(tree, parentSelector + ' + .ml-4 .tree-collapse-btn', 2000);
        }
      }
    }
    var row = await waitForNode(tree, selector, 2000);
    if (!row) break;
    var wrapper = row.nextElementSibling;
    if (wrapper && wrapper.classList.contains('hidden')) row.click();
    // Wait briefly for the click to register + children to start loading
    await new Promise(function(r) { setTimeout(r, 50); });
  }
  // Click the file row
  var fileSelector = '[data-path="' + CSS.escape(filePath) + '"]';
  var fileRow = await waitForNode(tree, fileSelector, 2000);
  if (fileRow) {
    fileRow.click();
    fileRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    openTab(filePath);
  }
}

//══════════ Content（多 tab + LRU 渲染）══════════

/** 取文档数据：命中缓存直接返回，否则请求 /api/content 并缓存。 */
function fetchDoc(path) {
  if (tabDataCache[path]) return Promise.resolve(tabDataCache[path]);
  return fetch('/api/content/' + pid + '?path=' + encodeURIComponent(path))
    .then(function(r) { if (!r.ok) throw new Error('Not found'); return r.json(); })
    .then(function(d) { tabDataCache[path] = d; return d; });
}

/** 重型类型（PDF/office/含 iframe 的 HTML）不进入 DOM 缓存，切回时按 data 重建。 */
function isHeavyDoc(path, d) {
  if (!d) return false;
  if (d.type === 'pdf' || d.type === 'docx' || d.type === 'xlsx') return true;
  if (d.type === 'code') {
    var ext = path.split('.').pop().toLowerCase();
    if (ext === 'html' || ext === 'htm') return true;
  }
  return false;
}

/** 由数据构建内容 HTML 字符串（不含 office，office 走异步渲染）。 */
function buildDocHTML(path, d) {
  var html = '';
  if (d.type === 'unsupported') {
    var labels = { video:t('web.preview.type.video'), audio:t('web.preview.type.audio'), archive:t('web.preview.type.archive'), font:t('web.preview.type.font'),
      database:t('web.preview.type.database'), design:t('web.preview.type.design'), binary:t('web.preview.type.binary'), gis:t('web.preview.type.gis'),
      '3d':t('web.preview.type.model3d'), ebook:t('web.preview.type.ebook'), document:t('web.preview.type.document'), spreadsheet:t('web.preview.type.spreadsheet'),
      presentation:t('web.preview.type.presentation'), too_large:t('web.preview.type.tooLarge'), unknown:t('web.preview.type.unknown') };
    var label = labels[d.category] || labels.unknown;
    var sizeStr = d.size < 1024 ? d.size + ' B' : d.size < 1048576 ? (d.size/1024).toFixed(1) + ' KB' : (d.size/1048576).toFixed(1) + ' MB';
    html = '<div class="max-w-md mx-auto bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8 text-center">' +
      '<div class="text-5xl mb-4">' + label.split(' ')[0] + '</div>' +
      '<h3 class="text-lg font-bold text-slate-800 dark:text-slate-100 mb-2">' + label + '</h3>' +
      '<p class="text-sm text-slate-500 dark:text-slate-400 mb-4">' + esc(path) + '</p>' +
      '<div class="grid grid-cols-2 gap-2 bg-slate-50 dark:bg-slate-900 rounded-lg p-3 mb-4 text-xs text-left">' +
      '<span class="text-slate-500">' + t('web.preview.size') + '</span><span class="text-slate-700 dark:text-slate-300">' + sizeStr + '</span>' +
      (d.modified ? '<span class="text-slate-500">' + t('web.preview.modifiedTime') + '</span><span class="text-slate-700 dark:text-slate-300">' + new Date(d.modified).toLocaleString(window.__doc77_lang || 'zh-CN') + '</span>' : '') +
      '</div>' +
      '<p class="text-xs text-amber-600 dark:text-amber-400 mb-4">⚠️ ' + t('web.preview.unsupportedFormat') + '</p>' +
      (d.temp ? '' : '<button onclick="revealFile(\'reveal\')" class="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors">📂 ' + t('web.preview.showInFolder') + '</button>') +
      '</div>';
  } else if (d.type === 'markdown' || d.type === 'mermaid' || d.type === 'code') {
    html = '<div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 p-8 sm:p-12 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700"><div class="doc-content text-slate-700 dark:text-slate-300" id="docContent">' + d.content + '</div></div>';
    if (d.type === 'code') {
      var ext = path.split('.').pop().toLowerCase();
      if (ext === 'html' || ext === 'htm') {
        html = '<div style="position:relative">' +
          '<button id="htmlToggleBtn" onclick="toggleHtmlPreview()" style="position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:10;padding:6px 16px;border:1px solid #e2e8f0;border-radius:8px;background:rgba(255,255,255,0.9);color:#475569;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.1);backdrop-filter:blur(4px);white-space:nowrap">' + t('web.preview.htmlToggle.preview') + '</button>' +
          '<div id="htmlCodeView">' + html + '</div>' +
          '<div id="htmlPreview" style="display:none"><div id="htmlPreviewContainer" style="position:relative;width:100%;min-height:calc(100vh - 160px);display:flex;flex-direction:column">' +
          '<button onclick="toggleHtmlPreviewFullscreen()" style="position:absolute;top:8px;right:8px;z-index:5;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,0.3);background:rgba(0,0,0,0.5);color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(4px)" title="' + t('web.preview.htmlToggle.fullscreen') + '">⛶</button>' +
          '<iframe src="' + d.rawUrl + '" style="flex:1;border:none;border-radius:8px;width:100%;min-height:60vh"></iframe></div></div>' +
          '</div>';
      }
    }
  } else if (d.type === 'image') {
    html = '<div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 p-4 sm:p-8 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 flex items-center justify-center" style="min-height:60vh"><img src="' + d.rawUrl + '" alt="' + esc(path) + '" class="max-w-full max-h-[80vh] object-contain rounded-md shadow-sm cursor-pointer hover:opacity-90 transition-opacity" loading="lazy" onclick="openImageLightbox(\'' + escAttr(d.rawUrl) + '\', \'' + escAttr(path) + '\')" /></div>';
  } else if (d.type === 'pdf') {
    html = '<div class="pdf-wrapper" id="pdfContainer" style="position:relative;width:100%;min-height:calc(100vh - 160px);display:flex;flex-direction:column">' +
      '<button onclick="togglePdfFullscreen()" style="position:absolute;top:8px;right:8px;z-index:5;width:36px;height:36px;border-radius:50%;border:none;background:rgba(0,0,0,0.5);color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(4px)" title="' + t('web.preview.htmlToggle.fullscreen') + '">⛶</button>' +
      '<iframe src="' + d.rawUrl + '" style="flex:1;border:none;border-radius:8px;width:100%;min-height:60vh"></iframe></div>';
  } else {
    html = '<div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 p-8 sm:p-12 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700"><pre class="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-mono">' + esc(d.content) + '</pre></div>';
  }
  return '<div class="p-4 sm:p-10">' + html + '</div>';
}

/** 生成一个独立的内容 pane DOM 节点。office 类型异步填充。 */
function renderDocNode(path, d) {
  var pane = document.createElement('div');
  pane.className = 'doc-pane';
  pane.dataset.path = path;
  if (d.type === 'docx' || d.type === 'xlsx') {
    pane.innerHTML = '<div class="h-full flex items-center justify-center"><div class="text-sm text-slate-500">' + t('web.preview.loading') + '</div></div>';
    renderOfficeDoc(d, pane, path);
  } else {
    pane.innerHTML = buildDocHTML(path, d);
  }
  return pane;
}

/** 把 pane 挂到内容区，隐藏空状态，恢复滚动位置。 */
function mountPane(pane, path) {
  var host = document.getElementById('docPaneHost');
  host.innerHTML = '';
  host.appendChild(pane);
  var empty = document.getElementById('emptyState'); if (empty) empty.classList.add('hidden');
  document.getElementById('contentArea').scrollTop = tabScroll[path] || 0;
}

/** 激活后统一刷新工具栏/大纲/阅读时长/高亮/面包屑。 */
function afterActivate(path, d) {
  var isTemp = TempPreview.isTempPath(path);
  var btns = ['aiBtn','editBtn','revealBtn','ttsBtn','autoScrollBtn','docSearchBtn'];
  btns.forEach(function(id){ var el = document.getElementById(id); if (el) el.disabled = false; });
  // Disable specific buttons for temp (disk-less) files
  if (isTemp) {
    ['aiBtn','editBtn','revealBtn'].forEach(function(id){ var el = document.getElementById(id); if (el) el.disabled = true; });
  }
  // Show edit button only for editable file types (not temp)
  var editableExts = ['.md','.mdx','.txt','.markdown','.json','.yaml','.yml','.toml',
    '.ts','.tsx','.js','.jsx','.py','.rb','.go','.rs','.java','.c','.cpp','.h',
    '.css','.scss','.less','.html','.htm','.xml','.svg','.sh','.bash','.zsh',
    '.env.example','.gitignore','.dockerignore','.editorconfig',
    '.conf','.cfg','.ini','.csv','.log'];
  var isEditable = !isTemp && editableExts.some(function(ext) {
    return (currentFile || '').toLowerCase().endsWith(ext);
  });
  var editBtnEl = document.getElementById('editBtn');
  if (editBtnEl) {
    editBtnEl.style.display = isEditable ? '' : 'none';
    editBtnEl.classList.toggle('editing-active', editMode);
    editBtnEl.title = editMode ? t('web.preview.exitEditMode') : t('web.preview.editFile');
    editBtnEl.onclick = toggleEditMode;
  }
  // Run 按钮：仅 js/py 显示
  var runBtn = document.getElementById('runBtn');
  if (runBtn) {
    var ext = path.split('.').pop().toLowerCase();
    if (d && d.type === 'code' && (ext === 'js' || ext === 'py')) {
      runBtn.classList.remove('hidden'); runBtn.disabled = false; runBtn.dataset.lang = ext; runBtn.dataset.code = d.content;
    } else { runBtn.classList.add('hidden'); runBtn.disabled = true; }
  }
  updateReadingTime(d);
  refreshOutline();
  document.getElementById('readingProgress').style.width = '0%';
  onContentScroll();
  setTimeout(highlightCode, 60);
  setTimeout(renderMermaid, 60);
  setTimeout(renderMath, 80);
  if (_pendingLine > 0) { setTimeout(function(){ scrollToLine(_pendingLine); _pendingLine = 0; }, 200); }
  renderBreadcrumb(path);
}

/** 根据当前活动 pane 的内容刷新大纲面板。 */
function refreshOutline() {
  outlineBuilt = false;
  var doc = document.getElementById('docContent');
  if (doc) { buildOutline(); }
  else {
    document.getElementById('outlineList').innerHTML = '<div class="text-center py-12 text-slate-400 dark:text-slate-500 text-xs">' + t('web.preview.noOutline') + '</div>';
    outlineBuilt = true;
  }
}

/** 切 tab 前，停止会跨文档串扰的临时状态（TTS/自动滚动/文档内搜索）。 */
function resetTransientDocState() {
  if (typeof ttsActive !== 'undefined' && ttsActive) toggleTTS();
  if (typeof autoScrollActive !== 'undefined' && autoScrollActive) toggleAutoScroll();
  var bar = document.getElementById('docSearchBar');
  if (bar && !bar.classList.contains('hidden')) toggleDocSearch();
}

/** 激活某个已打开的 tab（切换/首次渲染）。 */
function activateTab(path, opts) {
  opts = opts || {};
  // 保存旧 tab 滚动位置
  if (activeTabPath && activeTabPath !== path) tabScroll[activeTabPath] = document.getElementById('contentArea').scrollTop;
  resetTransientDocState();
  tabStore.activate(path);
  activeTabPath = path; currentFile = path;
  renderTabBar(); syncTreeActive(path); saveTabsState();
  if (!opts.silent && !TempPreview.isTempPath(path)) addRecentFile(path);

  var cached = paneCache[path];
  if (cached) {
    tabStore.noteRendered(path); // touch LRU
    mountPane(cached, path);
    afterActivate(path, tabDataCache[path] || { type: 'text', content: '' });
    return;
  }
  // 需要渲染：先显示骨架
  var host = document.getElementById('docPaneHost');
  var empty = document.getElementById('emptyState'); if (empty) empty.classList.add('hidden');
  host.innerHTML = '<div class="p-4 sm:p-10"><div class="h-full flex items-center justify-center"><div class="skeleton h-4 w-48"></div></div></div>';
  fetchDoc(path).then(function(d) {
    if (activeTabPath !== path) return; // user switched away
    if (translateActive) { exitTranslateMode(); return; } // skip render when translate active
    var pane = renderDocNode(path, d);
    if (!isHeavyDoc(path, d)) {
      paneCache[path] = pane;
      var evicted = tabStore.noteRendered(path);
      if (evicted && evicted !== path) delete paneCache[evicted];
    }
    mountPane(pane, path);
    afterActivate(path, d);
  }).catch(function() {
    if (activeTabPath !== path) return;
    host.innerHTML = '<div class="h-full flex flex-col items-center justify-center text-slate-400 gap-2"><span class="text-4xl">⚠️</span><p class="text-sm">' + t('web.preview.fileLoadFailed') + '</p></div>';
  });
}

/** 打开文件为 tab：已打开则切过去，否则新建。 */
function openTab(path, opts) {
  opts = opts || {};
  if (translateActive) exitTranslateMode();
  if (editMode) doExitEdit(true);
  if (!tabStore.has(path)) {
    var r = tabStore.open(path, basename(path));
    r.evicted.forEach(function(p) { releaseTab(p); });
  }
  activateTab(path, opts);
}

/** 关闭 tab：清资源，激活相邻 tab，或回到空状态。 */
function closeTab(path) {
  var isCurrent = path === activeTabPath;
  if (translateActive) exitTranslateMode();
  if (editMode && isCurrent) doExitEdit(true);
  var r = tabStore.close(path);
  releaseTab(path);
  renderTabBar(); saveTabsState();
  if (r.active) { activeTabPath = null; activateTab(r.active, {silent: true}); }
  else showEmptyState();
}

/** 释放某 path 的所有缓存资源。 */
function releaseTab(path) {
  // Revoke objectURL for binary temp previews
  var entry = tabDataCache[path];
  if (entry && entry.objectUrl) { try { URL.revokeObjectURL(entry.objectUrl); } catch(e) {} }
  delete tabDataCache[path];
  delete paneCache[path];
  delete tabScroll[path];
  tabStore.dropRendered(path);
}

/** 无打开文档时的空状态。 */
function showEmptyState() {
  activeTabPath = null; currentFile = null;
  document.getElementById('docPaneHost').innerHTML = '';
  var empty = document.getElementById('emptyState'); if (empty) empty.classList.remove('hidden');
  document.getElementById('tabBar').classList.add('hidden');
  ['aiBtn','editBtn','revealBtn','ttsBtn','autoScrollBtn','docSearchBtn'].forEach(function(id){ var el = document.getElementById(id); if (el) el.disabled = true; });
  var runBtn = document.getElementById('runBtn'); if (runBtn) { runBtn.classList.add('hidden'); runBtn.disabled = true; }
  var rt = document.getElementById('readTime'); if (rt) rt.classList.add('hidden');
  document.getElementById('readingProgress').style.width = '0%';
  renderBreadcrumb(null);
  syncTreeActive(null);
  saveTabsState();
}

/** 渲染 tab 栏。 */
function renderTabBar() {
  var bar = document.getElementById('tabBar');
  var tabs = tabStore.list();
  if (!tabs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden'); bar.classList.add('flex');
  bar.innerHTML = tabs.map(function(t) {
    var active = t.path === activeTabPath;
    var isTemp = TempPreview.isTempPath(t.path);
    var cls = 'group flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 my-1 rounded-md cursor-pointer text-xs whitespace-nowrap border transition-colors ' +
      (active ? 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-100 font-medium shadow-sm'
              : 'bg-transparent border-transparent text-slate-500 dark:text-slate-400 hover:bg-white/60 dark:hover:bg-slate-800/60');
    var badge = isTemp ? '<span class="temp-badge">📎</span>' : '';
    var tooltip = isTemp ? t('web.preview.tempPreviewTooltip') : escAttr(t.path);
    return '<div class="' + cls + '" title="' + tooltip + '" onclick="onTabClick(event, \'' + escAttr(t.path) + '\')" onmousedown="onTabMouseDown(event, \'' + escAttr(t.path) + '\')">' +
      '<span class="shrink-0">' + iconFor(t.title) + '</span>' +
      badge +
      '<span class="truncate max-w-[160px]">' + esc(t.title) + '</span>' +
      '<button class="shrink-0 w-4 h-4 rounded flex items-center justify-center text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-red-500" onclick="event.stopPropagation();closeTab(\'' + escAttr(t.path) + '\')" title="' + t('web.preview.close') + '">✕</button>' +
      '</div>';
  }).join('');
}

/** tab 左键点击切换。 */
function onTabClick(e, path) {
  if (path === activeTabPath) return;
  // Exit any active mode before switching
  if (translateActive) exitTranslateMode();
  // If editing, prompt to save before switching
  if (editMode && editDirty) {
    showEditConfirm(t('web.preview.edit.unsavedTitle'), t('web.preview.edit.switchSavePrompt'), [
      {text:t('web.preview.edit.saveAndSwitch'),cls:'btn-primary',action:function(){ doSave(function(){ doExitEdit(true); activateTab(path); }); }},
      {text:t('web.preview.edit.discard'),cls:'btn-danger',action:function(){ doExitEdit(true); activateTab(path); }},
      {text:t('web.preview.edit.cancel'),cls:''}
    ]);
    return;
  }
  if (editMode) { doExitEdit(true); }
  activateTab(path);
}
/** 中键关闭 tab。 */
function onTabMouseDown(e, path) { if (e.button === 1) { e.preventDefault(); closeTab(path); } }

/** 同步左侧文件树的 active-node 高亮到当前 tab。若父目录未展开则逐层展开。临时文件不参与。 */
function syncTreeActive(path) {
  document.querySelectorAll('#tree .active-node').forEach(function(el) { el.classList.remove('active-node','bg-blue-600','text-white'); });
  if (!path || TempPreview.isTempPath(path)) return;
  var tree = document.getElementById('tree');
  var row = tree.querySelector('[data-path="' + CSS.escape(path) + '"]');
  // If node not visible, expand parent directories
  if (!row) {
    var parts = path.split('/');
    for (var i = 0; i < parts.length - 1; i++) {
      var dirPath = parts.slice(0, i + 1).join('/');
      var dirRow = tree.querySelector('[data-path="' + CSS.escape(dirPath) + '"]');
      if (dirRow) {
        var wrapper = dirRow.nextElementSibling;
        if (wrapper && wrapper.classList.contains('hidden')) dirRow.click();
      }
    }
    // Re-query after expanding
    row = tree.querySelector('[data-path="' + CSS.escape(path) + '"]');
  }
  if (row) {
    row.classList.add('active-node','bg-blue-600','text-white');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/** localStorage 持久化 tab 列表 + 活动 tab（排除临时 tab）。 */
function saveTabsState() {
  try {
    var allTabs = tabStore.list().map(function(t){ return t.path; });
    var diskTabs = allTabs.filter(function(p){ return !TempPreview.isTempPath(p); });
    var diskActive = TempPreview.isTempPath(activeTabPath) ? null : activeTabPath;
    localStorage.setItem(tabsStorageKey(), JSON.stringify({ tabs: diskTabs, active: diskActive }));
  } catch (e) {}
}
function loadTabsState() {
  try { return JSON.parse(localStorage.getItem(tabsStorageKey()) || 'null'); } catch (e) { return null; }
}

/** boot 时恢复 tab 列表：只建栏位，仅活动 tab 立即加载，其余惰性。 */
function restoreTabs(preferActivePath) {
  var st = loadTabsState();
  var tabs = st && Array.isArray(st.tabs) ? st.tabs : [];
  var active = preferActivePath || (st && st.active) || (tabs.length ? tabs[tabs.length - 1] : null);
  if (preferActivePath && tabs.indexOf(preferActivePath) < 0) tabs.push(preferActivePath);
  if (!tabs.length) { showEmptyState(); return; }
  tabs.forEach(function(p) { if (!tabStore.has(p)) tabStore.open(p, basename(p)); });
  renderTabBar();
  if (active) activateTab(active);
}

//══════════ 面包屑（可点击跳转到上一级目录）══════════
/** 渲染面包屑：项目根 + 各目录段可点击，末段（文件名）不可点击。临时文件特殊显示。 */
function renderBreadcrumb(filePath) {
  var bc = document.getElementById('breadcrumb');
  if (!bc) return;
  if (!filePath) { bc.innerHTML = '<span id="breadcrumbPath" class="text-slate-400 text-sm">' + t('web.preview.toolbar.noFileSelected') + '</span>'; return; }
  // Temp file breadcrumb
  if (TempPreview.isTempPath(filePath)) {
    var tName = basename(filePath);
    bc.innerHTML = '<span class="text-slate-400 text-sm">' + t('web.preview.tempFile') + '</span><span class="text-slate-300 dark:text-slate-600 shrink-0">›</span><strong class="text-slate-700 dark:text-slate-200 truncate">' + esc(tName) + '</strong>';
    return;
  }
  var parts = filePath.split('/');
  var html = '<a href="javascript:void(0)" onclick="revealDirInTree(\'\')" class="hover:text-blue-500 dark:hover:text-blue-400 truncate shrink-0" title="' + t('web.preview.projectRoot') + '">' + esc(proj ? proj.name : t('web.preview.root')) + '</a>';
  var acc = '';
  parts.forEach(function(part, i) {
    html += '<span class="text-slate-300 dark:text-slate-600 shrink-0">›</span>';
    if (i === parts.length - 1) {
      html += '<strong class="text-slate-700 dark:text-slate-200 truncate">' + esc(part) + '</strong>';
    } else {
      acc += (acc ? '/' : '') + part;
      html += '<a href="javascript:void(0)" onclick="revealDirInTree(\'' + escAttr(acc) + '\')" class="hover:text-blue-500 dark:hover:text-blue-400 truncate shrink-0">' + esc(part) + '</a>';
    }
  });
  bc.innerHTML = html;
}

/** 在左侧文件树中定位目录：展开祖先节点，滚动并高亮该目录（不加载内容）。 */
async function revealDirInTree(dirPath) {
  var tree = document.getElementById('tree');
  var lp = document.getElementById('leftPanel');
  if (lp.classList.contains('hidden')) togglePanel('left');
  if (lp.classList.contains('collapsed')) toggleCollapse();
  if (!dirPath) { tree.scrollTop = 0; return; }
  var parts = dirPath.split('/');
  for (var i = 0; i < parts.length; i++) {
    var dp = parts.slice(0, i + 1).join('/');
    var selector = '[data-path="' + CSS.escape(dp) + '"]';
    if (i > 0 && !tree.querySelector(selector)) {
      var parentSelector = '[data-path="' + CSS.escape(parts.slice(0, i).join('/')) + '"]';
      var parentRow = tree.querySelector(parentSelector);
      if (parentRow) {
        var pw = parentRow.nextElementSibling;
        if (pw && pw.classList.contains('hidden')) parentRow.click();
        if (!pw || pw.querySelector('.tree-collapse-btn') === null) {
          await waitForNode(tree, parentSelector + ' + .ml-4 .tree-collapse-btn', 2000);
        }
      }
    }
    var row = await waitForNode(tree, selector, 2000);
    if (!row) break;
    var wrapper = row.nextElementSibling;
    if (wrapper && wrapper.classList.contains('hidden')) row.click();
    await new Promise(function(r) { setTimeout(r, 50); });
    if (i === parts.length - 1) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('breadcrumb-flash');
      (function(el){ setTimeout(function(){ el.classList.remove('breadcrumb-flash'); }, 1500); })(row);
    }
  }
}

// Feature 1: Code Highlighting
function highlightCode() {
  if (typeof hljs === 'undefined') { loadHighlightJS(); return; }
  document.querySelectorAll('.doc-content pre code, .doc77-code-block pre code').forEach(function(block) {
    if (!block.dataset.highlighted) { hljs.highlightElement(block); block.dataset.highlighted = '1'; }
  });
}
function loadHighlightJS() {
  var s = document.createElement('script');
  s.src = vsrc('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js');
  s.onload = highlightCode;
  document.head.appendChild(s);
}

// Mermaid：按需懒加载（离线/CDN 不可达时静默降级为源码文本，不阻塞页面）
var _mermaidLoading = false, _mermaidCbs = [];
function loadMermaid(cb) {
  if (window.mermaid) { cb(true); return; }
  _mermaidCbs.push(cb);
  if (_mermaidLoading) return;
  _mermaidLoading = true;
  var s = document.createElement('script');
  s.src = vsrc('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js');
  s.onload = function() {
    try { window.mermaid.initialize({ startOnLoad: false, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default' }); } catch (e) {}
    _mermaidLoading = false;
    _mermaidCbs.splice(0).forEach(function(fn){ fn(true); });
  };
  s.onerror = function() {
    _mermaidLoading = false;
    _mermaidCbs.splice(0).forEach(function(fn){ fn(false); }); // degrade: keep <pre class="mermaid"> source
  };
  document.head.appendChild(s);
}
/** 渲染当前 pane 中尚未处理的 mermaid 图表。 */
function renderMermaid() {
  var host = document.getElementById('docPaneHost');
  if (!host || !host.querySelector('.mermaid:not([data-processed])')) return;
  loadMermaid(function(ok) {
    if (!ok || !window.mermaid) return;
    try { window.mermaid.run({ querySelector: '#docPaneHost .mermaid:not([data-processed])' }); } catch (e) {}
  });
}

// ---- KaTeX math rendering ----

var _katexCbs = [];
var _katexLoading = false;

function loadKaTeX(cb) {
  if (window.katex && window.renderMathInElement) { cb(true); return; }
  _katexCbs.push(cb);
  if (_katexLoading) return;
  _katexLoading = true;

  // Load CSS first
  var css = document.getElementById('katexCss');
  if (css) { css.href = vsrc('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css', 'katex.min.css'); }

  // Load KaTeX JS
  var s = document.createElement('script');
  s.src = vsrc('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js');
  s.onload = function() {
    // Load auto-render extension
    var ar = document.createElement('script');
    ar.src = vsrc('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js');
    ar.onload = function() {
      _katexLoading = false;
      _katexCbs.splice(0).forEach(function(fn) { fn(true); });
    };
    ar.onerror = function() {
      _katexLoading = false;
      _katexCbs.splice(0).forEach(function(fn) { fn(false); });
    };
    document.head.appendChild(ar);
  };
  s.onerror = function() {
    _katexLoading = false;
    _katexCbs.splice(0).forEach(function(fn) { fn(false); });
  };
  document.head.appendChild(s);
}

function renderMath() {
  var host = document.getElementById('docPaneHost');
  if (!host) return;
  // Check if there's any math delimiter in the content
  var html = host.innerHTML;
  if (html.indexOf('$') === -1 && html.indexOf('\\[') === -1 && html.indexOf('\\(') === -1) return;
  loadKaTeX(function(ok) {
    if (!ok || !window.renderMathInElement) return;
    try {
      renderMathInElement(host, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
      });
    } catch (e) {}
  });
}

// Feature 2: Reading Time
function updateReadingTime(d) {
  var el = document.getElementById('readTime'); if (!el) return;
  if (!d || !d.type) { el.classList.add('hidden'); return; }
  if (d.type === 'image' || d.type === 'pdf') { el.classList.add('hidden'); return; }
  var text = d.content || '';
  var chars = text.replace(/<[^>]*>/g,'').length;
  var mins = Math.max(1, Math.round(chars / 400));
  el.textContent = t('web.preview.readingTime', {n: mins});
  el.classList.remove('hidden');
}

// Feature 3: Recent Files
function getRecentFiles() { try { return JSON.parse(localStorage.getItem('doc77-recent')||'[]'); } catch(e) { return []; } }
function addRecentFile(fp) {
  var rf = getRecentFiles();
  rf = rf.filter(function(f) { return !(f.path === fp && f.pid == pid); });
  rf.unshift({ pid: parseInt(pid), path: fp, time: Date.now() });
  if (rf.length > 10) rf = rf.slice(0, 10);
  localStorage.setItem('doc77-recent', JSON.stringify(rf));
  renderRecentFiles();

  // Server-side tracking via fetch + keepalive (survives navigation, reliable Content-Type)
  try {
    fetch('/api/recent-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: parseInt(pid), fileName: fp.split('/').pop(), filePath: fp }),
      keepalive: true,
    }).catch(function() {});
  } catch(e) {}
}
function renderRecentFiles() {
  var rf = getRecentFiles().filter(function(f) { return f.pid == pid; });
  var el = document.getElementById('recentList');
  if (!rf.length) { el.innerHTML = '<div class="text-slate-600 text-xs px-1">' + t('web.preview.recent.empty') + '</div>'; return; }
  el.innerHTML = rf.map(function(f) {
    return '<div onclick="navigateToFile(\'' + escAttr(f.path) + '\')" class="flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer hover:bg-slate-800 text-slate-300 truncate text-xs"><span>📄</span><span class="truncate">' + esc(f.path) + '</span></div>';
  }).join('');
}

// Code copy button
window.copyCode = function(btn) {
  var code = btn.parentElement.querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.innerText || code.textContent || '').then(function() {
    btn.classList.add('copied');
    setTimeout(function() { btn.classList.remove('copied'); }, 1500);
  }).catch(function() {});
};

// Feature 4: Reading Progress
function onContentScroll() {
  var a = document.getElementById('contentArea');
  if (!a) return;
  var pct = a.scrollTop / (a.scrollHeight - a.clientHeight) * 100;
  document.getElementById('readingProgress').style.width = Math.min(100, Math.max(0, pct)) + '%';
  // Back to top button
  var btn = document.getElementById('backToTopBtn');
  if (btn) { btn.style.display = a.scrollTop > 300 ? 'flex' : 'none'; }
}

// Feature 5: TTS
var ttsActive = false;
function toggleTTS() {
  if (ttsActive) { window.speechSynthesis.cancel(); ttsActive = false; document.getElementById('ttsBtn').textContent = '🔊'; document.getElementById('ttsRate').classList.add('hidden'); return; }
  var text = (document.getElementById('docContent') || document.querySelector('.doc-content'))?.textContent;
  if (!text) { toast(t('web.preview.codeRun.openDoc'),'error'); return; }
  ttsActive = true;
  document.getElementById('ttsBtn').textContent = '⏹';
  document.getElementById('ttsRate').classList.remove('hidden');
  var rate = parseFloat(document.getElementById('ttsRate').value) || 1;
  var u = new SpeechSynthesisUtterance(text.substring(0, 5000));
  u.lang = 'zh-CN'; u.rate = rate;
  u.onend = function() { ttsActive = false; document.getElementById('ttsBtn').textContent = '🔊'; document.getElementById('ttsRate').classList.add('hidden'); };
  window.speechSynthesis.speak(u);
}
function updateTTSRate() { if (ttsActive) { window.speechSynthesis.cancel(); ttsActive = false; toggleTTS(); } }

// Translation cache
var translateCache = {};
var translateActive = false;
var _savedOriginalContent = null;

async function toggleTranslate() {
  if (translateActive) {
    exitTranslateMode();
    return;
  }
  var contentEl = document.getElementById('docContent') || document.querySelector('.doc-content');
  if (!contentEl) { toast(t('web.preview.openDocFirst'), 'error'); return; }
  var text = contentEl.textContent;
  if (!text || text.trim().length < 2) { toast(t('web.preview.docTooShort'), 'info'); return; }

  var container = document.getElementById('contentArea');
  if (!container) { toast(t('web.preview.noContentArea'), 'error'); return; }

  // Save entire contentArea state for clean restoration on exit
  _savedOriginalContent = {
    html: container.innerHTML,
    contentArea: container,
  };

  translateActive = true;
  var btn = document.getElementById('translateBtn');
  if (btn) { btn.textContent = '⏹'; btn.classList.add('ring-2', 'ring-emerald-400'); }

  var splitPane = document.createElement('div');
  splitPane.id = 'translateSplit';
  splitPane.style.cssText = 'display:flex;gap:12px;height:100%';
  var left = document.createElement('div');
  left.id = 'translateLeft';
  left.style.cssText = 'flex:1;overflow-y:auto;padding:8px 12px;border-right:1px solid var(--border-light)';
  left.appendChild(contentEl.cloneNode(true));
  var right = document.createElement('div');
  right.id = 'translateRight';
  right.style.cssText = 'flex:1;overflow-y:auto;padding:8px 12px';
  right.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted)">🌐 ' + t('web.preview.translating') + '</div>';
  splitPane.appendChild(left); splitPane.appendChild(right);
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(splitPane);

  try {
    var cacheKey = 'doc_' + currentFile;
    if (translateCache[cacheKey]) {
      right.innerHTML = '<div class="translated-content">' + translateCache[cacheKey] + '</div>';
      return;
    }
    var r = await fetch('/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, source_lang: 'auto', target_lang: 'zh', mode: 'document' })
    });
    if (!r.ok) {
      var err = await r.json();
      right.innerHTML = '<div style="padding:24px;text-align:center;color:var(--danger)">❌ ' + (err.message || err.error || t('web.preview.translateFailed')) + '</div>';
      return;
    }
    var result = await r.json();
    var translatedHtml = '<div class="translated-content" style="white-space:pre-wrap">' + escapeHtml(result.translated_text) + '</div>';
    if (result.segment_count) {
      translatedHtml += '<div style="margin-top:8px;font-size:10px;color:var(--text-muted);text-align:center">' + t('web.preview.segments', {count: result.segment_count, duration: (result.duration_ms / 1000).toFixed(1)}) + '</div>';
    }
    right.innerHTML = translatedHtml;
    translateCache[cacheKey] = translatedHtml;
  } catch(e) {
    right.innerHTML = '<div style="padding:24px;text-align:center;color:var(--danger)">❌ ' + t('web.preview.translateFailed') + ': ' + e.message + '</div>';
  }
}

function exitTranslateMode() {
  translateActive = false;
  var btn = document.getElementById('translateBtn');
  if (btn) { btn.textContent = '🌐'; btn.classList.remove('ring-2', 'ring-emerald-400'); }
  // Restore entire contentArea from saved snapshot (guarantees clean DOM)
  if (_savedOriginalContent && _savedOriginalContent.html) {
    _savedOriginalContent.contentArea.innerHTML = _savedOriginalContent.html;
    _savedOriginalContent = null;
  }
}

// Selection translate popup
(function initSelectionTranslate() {
  document.addEventListener('mouseup', function(e) {
    // Don't interfere if user is interacting with the translate popup itself
    var popupEl = document.getElementById('translatePopup');
    if (popupEl && popupEl.contains(e.target)) return;
    var sel = window.getSelection();
    var text = (sel && sel.toString() || '').trim();
    if (popupEl) popupEl.remove();
    if (text.length < 2 || text.length > 2000) return;
    if (!CAPABILITIES || !CAPABILITIES.translate) return;
    var popup = document.createElement('div');
    popup.id = 'translatePopup';
    popup.style.cssText = 'position:fixed;z-index:9999;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);padding:4px;display:flex;gap:4px;font-size:12px';
    popup.style.left = (e.clientX + 10) + 'px';
    popup.style.top = (e.clientY - 40) + 'px';
    var btn = document.createElement('button');
    btn.textContent = t('web.preview.translateSelected');
    btn.style.cssText = 'padding:4px 10px;border:none;border-radius:6px;cursor:pointer;background:var(--accent);color:#fff;font-size:12px;white-space:nowrap';
    btn.onclick = async function() {
      btn.textContent = t('web.preview.translating'); btn.disabled = true;
      try {
        var r = await fetch('/api/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text, source_lang: 'auto', target_lang: 'zh', mode: 'sentence' })
        });
        if (r.ok) {
          var result = await r.json();
          popup.innerHTML = '<div style="padding:8px 12px;max-width:360px;line-height:1.5;font-size:13px;color:var(--text-primary)">' + escapeHtml(result.translated_text) + '<div style="margin-top:4px;font-size:10px;color:var(--text-muted)">' + (result.duration_ms/1000).toFixed(1) + 's</div></div>';
        } else {
          popup.innerHTML = '<div style="padding:8px 12px;color:var(--danger)">' + t('web.preview.translateFailed') + '</div>';
        }
      } catch(err) { popup.remove(); }
    };
    popup.appendChild(btn);
    document.body.appendChild(popup);
    setTimeout(function() { if (document.getElementById('translatePopup')) popup.remove(); }, 8000);
    var dismiss = function(ev) { if (popup && !popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', dismiss); } };
    setTimeout(function() { document.addEventListener('click', dismiss); }, 100);
  });
})();

// Feature 6: Auto-Scroll
var autoScrollRAF = null, autoScrollActive = false;
function toggleAutoScroll() {
  if (autoScrollActive) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; autoScrollActive = false; document.getElementById('autoScrollBtn').textContent = '▶'; document.getElementById('scrollSpeed').classList.add('hidden'); return; }
  autoScrollActive = true;
  document.getElementById('autoScrollBtn').textContent = '⏸';
  document.getElementById('scrollSpeed').classList.remove('hidden');
  var speed = parseFloat(document.getElementById('scrollSpeed').value) || 60;
  var lastTime = performance.now();
  var a = document.getElementById('contentArea');
  function step(time) {
    if (!autoScrollActive) return;
    var delta = (time - lastTime) / 1000;
    a.scrollTop += speed * delta;
    lastTime = time;
    if (a.scrollTop >= a.scrollHeight - a.clientHeight - 2) { toggleAutoScroll(); return; }
    autoScrollRAF = requestAnimationFrame(step);
  }
  autoScrollRAF = requestAnimationFrame(step);
}

// Feature 7: AI Summary
async function doAISummary() {
  if (!currentFile) { toast(t('web.preview.openDocFirst'),'error'); return; }
  var card = document.getElementById('summaryCard');
  var txt = document.getElementById('summaryText');
  card.classList.remove('hidden'); txt.textContent = t('web.preview.generating');
  try {
    var body = JSON.stringify({ message: t('web.preview.summaryPrompt'), project_id: parseInt(pid), context_file: currentFile });
    var res = await fetch('/api/ai/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: body });
    if (!res.ok) { txt.textContent = t('web.preview.aiUnavailable'); return; }
    var reader = res.body.getReader(), decoder = new TextDecoder(), buf = '', summary = '';
    while (true) {
      var rr = await reader.read(); if (rr.done) break;
      buf += decoder.decode(rr.value, {stream:true});
      var lines = buf.split('\n'); buf = lines.pop()||'';
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (l.startsWith('data:')) {
          try { var dd = JSON.parse(l.slice(5).trim()); if (dd.text) { summary += dd.text; txt.textContent = summary; } } catch(e){}
        }
      }
    }
    if (!summary) txt.textContent = t('web.preview.summaryFailed');
  } catch(e) { txt.textContent = t('web.preview.summaryFailed') + ': ' + e.message; }
}
function readSummary() {
  var txt = document.getElementById('summaryText').textContent;
  if (!txt || txt === t('web.preview.generating')) return;
  var u = new SpeechSynthesisUtterance(txt);
  u.lang = 'zh-CN'; u.rate = 1;
  window.speechSynthesis.speak(u);
}

// Feature 8: In-Document Search (Ctrl+F)
var searchMatches = [], searchIdx = -1;
function toggleDocSearch() {
  var bar = document.getElementById('docSearchBar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) { document.getElementById('docSearchInput').focus(); document.getElementById('docSearchInput').select(); }
  else { clearSearchHighlights(); }
}
function doDocSearch() {
  var q = document.getElementById('docSearchInput').value.trim();
  clearSearchHighlights();
  searchMatches = []; searchIdx = -1;
  if (q.length < 2) { document.getElementById('searchCount').textContent = ''; return; }
  var doc = document.getElementById('docContent');
  if (!doc) { document.getElementById('searchCount').textContent = t('web.preview.zeroMatches'); return; }
  // Use TreeWalker to find text nodes, then wrap matches
  highlightInNode(doc, q.toLowerCase());
  var count = document.querySelectorAll('.search-highlight').length;
  document.getElementById('searchCount').textContent = t('web.preview.matches', {count: count});
  if (count > 0) { searchIdx = 0; scrollToMatch(0); }
}
function highlightInNode(root, q) {
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  var textNodes = [];
  var node;
  while (node = walker.nextNode()) { textNodes.push(node); }
  textNodes.forEach(function(tn) {
    var text = tn.textContent.toLowerCase();
    var idx = text.indexOf(q);
    if (idx === -1) return;
    var frag = document.createDocumentFragment();
    var lastIdx = 0, originalText = tn.textContent;
    while (idx !== -1) {
      if (idx > lastIdx) frag.appendChild(document.createTextNode(originalText.substring(lastIdx, idx)));
      var mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = originalText.substring(idx, idx + q.length);
      frag.appendChild(mark);
      lastIdx = idx + q.length;
      idx = text.indexOf(q, lastIdx);
    }
    if (lastIdx < originalText.length) frag.appendChild(document.createTextNode(originalText.substring(lastIdx)));
    tn.parentNode.replaceChild(frag, tn);
  });
}
function nextSearchMatch(dir) {
  var highlights = document.querySelectorAll('.search-highlight');
  highlights.forEach(function(h) { h.classList.remove('active'); });
  if (!highlights.length) return;
  searchIdx += dir;
  if (searchIdx >= highlights.length) searchIdx = 0;
  if (searchIdx < 0) searchIdx = highlights.length - 1;
  highlights[searchIdx].classList.add('active');
  highlights[searchIdx].scrollIntoView({ block:'center', behavior:'smooth' });
}
function clearSearchHighlights() {
  document.querySelectorAll('.search-highlight').forEach(function(m) {
    var parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  var dc = document.getElementById('docContent');
  if (dc) dc.normalize();
}
document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey||e.metaKey) && e.key === 'f') { e.preventDefault(); toggleDocSearch(); }
  if (e.key === 'Escape' && !document.getElementById('docSearchBar').classList.contains('hidden')) { toggleDocSearch(); }
});

// Feature 9: Global Search
async function doGlobalSearch() {
  var q = document.getElementById('globalSearch').value.trim();
  var rdiv = document.getElementById('searchResults');
  if (q.length < 2) { rdiv.classList.add('hidden'); return; }
  rdiv.classList.remove('hidden');
  rdiv.innerHTML = '<div class="text-xs text-slate-500 px-2 py-1">' + t('web.preview.searching') + '</div>';
  try {
    var res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&project_id=' + pid);
    var d = await res.json();
    if (!d.matches.length) { rdiv.innerHTML = '<div class="text-xs text-slate-500 px-2 py-1">' + t('web.preview.noResults') + '</div>'; return; }
    rdiv.innerHTML = d.matches.slice(0,20).map(function(m) {
      return '<div onclick="navigateToFile(\'' + escAttr(m.file) + '\', ' + m.line + ')" class="flex flex-col px-2 py-1 rounded cursor-pointer hover:bg-slate-800 text-xs"><span class="text-blue-400 truncate">' + esc(m.file) + ':' + m.line + '</span><span class="text-slate-400 truncate">' + esc(m.content) + '</span></div>';
    }).join('');
  } catch(e) { rdiv.innerHTML = '<div class="text-xs text-red-500 px-2 py-1">' + t('web.preview.searchFailed') + '</div>'; }
}

function toggleBookmarkSection() {
  var list = document.getElementById('bookmarkList');
  var arrow = document.getElementById('bookmarkArrow');
  var collapsed = list.classList.toggle('hidden');
  if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
}
function toggleRecentSection() {
  var list = document.getElementById('recentList');
  var arrow = document.getElementById('recentArrow');
  var collapsed = list.classList.toggle('hidden');
  if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
}

// Feature 10: Bookmarks
function getBookmarks() { try { return JSON.parse(localStorage.getItem('doc77-bookmarks')||'[]'); } catch(e) { return []; } }
function saveBookmarks(bm) { localStorage.setItem('doc77-bookmarks', JSON.stringify(bm)); }
function addBookmark(filePath) {
  var bm = getBookmarks();
  if (bm.find(function(b){ return b.pid == pid && b.path === filePath; })) { toast(t('web.preview.alreadyBookmarked'),'info'); return; }
  bm.unshift({ pid: parseInt(pid), path: filePath, time: Date.now() });
  if (bm.length > 50) bm = bm.slice(0, 50);
  saveBookmarks(bm);
  renderBookmarks();
  toast(t('web.preview.bookmarked'),'success');
}
function removeBookmark(filePath) {
  var bm = getBookmarks().filter(function(b){ return !(b.pid == pid && b.path === filePath); });
  saveBookmarks(bm); renderBookmarks();
}
function renderBookmarks() {
  var bm = getBookmarks().filter(function(b){ return b.pid == pid; });
  var el = document.getElementById('bookmarkList');
  var cnt = document.getElementById('bookmarkCount');
  if (cnt) cnt.textContent = bm.length;
  if (!bm.length) { el.innerHTML = '<div class="text-slate-600 text-xs px-1">' + t('web.preview.bookmark.empty') + '</div>'; return; }
  el.innerHTML = bm.map(function(b) {
    return '<div class="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-800 group cursor-pointer">' +
      '<span class="truncate flex-1 text-slate-300" onclick="navigateToFile(\'' + escAttr(b.path) + '\')">⭐ ' + esc(b.path) + '</span>' +
      '<button class="hidden group-hover:block text-slate-500 hover:text-red-400 text-xs" onclick="event.stopPropagation();removeBookmark(\'' + escAttr(b.path) + '\')">✕</button></div>';
  }).join('');
}
// Right-click context menu
function showCtxMenu(x, y, filePath) {
  var m = document.getElementById('ctxMenu');
  m.innerHTML = '<button onclick="addBookmark(\'' + escAttr(filePath) + '\');hideCtxMenu()">' + t('web.preview.bookmark.add') + '</button>';
  m.style.left = x + 'px'; m.style.top = y + 'px';
  m.classList.remove('hidden');
  setTimeout(function(){ document.addEventListener('click', hideCtxMenu, {once:true}); }, 0);
}
function hideCtxMenu() { document.getElementById('ctxMenu').classList.add('hidden'); }

// Toolbar
function revealFile(action) { if (currentFile) fetch('/api/reveal/' + pid + '?path=' + encodeURIComponent(currentFile) + '&action=' + action).catch(function(){}); }
function openAIChat() { if (!CAPABILITIES.ai) { toast(t('web.preview.aiNotInstalled'), 'info'); return; } togglePanel('right'); setActiveTab('chat'); if (currentFile) { document.getElementById('ctxBanner').classList.remove('hidden'); document.getElementById('ctxText').textContent = currentFile; sendQuickMsg(t('web.preview.chat.summarizePrompt', {file: currentFile}), currentFile); } }

//══════════ Edit Mode ══════════
function toggleEditMode() {
  if (!currentFile) return;
  if (editMode) { exitEditMode(); }
  else { enterEditMode(); }
}

function enterEditMode() {
  if (editMode || !proj || !proj.id) return;
  var cached = tabDataCache[currentFile];
  editModifiedTime = cached && cached.modified ? cached.modified : null;

  var docContent = document.getElementById('docContent');
  if (!docContent) return;
  var previewHTML = docContent.innerHTML;
  var lang = getEditLanguage(currentFile);

  docContent.innerHTML =
    '<div id="editSplitContainer" class="edit-split">' +
      '<div class="edit-pane-editor" id="editEditorPane"></div>' +
      '<div class="edit-divider" id="editDivider"></div>' +
      '<div class="edit-pane-preview" id="editPreviewPane">' + previewHTML + '</div>' +
    '</div>' +
    '<div class="edit-statusbar" id="editStatusbar">' +
      '<span id="statusCursor">' + t('web.preview.edit.lineCol') + '</span>' +
      '<span class="status-sep"></span><span>' + lang.toUpperCase() + '</span>' +
      '<span class="status-sep"></span>' +
      '<span class="status-dirty" id="statusDirty" style="display:none">' + t('web.preview.edit.dirty') + '</span>' +
      '<span class="status-saved fade" id="statusSaved">' + t('web.preview.edit.saved') + '</span>' +
    '</div>';

  var editorPane = document.getElementById('editEditorPane');
  var container = document.getElementById('editSplitContainer');
  if (container && editorPane) {
    var tw = container.clientWidth;
    editorPane.style.flex = '0 0 ' + editSplitRatio + '%';
  }

  initEditDivider();

  // Override parent max-width constraint for full-width editor
  var editContainer = document.getElementById('editSplitContainer');
  var p = editContainer ? editContainer.parentElement : null;
  while (p && !p.classList.contains('max-w-4xl')) { p = p.parentElement; }
  if (p) { p.style.maxWidth = 'none'; window._editMaxWidthParent = p; }

  // Auto-collapse right panel
  var rp = document.getElementById('rightPanel');
  editOutlineWasManualCollapsed = rp && rp.classList.contains('hidden');
  if (rp && !rp.classList.contains('hidden')) {
    togglePanel('right');
  }

  var editBtnEl = document.getElementById('editBtn');
  if (editBtnEl) { editBtnEl.classList.add('editing-active'); editBtnEl.title = t('web.preview.edit.exitEditMode'); }
  editMode = true; editDirty = false;

  // Load editor with raw file content (cache-bust to avoid stale browser cache)
  fetch('/api/raw/' + proj.id + '?path=' + encodeURIComponent(currentFile) + '&t=' + Date.now())
    .then(function(r) { return r.text(); })
    .then(function(t) { if (editMode) initEditorInstance(t); })
    .catch(function() { if (editMode) initEditorInstance(''); });
}

async function initEditorInstance(initialText) {
  var pane = document.getElementById('editEditorPane');
  if (!pane) return;

  // Show loading while CodeMirror loads
  pane.innerHTML = '<div class="flex items-center justify-center h-full"><span class="text-sm text-slate-400">' + t('web.preview.edit.loadingEditor') + '</span></div>';

  // Wait for CodeMirror to load (may be in-flight from preload or freshly started)
  var cmLoaded = false;
  if (window.EditorCore && window.EditorCore.load) {
    cmLoaded = await window.EditorCore.load();
  }

  // Clear loading indicator
  pane.innerHTML = '';

  if (!cmLoaded) {
    var b = document.createElement('div'); b.className = 'editor-banner';
    b.textContent = t('web.preview.edit.editorFallback');
    pane.parentNode.insertBefore(b, pane);
  }

  window._editEditor = window.EditorCore.createEditor(pane, {
    initialValue: initialText,
    language: getEditLanguage(currentFile),
    onSave: function() { doSave(); }
  });

  var el = pane.querySelector('.cm-editor, .editor-textarea-fallback');
  if (el) {
    el.addEventListener('input', function() {
      if (!editDirty) { editDirty = true; document.getElementById('statusDirty').style.display = ''; }
      scheduleAutoSave();
      // Real-time preview (debounced 150ms)
      clearTimeout(window._editPreviewTimer);
      window._editPreviewTimer = setTimeout(function() {
        if (editMode && window._editEditor) updateEditPreviewLive(window._editEditor.getValue());
      }, 150);
    });
  }
  if (editAutoSave) scheduleAutoSave();
}

function getEditLanguage(fp) {
  var ext = (fp||'').split('.').pop().toLowerCase();
  var m = {md:'markdown',mdx:'markdown',markdown:'markdown',json:'json',
    js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',
    py:'python',rb:'ruby',go:'go',rs:'rust',java:'java',c:'c',cpp:'cpp',h:'c',
    css:'css',scss:'css',less:'css',html:'html',xml:'xml',svg:'xml',
    sh:'shell',bash:'shell',zsh:'shell',yaml:'yaml',yml:'yaml',toml:'toml',
    sql:'sql',txt:'text'};
  return m[ext] || 'text';
}

function scheduleAutoSave() {
  clearTimeout(editAutoSaveTimer);
  if (!editAutoSave) return;
  editAutoSaveTimer = setTimeout(function() { if (editDirty) doSave(null, true); }, editAutoSaveMs);
}

function doSave(cb, skipPreview) {
  if (!editMode || !currentFile || !window._editEditor || !proj || !proj.id) return;
  var content = window._editEditor.getValue();
  var headers = { 'Content-Type': 'application/json' };
  if (editModifiedTime) headers['X-Expected-Modified'] = editModifiedTime;

  fetch('/api/content/' + proj.id + '?path=' + encodeURIComponent(currentFile), {
    method: 'PUT', headers: headers, body: JSON.stringify({ content: content })
  })
  .then(function(r) {
    if (r.status === 409) {
      r.json().then(function(d) {
        showEditConfirm(t('web.preview.edit.externalModified'), (d.error||t('web.preview.edit.overwriteWarning')), [
          {text:t('web.preview.edit.overwriteSave'),cls:'btn-danger',action:function(){
            var fh = {'Content-Type':'application/json','X-Force-Overwrite':'true'};
            fetch('/api/content/'+proj.id+'?path='+encodeURIComponent(currentFile),{method:'PUT',headers:fh,body:JSON.stringify({content:content})})
            .then(function(r2){return r2.json().then(function(d2){if(!r2.ok)throw new Error(d2.error);return d2;});})
            .then(function(d2){editModifiedTime=d2.modified;markSaved();if(!skipPreview)updateEditPreview(content);if(cb)cb();})
            .catch(function(e){alert(t('web.preview.edit.saveFailed', {message: e.message}));});
          }},
          {text:t('web.preview.edit.cancel'),cls:''}
        ]);
      });
      return;
    }
    return r.json().then(function(d) { if (!r.ok) throw new Error(d.error||t('web.preview.edit.saveFailed')); return d; });
  })
  .then(function(d) {
    if (!d) return;
    editModifiedTime = d.modified; markSaved();
    // Only refresh server-rendered preview on manual save (Ctrl+S), not auto-save
    if (!skipPreview) updateEditPreview(content);
    tabDataCache[currentFile] = { content: content, path: currentFile, size: d.size, modified: d.modified };
    delete paneCache[currentFile]; // force re-fetch from server on re-render
    if (cb) cb();
  })
  .catch(function(e) { alert(t('web.preview.edit.saveFailed') + ': ' + e.message); });
}

function markSaved() {
  editDirty = false;
  var d = document.getElementById('statusDirty'); if (d) d.style.display = 'none';
  var s = document.getElementById('statusSaved');
  if (s) { s.textContent = t('web.preview.edit.saved'); s.classList.remove('fade'); }
}

function updateEditPreviewLive(content) {
  var pp = document.getElementById('editPreviewPane');
  if (!pp) return;
  try {
    // Inline-render raw markdown as HTML preview (synchronous, instant)
    var ext = (currentFile || '').split('.').pop().toLowerCase();
    if (ext === 'md' || ext === 'markdown' || ext === 'mdx') {
      // Basic markdown-like rendering: headings, bold, italic, code blocks, lists
      var html = content
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/^### (.+)$/gm,'<h4 style="margin:1em 0 .3em;font-size:15px">$1</h4>')
        .replace(/^## (.+)$/gm,'<h3 style="margin:1.2em 0 .4em;font-size:17px">$1</h3>')
        .replace(/^# (.+)$/gm,'<h2 style="margin:1.4em 0 .5em;font-size:20px">$1</h2>')
        .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
        .replace(/\*(.+?)\*/g,'<em>$1</em>')
        .replace(/`([^`]+)`/g,'<code style="background:var(--bg-code,#f1f5f9);padding:1px 4px;border-radius:3px;font-size:13px">$1</code>')
        .replace(/^\- (.+)$/gm,'<li style="margin-left:1.5em">$1</li>')
        .replace(/\n\n/g,'<br><br>')
        .replace(/\n/g,'<br>');
      pp.innerHTML = '<div style="padding:16px 20px;font-size:14px;line-height:1.7;color:var(--text-primary,#1e293b)">' + html + '</div>';
    } else {
      pp.innerHTML = '<pre style="white-space:pre-wrap;font-size:14px;padding:16px 20px">' + escapeHtml(content) + '</pre>';
    }
  } catch(e) {
    pp.innerHTML = '<pre style="white-space:pre-wrap;font-size:14px;padding:16px 20px">' + escapeHtml(content) + '</pre>';
  }
}

function updateEditPreview(content) {
  var pp = document.getElementById('editPreviewPane');
  if (!pp || !currentFile || !proj || !proj.id) return;
  fetch('/api/content/' + proj.id + '?path=' + encodeURIComponent(currentFile) + '&t=' + Date.now())
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d && d.content) pp.innerHTML = d.content;
    })
    .catch(function() {
      pp.innerHTML = '<pre style="white-space:pre-wrap;font-size:14px">' + escapeHtml(content) + '</pre>';
    });
}

function exitEditMode(skipConfirm) {
  if (!editMode) return;
  if (editDirty && !skipConfirm) {
    showEditConfirm(t('web.preview.edit.unsavedTitle'), t('web.preview.edit.exitSavePrompt'), [
      {text:t('web.preview.edit.saveAndExit'),cls:'btn-primary',action:function(){doSave(function(){doExitEdit();});}},
      {text:t('web.preview.edit.discard'),cls:'btn-danger',action:function(){doExitEdit();}},
      {text:t('web.preview.edit.cancel'),cls:''}
    ]);
    return;
  }
  doExitEdit();
}

/** @param {boolean} [skipRefresh] — true when switching tabs (activateTab handles rendering) */
function doExitEdit(skipRefresh) {
  // Restore max-width on parent that was overridden for full-width editing
  if (window._editMaxWidthParent) { window._editMaxWidthParent.style.maxWidth = ''; window._editMaxWidthParent = null; }

  // Capture preview HTML before destroying editor, then restore docContent
  var previewHTML = null;
  var pp = document.getElementById('editPreviewPane');
  if (pp) previewHTML = pp.innerHTML;

  // Destroy editor instance
  if (window._editEditor) { try { window._editEditor.destroy(); } catch(e) {}; window._editEditor = null; }
  // Cleanup divider event listeners
  cleanupEditDivider();

  // Restore docContent from preview pane (always — even skipRefresh, so DOM is clean)
  if (previewHTML) {
    var dc = document.getElementById('docContent');
    if (dc) dc.innerHTML = previewHTML;
  }

  // Always reopen right panel on exit
  var rp = document.getElementById('rightPanel');
  if (rp && rp.classList.contains('hidden')) togglePanel('right');
  editMode = false; editDirty = false; editModifiedTime = null;
  clearTimeout(editAutoSaveTimer); editAutoSaveTimer = null;
  clearTimeout(window._editPreviewTimer); window._editPreviewTimer = null;
  var eb = document.getElementById('editBtn');
  if (eb) { eb.classList.remove('editing-active'); eb.title = t('web.preview.edit.editFile'); }

  // Re-fetch server-rendered content (invalidate cache first to force fresh data)
  if (currentFile && !skipRefresh) {
    tabDataCache[currentFile] = null;
    fetchDoc(currentFile).then(function(d) {
      if (translateActive) return; // skip render when translate active
      var pane = renderDocNode(currentFile, d);
      mountPane(pane, currentFile);
      afterActivate(currentFile, d);
    });
  }
}

function initEditDivider() {
  var div = document.getElementById('editDivider');
  var sc = document.getElementById('editSplitContainer');
  var ep = document.getElementById('editEditorPane');
  if (!div || !sc || !ep) return;
  var dragging = false;
  var onMove = function(e) {
    if (!dragging) return;
    var r = sc.getBoundingClientRect();
    var pct = sc.classList.contains('vertical') ? ((e.clientY-r.top)/r.height)*100 : ((e.clientX-r.left)/r.width)*100;
    pct = Math.max(20, Math.min(80, pct));
    editSplitRatio = Math.round(pct); ep.style.flex = '0 0 ' + editSplitRatio + '%';
  };
  var onUp = function() {
    if (!dragging) return;
    dragging = false; div.classList.remove('dragging');
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    localStorage.setItem('doc77_edit_ratio', String(editSplitRatio));
  };
  div.addEventListener('mousedown', function(e) { e.preventDefault(); dragging = true; div.classList.add('dragging'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  // Store for cleanup
  window._editDividerCleanup = function() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
}

function cleanupEditDivider() {
  if (window._editDividerCleanup) { window._editDividerCleanup(); window._editDividerCleanup = null; }
}

function showEditConfirm(title, message, buttons) {
  var ov = document.createElement('div'); ov.className = 'edit-confirm-overlay';
  ov.innerHTML = '<div class="edit-confirm-dialog"><h3>'+escapeHtml(title)+'</h3><p>'+escapeHtml(message)+'</p><div class="confirm-actions">'+
    buttons.map(function(b,i){return '<button class="'+b.cls+'" data-idx="'+i+'">'+escapeHtml(b.text)+'</button>';}).join('')+
    '</div></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', function(e) { if (e.target === ov) ov.remove(); });
  ov.querySelectorAll('button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(btn.getAttribute('data-idx'),10); ov.remove();
      if (buttons[idx]&&buttons[idx].action) buttons[idx].action();
    });
  });
}

function escapeHtml(str) { var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
// Outline
var outlineHeadings = [], outlineBuilt = false;
function ensureOutlineBuilt() { if (!outlineBuilt) { var doc = document.getElementById('docContent'); if (doc) buildOutline(); } }
function buildOutline() {
  var doc = document.getElementById('docContent'), list = document.getElementById('outlineList');
  if (!doc) { list.innerHTML = '<div class="text-center py-12 text-slate-400 dark:text-slate-500 text-xs">' + t('web.preview.outline.openMarkdown') + '</div>'; outlineBuilt = false; return; }
  var headings = doc.querySelectorAll('h1, h2, h3'); outlineHeadings = [];
  headings.forEach(function(h, i) { h.id = 'heading-' + i; outlineHeadings.push({ id: h.id, text: h.textContent||'', level: parseInt(h.tagName[1]) }); });
  if (!outlineHeadings.length) { list.innerHTML = '<div class="text-center py-12 text-slate-400 dark:text-slate-500 text-xs">' + t('web.preview.outline.noHeadings') + '</div>'; outlineBuilt = true; return; }
  list.innerHTML = outlineHeadings.map(function(h) {
    return '<div onclick="scrollToHeading(\'' + h.id + '\')" class="flex items-center gap-1.5 py-1.5 px-2 rounded-md cursor-pointer transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 text-sm" style="padding-left:' + ((h.level-1)*12+8) + 'px">' +
      '<span class="w-1 h-4 rounded-full ' + (h.level===1?'bg-blue-500':h.level===2?'bg-slate-400':'bg-slate-300') + ' shrink-0"></span>' +
      '<span class="truncate text-slate-600 dark:text-slate-300 ' + (h.level===1?'font-semibold':'') + '">' + esc(h.text) + '</span></div>';
  }).join('');
  outlineBuilt = true;
}
function scrollToHeading(id) {
  var el = document.getElementById(id), container = document.getElementById('contentArea');
  if (!el || !container) return;
  var relativeTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
  var target = container.scrollTop + relativeTop;
  var start = container.scrollTop, dist = target - start, duration = 300, t0 = performance.now();
  function step(now) {
    var p = Math.min((now - t0) / duration, 1);
    var e = p < .5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;
    container.scrollTop = start + dist * e;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
  el.classList.add('heading-flash');
  setTimeout(function(){ el.classList.remove('heading-flash'); }, 1500);
}

// Chat — SSE streaming
var chatSessionId = null;
// Set by sendQuickMsg to attach the opened file's content to the NEXT request
// only (consumed and cleared in sendMessage). Lets the backend answer
// "summarize this file" directly instead of crawling the project with tools.
var pendingContextFile = null;
document.getElementById('chatInput').addEventListener('input', function(){ document.getElementById('sendBtn').disabled = !this.value.trim(); });

async function sendMessage() {
  var input = document.getElementById('chatInput'), msg = input.value.trim();
  if (!msg) return;
  var ctxFile = pendingContextFile; pendingContextFile = null;
  var wc = document.getElementById('welcomeCard'); if (wc) wc.remove();
  appendChatMsg('user', msg);
  input.value = ''; document.getElementById('sendBtn').disabled = true;
  var aiMsg = appendChatMsg('ai', ''), aiBody = aiMsg.querySelector('.msg-body');
  try {
    var body = JSON.stringify({ message: msg, project_id: parseInt(pid), session_id: chatSessionId || undefined, context_file: ctxFile || undefined });
    var response = await fetch('/api/ai/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:body });
    if (!response.ok) {
      var errData = await response.json().catch(function(){ return {}; });
      if (errData.error === 'AI_NOT_CONFIGURED') aiBody.innerHTML = '<span class="text-amber-600">⚠️ ' + t('web.preview.chat.configureAi') + '</span> <button onclick="toggleSettings();switchSettingsTab(\'ai\')" class="text-blue-600 underline text-xs">' + t('web.preview.chat.goToSettings') + '</button>';
      else aiBody.textContent = '❌ ' + (errData.message||errData.error||t('web.preview.chat.aiUnavailable'));
      document.getElementById('sendBtn').disabled = false; return;
    }
    var reader = response.body.getReader(), decoder = new TextDecoder(), buffer = '', currentEvent = '';
    while (true) {
      var r = await reader.read(); if (r.done) break;
      buffer += decoder.decode(r.value, {stream:true});
      var lines = buffer.split('\n'); buffer = lines.pop()||'';
      for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (trimmed.startsWith('event:')) { currentEvent = trimmed.slice(6).trim(); }
        else if (trimmed.startsWith('data:')) { try { var data = JSON.parse(trimmed.slice(5).trim()); handleSSE(currentEvent, data, aiBody); } catch(e){} }
      }
    }
  } catch(e) { if (!aiBody.textContent) aiBody.textContent = t('web.preview.chat.networkFailed'); }
  document.getElementById('sendBtn').disabled = false;
}
function handleSSE(event, data, aiBody) {
  switch (event) {
    case 'session': chatSessionId = data.session_id; break;
    case 'token': aiBody.textContent += data.text; document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight; break;
    case 'tool_call':
      // tool_call_start + final tool_call both arrive as this event; show one indicator per tool.
      if (aiBody.querySelector('[data-tool="' + data.name + '"]')) break;
      var isWriteOp = ['move_file','create_folder','delete_file','batch_operations'].indexOf(data.name) >= 0;
      var ind = document.createElement('div'); ind.dataset.tool = data.name;
      if (isWriteOp) {
        ind.dataset.write = '1';
        ind.className = 'text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-2';
        ind.innerHTML = '<span>📋 ' + esc(data.name) + t('web.preview.chat.pendingApproval') + '</span><a onclick="setActiveTab(\'queue\');loadTasks();" class="text-blue-600 dark:text-blue-400 underline cursor-pointer">' + t('web.preview.chat.viewQueue') + '</a>';
      } else {
        ind.className = 'text-xs text-blue-600 dark:text-blue-400 mt-1 flex items-center gap-1';
        ind.innerHTML = '<span>🔍 ' + esc(data.name) + '...</span>';
      }
      aiBody.appendChild(ind); break;
    case 'done':
      aiBody.querySelectorAll('[data-tool]:not([data-write])').forEach(function(el){ el.innerHTML = '<span>' + t('web.preview.chat.toolCompleted', {tool: esc(el.dataset.tool)}) + '</span>'; el.className = 'text-xs text-green-600 dark:text-green-400 mt-1'; }); break;
    case 'error':
      var ed = document.createElement('div'); ed.className = 'text-xs text-red-500 mt-1'; ed.textContent = '❌ ' + (data.message||t('web.preview.chat.unknownError')); aiBody.appendChild(ed); break;
  }
}
function appendChatMsg(role, content) {
  var c = document.getElementById('chatMessages'), d = document.createElement('div');
  d.className = 'flex gap-3 ' + (role==='user'?'flex-row-reverse':'') + ' animate-in';
  d.innerHTML = '<div class="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs ' + (role==='user'?'bg-blue-100 text-blue-600':'bg-slate-800 text-white') + '">' + (role==='user'?'👤':'🤖') + '</div>' +
    '<div class="p-3 rounded-lg text-sm max-w-[85%] whitespace-pre-wrap leading-relaxed msg-body ' + (role==='user'?'bg-blue-600 text-white rounded-tr-none shadow-sm':'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-tl-none shadow-sm') + '">' + (content||'') + '</div>';
  c.appendChild(d); c.scrollTop = c.scrollHeight; return d;
}
function sendQuickMsg(m, contextFile) { pendingContextFile = contextFile || null; document.getElementById('chatInput').value = m; sendMessage(); }
// 智能归类：让 AI 分析文件组织并用 batch_operations 提交一个待审批的整理方案（依赖 Phase 2 写工具）。
function doSmartClassify() {
  if (!CAPABILITIES.ai) { toast(t('web.preview.toolbar.aiNotInstalled'), 'info'); return; }
  if (!CAPABILITIES.mcp) { toast(t('web.preview.toolbar.classifyNeedsMCP'), 'info'); return; }
  sendQuickMsg(t('web.preview.toolbar.classifyPrompt'));
}

// Queue
async function loadTasks() {
  var list = document.getElementById('queueList');
  try {
    var r = await fetch('/api/queue/status?project_id=' + pid); var tasks = await r.json();
    var pending = tasks.filter(function(t){ return t.status === 'pending'; });
    document.getElementById('pendingCount').textContent = pending.length;
    var b = document.getElementById('pendingBadge'); b.textContent = pending.length; b.classList.toggle('hidden', pending.length === 0);
    if (!tasks.length) { list.innerHTML = '<div class="text-center py-16 text-slate-400 text-sm flex flex-col items-center gap-2">✅<br>' + t('web.preview.queue.empty') + '</div>'; return; }
    var tl = {write_file:t('web.preview.queue.type.writeFile'),create_folder:t('web.preview.queue.type.createFolder'),move_file:t('web.preview.queue.type.moveFile'),delete_file:t('web.preview.queue.type.deleteFile'),batch_operations:t('web.preview.queue.type.batchOperations')};
    var tc = {write_file:'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',create_folder:'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',move_file:'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',delete_file:'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',batch_operations:'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'};
    list.innerHTML = tasks.map(function(t){
      var label = tl[t.operation_type]||t.operation_type, tcl = tc[t.operation_type]||'bg-slate-100 text-slate-700';
      var isP = t.status==='pending', isX = t.status==='executing', isE = t.status==='executed', isR = t.status==='rejected';
      var borderCls = isE?'border-emerald-200 bg-emerald-50/50':isR?'border-slate-200 bg-slate-50 opacity-60':isX?'border-blue-300 ring-2 ring-blue-100':'border-slate-200 hover:border-blue-300';
      var stHtml = isP?'<div class="flex gap-1"><button onclick="approveTask(\''+t.id+'\')" class="p-1 text-green-600 hover:bg-green-100 rounded">✅</button><button onclick="rejectTask(\''+t.id+'\')" class="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded">✕</button></div>':isX?'<span class="text-xs font-bold text-blue-600">' + t('web.preview.task.executing') + '</span>':isE?'<span class="text-xs font-bold text-emerald-600">' + t('web.preview.task.executed') + '</span>':'<span class="text-xs font-bold text-slate-400">' + t('web.preview.task.rejected') + '</span>';
      var d = typeof t.operation_data==='string'?JSON.parse(t.operation_data):t.operation_data;
      var pi = ''; if (d.file_path) pi+='<div>📄 '+esc(d.file_path)+'</div>'; if (d.folder_path) pi+='<div>📁 '+esc(d.folder_path)+'</div>'; if (d.source) pi+='<div class="opacity-70 line-through">'+esc(d.source)+'</div>'; if (d.target) pi+='<div class="text-blue-700">→ '+esc(d.target)+'</div>';
      return '<div class="bg-white dark:bg-slate-800 border rounded-lg p-3 shadow-sm relative overflow-hidden '+borderCls+' '+(isX?'dark:border-blue-700':'dark:border-slate-700')+'">'+(isX?'<div class="absolute top-0 left-0 h-1 bg-blue-500 w-full" style="animation:pulse 1s infinite"></div>':'')+'<div class="flex items-start justify-between mb-2"><div class="flex items-center gap-1.5 text-xs font-semibold"><span class="'+tcl+' px-1.5 py-0.5 rounded text-[10px] font-bold">'+label+'</span></div>'+stHtml+'</div><div class="text-[11px] text-slate-600 dark:text-slate-400 space-y-1 font-mono bg-slate-50 dark:bg-slate-900 p-2 rounded border">'+ (pi||JSON.stringify(d)) +'</div></div>';
    }).join('');
  } catch(e) { list.innerHTML = '<div class="text-center py-8 text-red-400 text-xs">' + t('web.preview.loadFailed') + '</div>'; }
}
async function approveTask(id) { await fetch('/api/queue/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task_id:id})}); loadTasks(); }
async function rejectTask(id) { await fetch('/api/queue/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task_id:id})}); loadTasks(); }
async function approveAll() { var r = await fetch('/api/queue/status?project_id='+pid); var tasks = await r.json(); for (var i=0; i<tasks.length; i++) { if (tasks[i].status==='pending') await approveTask(tasks[i].id); } }
async function rejectAll() { var r = await fetch('/api/queue/status?project_id='+pid); var tasks = await r.json(); for (var i=0; i<tasks.length; i++) { if (tasks[i].status==='pending') await rejectTask(tasks[i].id); } }

// ── PDF Fullscreen ──
window.togglePdfFullscreen = function () {
  var el = document.getElementById('pdfContainer');
  if (!el) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    el.requestFullscreen().catch(function () {});
  }
};
var _pdfFsOriginals = null;
document.addEventListener('fullscreenchange', function () {
  var el = document.getElementById('pdfContainer');
  if (!el) return;
  if (document.fullscreenElement === el) {
    _pdfFsOriginals = { position: el.style.position, inset: el.style.inset, zIndex: el.style.zIndex, background: el.style.background, borderRadius: el.style.borderRadius, minHeight: el.style.minHeight, padding: el.style.padding };
    el.style.position = 'fixed'; el.style.inset = '0'; el.style.zIndex = '100';
    el.style.background = '#525659'; el.style.borderRadius = '0'; el.style.minHeight = '100vh'; el.style.padding = '16px';
  } else if (!document.fullscreenElement && _pdfFsOriginals) {
    for (var k in _pdfFsOriginals) { el.style[k] = _pdfFsOriginals[k]; }
    _pdfFsOriginals = null;
  }
});

// HTML preview toggle
var _htmlPreviewRawUrl = '';
window.toggleHtmlPreview = function () {
  var codeView = document.getElementById('htmlCodeView');
  var preview = document.getElementById('htmlPreview');
  var btn = document.getElementById('htmlToggleBtn');
  if (!codeView || !preview) return;
  if (preview.style.display === 'none') {
    codeView.style.display = 'none';
    preview.style.display = 'block';
    if (btn) btn.innerHTML = t('web.preview.htmlToggle.code');
  } else {
    codeView.style.display = 'block';
    preview.style.display = 'none';
    if (btn) btn.innerHTML = t('web.preview.htmlToggle.preview');
  }
};
window.toggleHtmlPreviewFullscreen = function () {
  var el = document.getElementById('htmlPreviewContainer');
  if (!el) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    el.requestFullscreen().catch(function () {});
  }
};
var _htmlFsOriginals = null;
document.addEventListener('fullscreenchange', function () {
  var el = document.getElementById('htmlPreviewContainer');
  if (!el) return;
  if (document.fullscreenElement === el) {
    _htmlFsOriginals = { position: el.style.position, inset: el.style.inset, zIndex: el.style.zIndex, background: el.style.background, minHeight: el.style.minHeight, padding: el.style.padding };
    el.style.position = 'fixed'; el.style.inset = '0'; el.style.zIndex = '100';
    el.style.background = '#fff'; el.style.minHeight = '100vh'; el.style.padding = '16px';
  } else if (!document.fullscreenElement && _htmlFsOriginals) {
    for (var k in _htmlFsOriginals) { el.style[k] = _htmlFsOriginals[k]; }
    _htmlFsOriginals = null;
  }
});

// PDF preview now uses browser-native <iframe> — no PDF.js dependency

//══════════ Office Docs Rendering (DOCX/XLSX) ══════════
function renderOfficeDoc(d, targetEl, path) {
  if (d.type === 'docx') renderDocx(d, targetEl, path);
  else if (d.type === 'xlsx') renderXlsx(d, targetEl, path);
}

function renderDocx(d, area, path) {
  loadMammoth(function() {
    fetch(d.rawUrl).then(function(r){ return r.arrayBuffer(); }).then(function(buf) {
      mammoth.convertToHtml({ arrayBuffer: buf }).then(function(result) {
        var html = '<div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 p-8 sm:p-12 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700"><div class="doc-content text-slate-700 dark:text-slate-300" id="docContent">' + result.value + '</div></div>';
        area.innerHTML = '<div class="p-4 sm:p-10">' + html + '</div>';
        if (result.warnings.length) console.warn('DOCX warnings:', result.warnings);
        if (activeTabPath === path) { refreshOutline(); setTimeout(highlightCode, 60); }
      }).catch(function() { area.innerHTML = '<div class="h-full flex items-center justify-center text-slate-400">' + t('web.preview.office.docxFailed') + '</div>'; });
    });
  });
}

function renderXlsx(d, area, path) {
  if (typeof XLSX === 'undefined') {
    var s = document.createElement('script');
    s.src = vsrc('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.mini.min.js');
    s.onload = function(){ renderXlsx(d, area, path); };
    document.head.appendChild(s);
    area.innerHTML = '<div class="h-full flex items-center justify-center"><div class="text-sm text-slate-500">' + t('web.preview.office.loadingXlsx') + '</div></div>';
    return;
  }
  fetch(d.rawUrl).then(function(r){ return r.arrayBuffer(); }).then(function(buf) {
    var wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    var tabsHtml = '<div class="flex gap-1 mb-4 flex-wrap" id="xlsxTabs">';
    wb.SheetNames.forEach(function(name, i) {
      tabsHtml += '<button onclick="switchXlsxSheet(\'' + escAttr(name) + '\')" class="xlsx-tab px-3 py-1 text-xs rounded-t-md border ' + (i===0?'bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 font-semibold':'bg-slate-100 dark:bg-slate-800 text-slate-500') + '" data-sheet="' + escAttr(name) + '">' + esc(name) + '</button>';
    });
    tabsHtml += '</div>';
    var sheetsHtml = '';
    wb.SheetNames.forEach(function(name, i) {
      var html = XLSX.utils.sheet_to_html(wb.Sheets[name]);
      sheetsHtml += '<div class="xlsx-sheet ' + (i===0?'':'hidden') + '" data-sheet="' + escAttr(name) + '"><div class="overflow-x-auto">' + html + '</div></div>';
    });
    area.innerHTML = '<div class="p-2 sm:p-4"><div class="max-w-full mx-auto bg-white dark:bg-slate-800 p-4 sm:p-6 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700">' + tabsHtml + sheetsHtml + '</div></div>';
  }).catch(function(){ area.innerHTML = '<div class="h-full flex items-center justify-center text-slate-400">' + t('web.preview.office.xlsxFailed') + '</div>'; });
}

function switchXlsxSheet(name) {
  document.querySelectorAll('.xlsx-sheet').forEach(function(el){ el.classList.toggle('hidden', el.dataset.sheet !== name); });
  document.querySelectorAll('.xlsx-tab').forEach(function(el){
    var active = el.dataset.sheet === name;
    el.className = 'xlsx-tab px-3 py-1 text-xs rounded-t-md border ' + (active?'bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 font-semibold':'bg-slate-100 dark:bg-slate-800 text-slate-500');
  });
}

function loadMammoth(cb) {
  if (typeof mammoth !== 'undefined') { cb(); return; }
  var s = document.createElement('script');
  s.src = vsrc('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js');
  s.onload = cb;
  document.head.appendChild(s);
}

//══════════ Image Lightbox ══════════
function openImageLightbox(url, filePath) {
  getSiblingImages(filePath).then(function(siblings) {
    var overlay = document.createElement('div');
    overlay.id = 'imageLightbox';
    overlay.className = 'fixed inset-0 z-[300] bg-black/90 flex items-center justify-center';
    overlay.innerHTML = '<div class="relative w-full h-full flex flex-col items-center justify-center">' +
      '<img src="' + url + '" class="max-w-[95vw] max-h-[85vh] object-contain transition-transform duration-200" id="lightboxImg">' +
      '<div class="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur rounded-full px-4 py-2 text-white text-sm">' +
      '<button onclick="lightboxZoom(-0.25)" class="w-8 h-8 rounded-full hover:bg-white/20 flex items-center justify-center">−</button>' +
      '<span class="w-12 text-center" id="lightboxZoomPct">100%</span>' +
      '<button onclick="lightboxZoom(0.25)" class="w-8 h-8 rounded-full hover:bg-white/20 flex items-center justify-center">+</button>' +
      '<span class="mx-2">|</span>' +
      '<button onclick="lightboxNav(-1)" class="w-8 h-8 rounded-full hover:bg-white/20 ' + (siblings.length>1?'':'opacity-30') + '">◀</button>' +
      '<span class="text-xs w-20 text-center" id="lightboxCount"></span>' +
      '<button onclick="lightboxNav(1)" class="w-8 h-8 rounded-full hover:bg-white/20 ' + (siblings.length>1?'':'opacity-30') + '">▶</button>' +
      '<span class="mx-2">|</span>' +
      '<button onclick="closeLightbox()" class="w-8 h-8 rounded-full hover:bg-white/20 flex items-center justify-center">✕</button>' +
      '</div></div>';
    document.body.appendChild(overlay);

    window._lightboxSiblings = siblings;
    window._lightboxIdx = siblings.findIndex(function(s){ return s.path === filePath; });
    window._lightboxZoom = 1;
    updateLightboxCount();
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeLightbox(); });
    document.addEventListener('keydown', lightboxKeyHandler);
  });
}

function closeLightbox() {
  var el = document.getElementById('imageLightbox');
  if (el) el.remove();
  document.removeEventListener('keydown', lightboxKeyHandler);
}

function lightboxZoom(delta) {
  window._lightboxZoom = Math.max(0.25, Math.min(5, (window._lightboxZoom||1) + delta));
  document.getElementById('lightboxImg').style.transform = 'scale(' + window._lightboxZoom + ')';
  document.getElementById('lightboxZoomPct').textContent = Math.round(window._lightboxZoom*100)+'%';
}

function lightboxNav(dir) {
  var sibs = window._lightboxSiblings;
  if (!sibs || sibs.length<2) return;
  window._lightboxIdx = (window._lightboxIdx + dir + sibs.length) % sibs.length;
  var next = sibs[window._lightboxIdx];
  document.getElementById('lightboxImg').src = '/api/raw/' + pid + '?path=' + encodeURIComponent(next.path);
  document.getElementById('lightboxImg').style.transform = 'scale(1)';
  window._lightboxZoom = 1;
  document.getElementById('lightboxZoomPct').textContent = '100%';
  updateLightboxCount();
  currentFile = next.path;
  renderBreadcrumb(next.path);
}

function updateLightboxCount() {
  var el = document.getElementById('lightboxCount');
  if (el) el.textContent = (window._lightboxIdx+1) + ' / ' + (window._lightboxSiblings||[]).length;
}

function lightboxKeyHandler(e) {
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lightboxNav(-1);
  if (e.key === 'ArrowRight') lightboxNav(1);
}

// Sibling image detection
function getSiblingImages(filePath) {
  var parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
  var imgExts = ['.png','.jpg','.jpeg','.gif','.svg','.webp','.avif','.bmp','.ico'];
  return fetch('/api/tree/' + pid + '?path=' + encodeURIComponent(parentDir||''))
    .then(function(r){ return r.json(); })
    .then(function(d) {
      var images = d.entries.filter(function(e){ return e.type==='file' && imgExts.some(function(ext){ return e.name.toLowerCase().endsWith(ext); }); });
      images.sort(function(a,b){ return a.name.localeCompare(b.name, window.__doc77_lang || 'zh-CN'); });
      return images.map(function(e){ return { name:e.name, path: (parentDir ? parentDir+'/' : '') + e.name }; });
    })
    .catch(function(){ return []; });
}

//══════════ Code Execution (Live Preview) ══════════
function runCode() {
  var runBtn = document.getElementById('runBtn');
  var lang = runBtn.dataset.lang;
  var code = (document.getElementById('docContent') || {}).textContent || runBtn.dataset.code || '';
  if (!code.trim()) { toast(t('web.preview.codeRun.noCode'),'error'); return; }

  var area = document.querySelector('#docPaneHost .doc-pane') || document.getElementById('contentArea');
  var existing = document.getElementById('codeOutput');
  if (existing) existing.remove();

  var outputDiv = document.createElement('div');
  outputDiv.id = 'codeOutput';
  outputDiv.className = 'max-w-4xl mx-auto mt-4 bg-slate-900 dark:bg-black border border-slate-700 rounded-xl overflow-hidden';
  outputDiv.innerHTML = '<div class="flex items-center justify-between px-4 py-2 bg-slate-800 dark:bg-slate-950 border-b border-slate-700 text-xs text-slate-300">' +
    '<span>' + t('web.preview.codeRun.output') + '</span><span class="text-slate-500" id="codeOutputLang">' + lang + '</span>' +
    '<button onclick="document.getElementById(\'codeOutput\').remove()" class="text-slate-400 hover:text-white">✕</button></div>' +
    '<div class="p-4 font-mono text-sm text-emerald-400 whitespace-pre-wrap max-h-80 overflow-y-auto" id="codeOutputText">' + t('web.preview.codeRun.running') + '</div>';
  area.appendChild(outputDiv);
  outputDiv.scrollIntoView({ behavior: 'smooth' });

  if (lang === 'js') runJS(code);
  else if (lang === 'py') runPython(code);
}

function runJS(code) {
  var output = [];
  var iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts';
  iframe.style.display = 'none';
  document.body.appendChild(iframe);

  try {
    iframe.contentWindow.console = { log: function() { for (var i=0;i<arguments.length;i++) output.push(String(arguments[i])); } };
    var scriptEl = iframe.contentDocument.createElement('script');
    scriptEl.textContent = 'try {\n' + code + '\n} catch(e) { console.log("Error: " + e.message); }';
    iframe.contentDocument.body.appendChild(scriptEl);
    setTimeout(function() {
      document.getElementById('codeOutputText').textContent = output.join('\n') || t('web.preview.codeRun.noOutput');
      document.body.removeChild(iframe);
    }, 500);
  } catch(e) {
    document.getElementById('codeOutputText').textContent = 'Error: ' + e.message;
    document.body.removeChild(iframe);
  }
}

function runPython(code) {
  var outEl = document.getElementById('codeOutputText');
  initPyodide(function(pyodide) {
    try {
      pyodide.runPython('import sys\nfrom io import StringIO\nsys.stdout = StringIO()');
      pyodide.runPython(code);
      var stdout = pyodide.runPython('sys.stdout.getvalue()');
      outEl.textContent = stdout || t('web.preview.codeRun.noOutput');
    } catch(e) {
      outEl.textContent = 'Python Error: ' + e.message;
    }
  });
}

// Initialize Pyodide: lazy-load CDN if needed, then call callback with pyodide instance
function initPyodide(cb) {
  if (window._pyodide) { cb(window._pyodide); return; }
  var outEl = document.getElementById('codeOutputText');
  if (outEl) outEl.textContent = t('web.preview.codeRun.loadingPyodide');
  var pyodideUrl = window.__VENDOR_READY ? '/vendor/' : 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/';

  // Check if the Pyodide CDN has already loaded its global init function
  if (typeof window.loadPyodide === 'function') {
    window.loadPyodide({ indexURL: pyodideUrl }).then(function(py) {
      window._pyodide = py; cb(py);
    });
  } else {
    var s = document.createElement('script');
    s.src = pyodideUrl + 'pyodide.js';
    s.onload = function() {
      window.loadPyodide({ indexURL: pyodideUrl }).then(function(py) {
        window._pyodide = py; cb(py);
      });
    };
    s.onerror = function() {
      var el = document.getElementById('codeOutputText');
      if (el) el.textContent = t('web.preview.codeRun.pyodideError');
    };
    document.head.appendChild(s);
  }
}

//══════════ Temp file drag & drop (stateless preview) ══════════

/** Open a dropped File as a temp tab (no disk write). */
async function openTempTab(file) {
  var filename = file.name;
  var classification = TempPreview.classifyTempFile(filename);
  var tempPath = TempPreview.makeTempPath(filename);

  if (classification === 'unsupported') {
    tabDataCache[tempPath] = { path: filename, type: 'unsupported', category: 'unknown', size: file.size, temp: true };
    openTab(tempPath);
    return;
  }

  if (classification === 'binary-preview') {
    var objectUrl = URL.createObjectURL(file);
    var ext = '.' + filename.split('.').pop().toLowerCase();
    if (ext === '.pdf') {
      tabDataCache[tempPath] = { path: filename, type: 'pdf', rawUrl: objectUrl, objectUrl: objectUrl, size: file.size, temp: true };
    } else if (ext === '.docx' || ext === '.xlsx') {
      tabDataCache[tempPath] = { path: filename, type: ext.slice(1), rawUrl: objectUrl, objectUrl: objectUrl, size: file.size, temp: true };
    } else {
      // Image
      tabDataCache[tempPath] = { path: filename, type: 'image', rawUrl: objectUrl, objectUrl: objectUrl, size: file.size, temp: true };
    }
    openTab(tempPath);
    return;
  }

  // classification === 'text-render'
  // Size gate: skip POST for files > 4 MB
  if (file.size > TempPreview.TEMP_TEXT_LIMIT) {
    tabDataCache[tempPath] = { path: filename, type: 'unsupported', category: 'too_large', size: file.size, temp: true };
    openTab(tempPath);
    return;
  }

  try {
    var content = await file.text();
  } catch (e) {
    // Binary sniff failed: show unsupported
    tabDataCache[tempPath] = { path: filename, type: 'unsupported', category: 'binary', size: file.size, temp: true };
    openTab(tempPath);
    return;
  }

  // POST to stateless render endpoint
  try {
    var res = await fetch('/api/render-temp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: filename, content: content }),
    });
    if (!res.ok) {
      // Fallback: show raw text
      tabDataCache[tempPath] = { path: filename, type: 'text', content: content, size: file.size, temp: true };
      openTab(tempPath);
      return;
    }
    var data = await res.json();
    data.temp = true;
    if (!data.path) data.path = filename;
    tabDataCache[tempPath] = data;
  } catch (e) {
    tabDataCache[tempPath] = { path: filename, type: 'text', content: content, size: file.size, temp: true };
  }
  openTab(tempPath);
}

/** Initialize drag-and-drop zone: document-level events + overlay. */
function initDropZone() {
  var overlay = document.getElementById('dropOverlay');
  if (!overlay) return;
  var dragDepth = 0;

  document.addEventListener('dragenter', function(e) {
    if (!e.dataTransfer || !e.dataTransfer.types || !e.dataTransfer.types.indexOf('Files') >= 0) return;
    dragDepth++;
    if (dragDepth === 1) overlay.classList.remove('hidden');
  });

  document.addEventListener('dragover', function(e) {
    if (!e.dataTransfer || !e.dataTransfer.types || e.dataTransfer.types.indexOf('Files') < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', function(e) {
    if (!e.dataTransfer || !e.dataTransfer.types || e.dataTransfer.types.indexOf('Files') < 0) return;
    dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; overlay.classList.add('hidden'); }
  });

  document.addEventListener('drop', function(e) {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;

    var count = files.length;
    var fileArray = [];
    for (var i = 0; i < files.length; i++) { fileArray.push(files[i]); }

    // Serial open to respect maxTabs=8
    (async function() {
      for (var j = 0; j < fileArray.length; j++) {
        try { await openTempTab(fileArray[j]); } catch (err) { console.error('[drop]', err); }
      }
      if (count > 1) {
        showToast(t('web.preview.drop.filesDropped', {count: count}), 'info');
      }
    })();
  });
}

// Boot drop zone
if (typeof TempPreview !== 'undefined') {
  initDropZone();
}

/**
 * Doc77 Preview JS — 预览页（preview.html）专用
 * 包含: File tree, Content, TTS, Auto-scroll, AI Summary,
 *        Reading progress, Recent files, Bookmarks, Search, Outline, Chat, Queue
 */

//══════════ Data ══════════
var pid = new URLSearchParams(location.search).get('id');
if (!pid) location.href = '/';
var proj = null, projects = [], currentFile = null, activeTab = 'outline';

(async function boot() {
  try {
    var r = await fetch('/api/projects');
    projects = await r.json();
    proj = projects.find(function(p) { return p.id === parseInt(pid); });
    if (!proj) { toast('项目未找到','error'); location.href='/'; return; }
    document.getElementById('projName').textContent = '💼 ' + proj.name;
    document.title = 'Doc77 — ' + proj.name;
    renderProjMenu(); loadTree(''); loadTasks(); setActiveTab('outline');
    renderBookmarks(); renderRecentFiles();
    // Touch project's last_opened
    fetch('/api/projects/' + pid + '/touch', { method: 'POST' }).catch(function(){});
  } catch(e) { document.getElementById('projName').textContent = '⚠ 加载失败'; }
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
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  var filtered = filter ? sorted.filter(function(p) { return p.name.toLowerCase().indexOf(filter) >= 0 || p.path.toLowerCase().indexOf(filter) >= 0; }) : sorted;
  var items = filtered.map(function(p) {
    return '<button onclick="switchProject(' + p.id + ')" class="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 flex flex-col transition-colors"><span class="font-medium">' + (p.id===proj.id?'✓ ':'') + '💼 ' + esc(p.name) + '</span><span class="text-xs text-slate-500 truncate">' + esc(p.path) + '</span></button>';
  }).join('');
  if (!items) items = '<div class="px-3 py-2 text-xs text-slate-500">没有匹配的项目</div>';
  document.getElementById('projMenu').innerHTML =
    '<div class="px-2 pt-2 pb-1 sticky top-0 bg-slate-800 z-10"><div class="relative"><span class="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs">🔍</span><input id="projSearch" placeholder="搜索项目..." oninput="renderProjMenu(this.value)" class="w-full bg-slate-700 border border-slate-600 rounded-md pl-7 pr-2 py-1.5 text-xs text-slate-200 outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-slate-500"></div></div>' +
    '<div class="max-h-72 overflow-y-auto scrollbar-dark">' + items + '</div>' +
    '<div class="h-px bg-slate-700 my-1"></div><a href="/" class="block w-full text-left px-3 py-2 text-sm text-blue-400 hover:bg-slate-700 transition-colors">＋ 注册新项目</a>';
}
function switchProject(id) { location.href = '/preview.html?id=' + id; }

//══════════ Panels ══════════
function togglePanel(side) {
  var panel = document.getElementById(side === 'left' ? 'leftPanel' : 'rightPanel');
  var h = panel.classList.toggle('hidden');
  if (side === 'left') {
    document.getElementById('showLeftBtn').classList.toggle('hidden', !h);
  } else {
    var capsule = document.getElementById('capsuleBtn');
    var icon = document.getElementById('capsuleIcon');
    if (h) { capsule.style.right = '16px'; capsule.title = '展开面板'; }
    else { capsule.style.right = (parseInt(panel.style.width) || 320) - 4 + 'px'; capsule.title = '收起面板'; }
    icon.textContent = h ? '◀' : '▶';
  }
}
// Panel drag resize
(function(){
  var r = false, t = null;
  document.querySelectorAll('.cursor-col-resize').forEach(function(h, i) {
    h.addEventListener('mousedown', function(e) { r = true; t = i === 0 ? 'left' : 'right'; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
  });
  document.addEventListener('mousemove', function(e) {
    if (!r) return;
    if (t === 'left') { document.getElementById('leftPanel').style.width = Math.max(200, Math.min(500, e.clientX)) + 'px'; }
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
    if (!fld.length && !fls.length) tree.innerHTML = '<div class="text-center py-4 text-slate-500 text-xs">空目录</div>';
  } catch(e) { tree.innerHTML = '<div class="text-center py-4 text-red-400 text-xs">加载失败</div>'; }
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
    '<span class="truncate flex-1">' + entry.name + '</span>' +
    (entry.size ? '<span class="text-[10px] text-slate-500 shrink-0">' + fmtSize(entry.size) + '</span>' : '');
  frag.appendChild(row);

  if (isDir) {
    var wrapper = document.createElement('div'); wrapper.className = 'ml-4 hidden';
    var loaded = false;
    row.addEventListener('click', function(e) {
      e.stopPropagation();
      if (wrapper.classList.contains('hidden')) {
        if (!loaded) {
          wrapper.classList.remove('hidden'); wrapper.innerHTML = '<div class="text-slate-500 text-xs py-1 pl-2">加载中...</div>';
          fetch('/api/tree/' + pid + '?path=' + encodeURIComponent(childPath)).then(function(r) { return r.json(); }).then(function(d) {
            wrapper.innerHTML = '';
            var f = d.entries.filter(function(e){ return e.type === 'directory'; });
            var l = d.entries.filter(function(e){ return e.type === 'file'; });
            if (!f.length && !l.length) wrapper.innerHTML = '<div class="text-slate-600 text-xs py-1 pl-2">空目录</div>';
            else f.concat(l).forEach(function(e) { wrapper.appendChild(makeNode(e, childPath)); });
            var cb = document.createElement('div');
            cb.className = 'tree-collapse-btn text-[10px] text-slate-500 hover:text-slate-300 cursor-pointer py-1 pl-2 select-none';
            cb.textContent = '🔼 收起此目录';
            cb.onclick = function(ev) { ev.stopPropagation(); wrapper.classList.add('hidden'); row.querySelector('span').textContent = '▸'; };
            wrapper.appendChild(cb);
            loaded = true;
          }).catch(function() { wrapper.innerHTML = '<div class="text-red-400 text-xs py-1 pl-2">加载失败</div>'; });
        } else { wrapper.classList.remove('hidden'); }
        row.querySelector('span').textContent = '▾';
      } else { wrapper.classList.add('hidden'); row.querySelector('span').textContent = '▸'; }
    });
    frag.appendChild(wrapper);
  } else {
    row.addEventListener('click', function() {
      document.querySelectorAll('#tree .active-node').forEach(function(el) { el.classList.remove('active-node','bg-blue-600','text-white'); });
      row.classList.add('active-node','bg-blue-600','text-white');
      loadContent(childPath);
    });
    row.addEventListener('contextmenu', function(e) { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, childPath); });
  }
  return frag;
}

function iconFor(n) { var e = n.split('.').pop().toLowerCase(); return ['md','markdown'].indexOf(e)>=0?'📝':['mermaid','mmd'].indexOf(e)>=0?'📊':e==='pdf'?'📕':['png','jpg','jpeg','gif','svg','webp','bmp'].indexOf(e)>=0?'🖼':['ts','js','py','rb','go','rs','java','c','cpp'].indexOf(e)>=0?'💻':['json','yaml','yml','toml'].indexOf(e)>=0?'⚙':'📄'; }

//══════════ Content ══════════
async function loadContent(filePath) {
  currentFile = filePath; outlineBuilt = false;
  var empty = document.getElementById('emptyState'); if (empty) empty.classList.add('hidden');
  var area = document.getElementById('contentArea');
  var btns = ['aiBtn','editBtn','revealBtn','ttsBtn','autoScrollBtn','docSearchBtn'];
  var runBtn = document.getElementById('runBtn'); if (runBtn) runBtn.disabled = true;
  area.innerHTML = '<div class="h-full flex items-center justify-center"><div class="skeleton h-4 w-48"></div></div>';
  document.getElementById('breadcrumbPath').textContent = filePath;
  btns.forEach(function(id){ document.getElementById(id).disabled = false; });
  document.getElementById('readingProgress').style.width = '0%';
  try {
    var r = await fetch('/api/content/' + pid + '?path=' + encodeURIComponent(filePath));
    if (!r.ok) throw new Error('Not found');
    var d = await r.json(); var html = '';

    // --- Unsupported format: file info card ---
    if (d.type === 'unsupported') {
      var labels = { video:'🎬 视频', audio:'🎵 音频', archive:'📦 压缩包', font:'🔤 字体',
        database:'🗄 数据库', design:'🎨 设计文件', binary:'⚙ 二进制', gis:'🗺 GIS数据',
        '3d':'🧊 3D模型', ebook:'📚 电子书', document:'📄 文档', spreadsheet:'📊 表格',
        presentation:'📽 演示文稿', too_large:'📦 文件过大', unknown:'📁 未知格式' };
      var label = labels[d.category] || labels.unknown;
      var sizeStr = d.size < 1024 ? d.size + ' B' : d.size < 1048576 ? (d.size/1024).toFixed(1) + ' KB' : (d.size/1048576).toFixed(1) + ' MB';
      html = '<div class="max-w-md mx-auto bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8 text-center">' +
        '<div class="text-5xl mb-4">' + label.split(' ')[0] + '</div>' +
        '<h3 class="text-lg font-bold text-slate-800 dark:text-slate-100 mb-2">' + label + '</h3>' +
        '<p class="text-sm text-slate-500 dark:text-slate-400 mb-4">' + esc(filePath) + '</p>' +
        '<div class="grid grid-cols-2 gap-2 bg-slate-50 dark:bg-slate-900 rounded-lg p-3 mb-4 text-xs text-left">' +
        '<span class="text-slate-500">大小</span><span class="text-slate-700 dark:text-slate-300">' + sizeStr + '</span>' +
        (d.modified ? '<span class="text-slate-500">修改时间</span><span class="text-slate-700 dark:text-slate-300">' + new Date(d.modified).toLocaleString('zh-CN') + '</span>' : '') +
        '</div>' +
        '<p class="text-xs text-amber-600 dark:text-amber-400 mb-4">⚠️ 不支持预览此文件格式</p>' +
        '<button onclick="revealFile(\'reveal\')" class="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors">📂 文件夹中显示</button>' +
        '</div>';
      area.innerHTML = '<div class="p-4 sm:p-10">' + html + '</div>';
      addRecentFile(filePath);
      return;
    }

    if (d.type === 'markdown' || d.type === 'mermaid' || d.type === 'code') {
      html = '<div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 p-8 sm:p-12 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700"><div class="doc-content text-slate-700 dark:text-slate-300" id="docContent">' + d.content + '</div></div>';
      if (d.type === 'markdown') setTimeout(function(){ buildOutline(); }, 50);
    } else if (d.type === 'image') {
      html = '<div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 p-4 sm:p-8 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 text-center"><img src="' + d.rawUrl + '" alt="' + esc(filePath) + '" class="max-w-full max-h-[80vh] object-contain rounded-md shadow-sm cursor-pointer hover:opacity-90 transition-opacity" loading="lazy" onclick="openImageLightbox(\'' + escAttr(d.rawUrl) + '\', \'' + escAttr(filePath) + '\')" /></div>';
    } else if (d.type === 'pdf') {
      // Use custom PDF.js viewer if available, fallback to iframe
      if (typeof pdfjsLib !== 'undefined') {
        area.innerHTML = '<div class="h-full flex items-center justify-center"><div class="text-sm text-slate-500">正在加载 PDF 查看器...</div></div>';
        loadPdfViewer(d.rawUrl, filePath); return;
      }
      // Lazy-load PDF.js then retry
      loadPdfJs(function() {
        area.innerHTML = '<div class="h-full flex items-center justify-center"><div class="text-sm text-slate-500">正在渲染 PDF...</div></div>';
        loadPdfViewer(d.rawUrl, filePath);
      });
      return;
    } else if (d.type === 'docx' || d.type === 'xlsx') {
      // Fetch raw binary and render client-side
      area.innerHTML = '<div class="h-full flex items-center justify-center"><div class="text-sm text-slate-500">加载中...</div></div>';
      renderOfficeDoc(d); return;
    } else {
      html = '<div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 p-8 sm:p-12 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700"><pre class="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-mono">' + esc(d.content) + '</pre></div>';
      document.getElementById('outlineList').innerHTML = '<div class="text-center py-12 text-slate-400 dark:text-slate-500 text-xs">仅 Markdown 文档支持大纲</div>';
      outlineBuilt = true;
    }
    area.innerHTML = '<div class="p-4 sm:p-10">' + html + '</div>';
    updateReadingTime(d);
    setTimeout(highlightCode, 100);
    addRecentFile(filePath);
  } catch(e) { area.innerHTML = '<div class="h-full flex flex-col items-center justify-center text-slate-400 gap-2"><span class="text-4xl">⚠️</span><p class="text-sm">文件加载失败</p></div>'; }
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
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
  s.onload = highlightCode;
  document.head.appendChild(s);
}

// Feature 2: Reading Time
function updateReadingTime(d) {
  var el = document.getElementById('readTime');
  if (d.type === 'image' || d.type === 'pdf') { el.classList.add('hidden'); return; }
  var text = d.content || '';
  var chars = text.replace(/<[^>]*>/g,'').length;
  var mins = Math.max(1, Math.round(chars / 400));
  el.textContent = '约 ' + mins + ' 分钟';
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
}
function renderRecentFiles() {
  var rf = getRecentFiles().filter(function(f) { return f.pid == pid; });
  var el = document.getElementById('recentList');
  if (!rf.length) { el.innerHTML = '<div class="text-slate-600 text-xs px-1">暂无</div>'; return; }
  el.innerHTML = rf.map(function(f) {
    return '<div onclick="loadContent(\'' + escAttr(f.path) + '\')" class="flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer hover:bg-slate-800 text-slate-300 truncate text-xs"><span>📄</span><span class="truncate">' + esc(f.path) + '</span></div>';
  }).join('');
}

// Feature 4: Reading Progress
function onContentScroll() {
  var a = document.getElementById('contentArea');
  if (!a) return;
  var pct = a.scrollTop / (a.scrollHeight - a.clientHeight) * 100;
  document.getElementById('readingProgress').style.width = Math.min(100, Math.max(0, pct)) + '%';
}

// Feature 5: TTS
var ttsActive = false;
function toggleTTS() {
  if (ttsActive) { window.speechSynthesis.cancel(); ttsActive = false; document.getElementById('ttsBtn').textContent = '🔊'; document.getElementById('ttsRate').classList.add('hidden'); return; }
  var text = (document.getElementById('docContent') || document.querySelector('.doc-content'))?.textContent;
  if (!text) { toast('请先打开文档','error'); return; }
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
  if (!currentFile) { toast('请先打开文档','error'); return; }
  var card = document.getElementById('summaryCard');
  var txt = document.getElementById('summaryText');
  card.classList.remove('hidden'); txt.textContent = '生成中...';
  try {
    var body = JSON.stringify({ message: '请用100字以内简洁总结这个文档的核心内容，文件名：' + currentFile, project_id: parseInt(pid) });
    var res = await fetch('/api/ai/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: body });
    if (!res.ok) { txt.textContent = 'AI 服务不可用，请检查设置'; return; }
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
    if (!summary) txt.textContent = '未能生成摘要';
  } catch(e) { txt.textContent = '生成失败: ' + e.message; }
}
function readSummary() {
  var txt = document.getElementById('summaryText').textContent;
  if (!txt || txt === '生成中...') return;
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
  if (!doc) { document.getElementById('searchCount').textContent = '0 个匹配'; return; }
  // Use TreeWalker to find text nodes, then wrap matches
  highlightInNode(doc, q.toLowerCase());
  var count = document.querySelectorAll('.search-highlight').length;
  document.getElementById('searchCount').textContent = count + ' 个匹配';
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
  rdiv.innerHTML = '<div class="text-xs text-slate-500 px-2 py-1">搜索中...</div>';
  try {
    var res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&project_id=' + pid);
    var d = await res.json();
    if (!d.matches.length) { rdiv.innerHTML = '<div class="text-xs text-slate-500 px-2 py-1">无结果</div>'; return; }
    rdiv.innerHTML = d.matches.slice(0,20).map(function(m) {
      return '<div onclick="loadContent(\'' + escAttr(m.file) + '\')" class="flex flex-col px-2 py-1 rounded cursor-pointer hover:bg-slate-800 text-xs"><span class="text-blue-400 truncate">' + esc(m.file) + ':' + m.line + '</span><span class="text-slate-400 truncate">' + esc(m.content) + '</span></div>';
    }).join('');
  } catch(e) { rdiv.innerHTML = '<div class="text-xs text-red-500 px-2 py-1">搜索失败</div>'; }
}

// Feature 10: Bookmarks
function getBookmarks() { try { return JSON.parse(localStorage.getItem('doc77-bookmarks')||'[]'); } catch(e) { return []; } }
function saveBookmarks(bm) { localStorage.setItem('doc77-bookmarks', JSON.stringify(bm)); }
function addBookmark(filePath) {
  var bm = getBookmarks();
  if (bm.find(function(b){ return b.pid == pid && b.path === filePath; })) { toast('已收藏过此文件','info'); return; }
  bm.unshift({ pid: parseInt(pid), path: filePath, time: Date.now() });
  if (bm.length > 50) bm = bm.slice(0, 50);
  saveBookmarks(bm);
  renderBookmarks();
  toast('已收藏 ⭐','success');
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
  if (!bm.length) { el.innerHTML = '<div class="text-slate-600 text-xs px-1">暂无收藏</div>'; return; }
  el.innerHTML = bm.map(function(b) {
    return '<div class="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-800 group cursor-pointer">' +
      '<span class="truncate flex-1 text-slate-300" onclick="loadContent(\'' + escAttr(b.path) + '\')">⭐ ' + esc(b.path) + '</span>' +
      '<button class="hidden group-hover:block text-slate-500 hover:text-red-400 text-xs" onclick="event.stopPropagation();removeBookmark(\'' + escAttr(b.path) + '\')">✕</button></div>';
  }).join('');
}
// Right-click context menu
function showCtxMenu(x, y, filePath) {
  var m = document.getElementById('ctxMenu');
  m.innerHTML = '<button onclick="addBookmark(\'' + escAttr(filePath) + '\');hideCtxMenu()">⭐ 收藏文件</button>';
  m.style.left = x + 'px'; m.style.top = y + 'px';
  m.classList.remove('hidden');
  setTimeout(function(){ document.addEventListener('click', hideCtxMenu, {once:true}); }, 0);
}
function hideCtxMenu() { document.getElementById('ctxMenu').classList.add('hidden'); }

// Toolbar
function revealFile(action) { if (currentFile) fetch('/api/reveal/' + pid + '?path=' + encodeURIComponent(currentFile) + '&action=' + action).catch(function(){}); }
function openAIChat() { togglePanel('right'); setActiveTab('chat'); if (currentFile) { document.getElementById('ctxBanner').classList.remove('hidden'); document.getElementById('ctxText').textContent = currentFile; sendQuickMsg('请总结当前文档的内容：' + currentFile); } }

// Outline
var outlineHeadings = [], outlineBuilt = false;
function ensureOutlineBuilt() { if (!outlineBuilt) { var doc = document.getElementById('docContent'); if (doc) buildOutline(); } }
function buildOutline() {
  var doc = document.getElementById('docContent'), list = document.getElementById('outlineList');
  if (!doc) { list.innerHTML = '<div class="text-center py-12 text-slate-400 dark:text-slate-500 text-xs">请先打开一个 Markdown 文档</div>'; outlineBuilt = false; return; }
  var headings = doc.querySelectorAll('h1, h2, h3'); outlineHeadings = [];
  headings.forEach(function(h, i) { h.id = 'heading-' + i; outlineHeadings.push({ id: h.id, text: h.textContent||'', level: parseInt(h.tagName[1]) }); });
  if (!outlineHeadings.length) { list.innerHTML = '<div class="text-center py-12 text-slate-400 dark:text-slate-500 text-xs">此文档没有标题</div>'; outlineBuilt = true; return; }
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
document.getElementById('chatInput').addEventListener('input', function(){ document.getElementById('sendBtn').disabled = !this.value.trim(); });

async function sendMessage() {
  var input = document.getElementById('chatInput'), msg = input.value.trim();
  if (!msg) return;
  var wc = document.getElementById('welcomeCard'); if (wc) wc.remove();
  appendChatMsg('user', msg);
  input.value = ''; document.getElementById('sendBtn').disabled = true;
  var aiMsg = appendChatMsg('ai', ''), aiBody = aiMsg.querySelector('.msg-body');
  try {
    var body = JSON.stringify({ message: msg, project_id: parseInt(pid), session_id: chatSessionId || undefined });
    var response = await fetch('/api/ai/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:body });
    if (!response.ok) {
      var errData = await response.json().catch(function(){ return {}; });
      if (errData.error === 'AI_NOT_CONFIGURED') aiBody.innerHTML = '<span class="text-amber-600">⚠️ 请先配置 AI 模型</span> <button onclick="toggleSettings();switchSettingsTab(\'ai\')" class="text-blue-600 underline text-xs">前往设置</button>';
      else aiBody.textContent = '❌ ' + (errData.message||errData.error||'AI 服务不可用');
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
  } catch(e) { if (!aiBody.textContent) aiBody.textContent = '⚠️ 网络连接失败'; }
  document.getElementById('sendBtn').disabled = false;
}
function handleSSE(event, data, aiBody) {
  switch (event) {
    case 'session': chatSessionId = data.session_id; break;
    case 'token': aiBody.textContent += data.text; document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight; break;
    case 'tool_call':
      var ind = document.createElement('div'); ind.className = 'text-xs text-blue-600 dark:text-blue-400 mt-1 flex items-center gap-1';
      ind.innerHTML = '<span>🔍 ' + esc(data.name) + '...</span>'; ind.dataset.tool = data.name; aiBody.appendChild(ind); break;
    case 'done':
      aiBody.querySelectorAll('[data-tool]').forEach(function(el){ el.innerHTML = '<span>✅ 已完成 ' + esc(el.dataset.tool) + '</span>'; el.className = 'text-xs text-green-600 dark:text-green-400 mt-1'; }); break;
    case 'error':
      var ed = document.createElement('div'); ed.className = 'text-xs text-red-500 mt-1'; ed.textContent = '❌ ' + (data.message||'未知错误'); aiBody.appendChild(ed); break;
  }
}
function appendChatMsg(role, content) {
  var c = document.getElementById('chatMessages'), d = document.createElement('div');
  d.className = 'flex gap-3 ' + (role==='user'?'flex-row-reverse':'') + ' animate-in';
  d.innerHTML = '<div class="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs ' + (role==='user'?'bg-blue-100 text-blue-600':'bg-slate-800 text-white') + '">' + (role==='user'?'👤':'🤖') + '</div>' +
    '<div class="p-3 rounded-lg text-sm max-w-[85%] whitespace-pre-wrap leading-relaxed msg-body ' + (role==='user'?'bg-blue-600 text-white rounded-tr-none shadow-sm':'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-tl-none shadow-sm') + '">' + (content||'') + '</div>';
  c.appendChild(d); c.scrollTop = c.scrollHeight; return d;
}
function sendQuickMsg(m) { document.getElementById('chatInput').value = m; sendMessage(); }

// Queue
async function loadTasks() {
  var list = document.getElementById('queueList');
  try {
    var r = await fetch('/api/queue/status?project_id=' + pid); var tasks = await r.json();
    var pending = tasks.filter(function(t){ return t.status === 'pending'; });
    document.getElementById('pendingCount').textContent = pending.length;
    var b = document.getElementById('pendingBadge'); b.textContent = pending.length; b.classList.toggle('hidden', pending.length === 0);
    if (!tasks.length) { list.innerHTML = '<div class="text-center py-16 text-slate-400 text-sm flex flex-col items-center gap-2">✅<br>队列已清空</div>'; return; }
    var tl = {write_file:'写入覆盖',create_folder:'创建目录',move_file:'移动文件',delete_file:'安全删除',batch_operations:'批量操作'};
    var tc = {write_file:'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',create_folder:'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',move_file:'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',delete_file:'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',batch_operations:'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'};
    list.innerHTML = tasks.map(function(t){
      var label = tl[t.operation_type]||t.operation_type, tcl = tc[t.operation_type]||'bg-slate-100 text-slate-700';
      var isP = t.status==='pending', isX = t.status==='executing', isE = t.status==='executed', isR = t.status==='rejected';
      var borderCls = isE?'border-emerald-200 bg-emerald-50/50':isR?'border-slate-200 bg-slate-50 opacity-60':isX?'border-blue-300 ring-2 ring-blue-100':'border-slate-200 hover:border-blue-300';
      var stHtml = isP?'<div class="flex gap-1"><button onclick="approveTask(\''+t.id+'\')" class="p-1 text-green-600 hover:bg-green-100 rounded">✅</button><button onclick="rejectTask(\''+t.id+'\')" class="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded">✕</button></div>':isX?'<span class="text-xs font-bold text-blue-600">⏳ 执行中</span>':isE?'<span class="text-xs font-bold text-emerald-600">✓ 已执行</span>':'<span class="text-xs font-bold text-slate-400">已拒绝</span>';
      var d = typeof t.operation_data==='string'?JSON.parse(t.operation_data):t.operation_data;
      var pi = ''; if (d.file_path) pi+='<div>📄 '+esc(d.file_path)+'</div>'; if (d.folder_path) pi+='<div>📁 '+esc(d.folder_path)+'</div>'; if (d.source) pi+='<div class="opacity-70 line-through">'+esc(d.source)+'</div>'; if (d.target) pi+='<div class="text-blue-700">→ '+esc(d.target)+'</div>';
      return '<div class="bg-white dark:bg-slate-800 border rounded-lg p-3 shadow-sm relative overflow-hidden '+borderCls+' '+(isX?'dark:border-blue-700':'dark:border-slate-700')+'">'+(isX?'<div class="absolute top-0 left-0 h-1 bg-blue-500 w-full" style="animation:pulse 1s infinite"></div>':'')+'<div class="flex items-start justify-between mb-2"><div class="flex items-center gap-1.5 text-xs font-semibold"><span class="'+tcl+' px-1.5 py-0.5 rounded text-[10px] font-bold">'+label+'</span></div>'+stHtml+'</div><div class="text-[11px] text-slate-600 dark:text-slate-400 space-y-1 font-mono bg-slate-50 dark:bg-slate-900 p-2 rounded border">'+ (pi||JSON.stringify(d)) +'</div></div>';
    }).join('');
  } catch(e) { list.innerHTML = '<div class="text-center py-8 text-red-400 text-xs">加载失败</div>'; }
}
async function approveTask(id) { await fetch('/api/queue/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task_id:id})}); loadTasks(); }
async function rejectTask(id) { await fetch('/api/queue/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task_id:id})}); loadTasks(); }
async function approveAll() { var r = await fetch('/api/queue/status?project_id='+pid); var tasks = await r.json(); for (var i=0; i<tasks.length; i++) { if (tasks[i].status==='pending') await approveTask(tasks[i].id); } }
async function rejectAll() { var r = await fetch('/api/queue/status?project_id='+pid); var tasks = await r.json(); for (var i=0; i<tasks.length; i++) { if (tasks[i].status==='pending') await rejectTask(tasks[i].id); } }

//══════════ PDF.js Custom Viewer ══════════
var pdfDoc = null, pdfCurrentPage = 1, pdfExtractedText = '';
var pdfLoading = false;

function loadPdfJs(cb) {
  if (typeof pdfjsLib !== 'undefined') { cb(); return; }
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  s.type = 'module';
  s.onload = function() {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    cb();
  };
  document.head.appendChild(s);
}

async function loadPdfViewer(rawUrl, filePath) {
  if (pdfLoading) return; pdfLoading = true;
  var area = document.getElementById('contentArea');
  try {
    var resp = await fetch(rawUrl);
    var arrayBuf = await resp.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    pdfExtractedText = '';

    var totalPages = pdfDoc.numPages;
    var scale = Math.min(window.devicePixelRatio || 1, 2);
    var pageContainers = [];

    // Render all pages
    for (var i = 1; i <= totalPages; i++) {
      var page = await pdfDoc.getPage(i);
      var viewport = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = viewport.width * (window.devicePixelRatio || 1);
      canvas.height = viewport.height * (window.devicePixelRatio || 1);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      canvas.style.maxWidth = '100%';
      canvas.className = 'mx-auto shadow-sm';
      var ctx = canvas.getContext('2d');
      ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;

      // Extract text (progressive)
      page.getTextContent().then(function(tc) {
        pdfExtractedText += '\n--- Page ' + i + ' ---\n' +
          tc.items.filter(function(it){ return 'str' in it; }).map(function(it){ return it.str; }).join(' ');
      }).catch(function(){});

      var container = document.createElement('div');
      container.className = 'pdf-page mb-4 flex justify-center';
      container.dataset.page = i;
      container.appendChild(canvas);
      pageContainers.push(container);
    }

    // Page nav
    var navHtml = '<div class="flex items-center justify-center gap-3 mb-4 text-sm"><button onclick="pdfGoPage(-1)" class="px-3 py-1.5 border rounded-md hover:bg-slate-100 dark:hover:bg-slate-700">◀ 上一页</button><span class="text-slate-600 dark:text-slate-400"><span id="pdfCurrentPage">1</span> / ' + totalPages + '</span><button onclick="pdfGoPage(1)" class="px-3 py-1.5 border rounded-md hover:bg-slate-100 dark:hover:bg-slate-700">下一页 ▶</button></div>';

    area.innerHTML = '<div class="p-4 sm:p-10"><div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 p-6 sm:p-8 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700">' + navHtml + '<div id="pdfPages">' + pageContainers.map(function(c){ return c.outerHTML; }).join('') + '</div>' + navHtml + '</div></div>';

    // Populate outline
    pdfDoc.getOutline().then(function(outline) {
      if (outline && outline.length) {
        var ol = document.getElementById('outlineList');
        ol.innerHTML = outline.map(function(item){ return '<div onclick="pdfGoPage('+item.dest+')" class="py-1 px-2 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 text-sm text-slate-600 dark:text-slate-300">📑 '+esc(item.title)+'</div>'; }).join('');
        outlineBuilt = true;
      }
    }).catch(function(){});

    document.getElementById('outlineList').innerHTML = '<div class="text-center py-12 text-xs text-slate-400">PDF 大纲加载中...</div>';
    addRecentFile(filePath);
    pdfLoading = false;
  } catch(e) {
    area.innerHTML = '<div class="h-full flex flex-col items-center justify-center text-slate-400 gap-2"><span class="text-4xl">⚠️</span><p class="text-sm">PDF 加载失败</p></div>';
    pdfLoading = false;
  }
}

function pdfGoPage(dirOrNum) {
  var totalPages = pdfDoc ? pdfDoc.numPages : 0;
  if (!totalPages) return;
  if (typeof dirOrNum === 'number' && dirOrNum < 1) {
    pdfCurrentPage = Math.max(1, pdfCurrentPage + dirOrNum);
  } else if (typeof dirOrNum === 'number' && dirOrNum > 0) {
    pdfCurrentPage = dirOrNum;
  }
  var target = document.querySelector('.pdf-page[data-page="' + pdfCurrentPage + '"]');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  var el = document.getElementById('pdfCurrentPage');
  if (el) el.textContent = pdfCurrentPage;
}

// Override TTS for PDF: use extracted text instead of DOM text
(function(){
  var origToggleTTS = toggleTTS;
  toggleTTS = function() {
    if (pdfDoc && pdfExtractedText) {
      if (ttsActive) { window.speechSynthesis.cancel(); ttsActive = false; return; }
      ttsActive = true;
      var rate = parseFloat(document.getElementById('ttsRate').value) || 1;
      var u = new SpeechSynthesisUtterance(pdfExtractedText.substring(0, 8000));
      u.lang = 'zh-CN'; u.rate = rate;
      u.onend = function(){ ttsActive = false; };
      window.speechSynthesis.speak(u);
      return;
    }
    origToggleTTS();
  };
})();

//══════════ Office Docs Rendering (DOCX/XLSX) ══════════
function renderOfficeDoc(d) {
  if (d.type === 'docx') renderDocx(d);
  else if (d.type === 'xlsx') renderXlsx(d);
}

function renderDocx(d) {
  var area = document.getElementById('contentArea');
  loadMammoth(function() {
    fetch(d.rawUrl).then(function(r){ return r.arrayBuffer(); }).then(function(buf) {
      mammoth.convertToHtml({ arrayBuffer: buf }).then(function(result) {
        var html = '<div class="max-w-4xl mx-auto bg-white dark:bg-slate-800 p-8 sm:p-12 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700"><div class="doc-content text-slate-700 dark:text-slate-300" id="docContent">' + result.value + '</div></div>';
        area.innerHTML = '<div class="p-4 sm:p-10">' + html + '</div>';
        if (result.warnings.length) console.warn('DOCX warnings:', result.warnings);
        setTimeout(function(){ buildOutline(); }, 50);
        addRecentFile(currentFile);
      }).catch(function() { area.innerHTML = '<div class="h-full flex items-center justify-center text-slate-400">DOCX 解析失败</div>'; });
    });
  });
}

function renderXlsx(d) {
  var area = document.getElementById('contentArea');
  if (typeof XLSX === 'undefined') {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.mini.min.js';
    s.onload = function(){ renderXlsx(d); };
    document.head.appendChild(s);
    area.innerHTML = '<div class="h-full flex items-center justify-center"><div class="text-sm text-slate-500">加载 XLSX 查看器...</div></div>';
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
    addRecentFile(currentFile);
  }).catch(function(){ area.innerHTML = '<div class="h-full flex items-center justify-center text-slate-400">XLSX 加载失败</div>'; });
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
  s.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
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
  document.getElementById('breadcrumbPath').textContent = next.path;
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
      images.sort(function(a,b){ return a.name.localeCompare(b.name,'zh-CN'); });
      return images.map(function(e){ return { name:e.name, path: (parentDir ? parentDir+'/' : '') + e.name }; });
    })
    .catch(function(){ return []; });
}

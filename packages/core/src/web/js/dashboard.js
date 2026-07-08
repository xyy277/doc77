/**
 * Doc77 Dashboard JS — 首页（index.html）专用
 */
var projects = [];
async function load() {
  try { var r = await fetch('/api/projects'); projects = await r.json(); renderGrid(); }
  catch(e) { document.getElementById('grid').innerHTML = '<div class="col-span-full text-center py-16 text-slate-400"><p>⚠️ 加载失败</p></div>'; }
}
function renderGrid() {
  var grid = document.getElementById('grid');
  if (!projects.length) {
    grid.className = '';
    grid.innerHTML = '<div class="text-center py-20 text-slate-400 dark:text-slate-500"><div class="text-6xl mb-4 text-slate-300 dark:text-slate-600">📋</div><p class="text-sm">暂无项目，请注册一个本地目录</p><p class="text-xs text-slate-400 dark:text-slate-500 mt-1">支持 ~ 路径和 Windows 路径（WSL 自动转换）</p></div>';
    return;
  }
  grid.className = 'grid gap-4 sm:grid-cols-2';
  grid.innerHTML = projects.map(function(p) {
    return '<div onclick="location.href=\'/preview.html?id=' + p.id + '\'" class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-5 cursor-pointer transition-all hover:shadow-lg hover:border-blue-300 dark:hover:border-blue-600 animate-in group">' +
      '<h3 class="text-base font-semibold text-slate-800 dark:text-slate-100 mb-1.5 flex items-center gap-2">📂 ' + esc(p.name) + '</h3>' +
      '<p class="text-xs text-slate-400 dark:text-slate-500 font-mono truncate mb-4">' + esc(p.path) + '</p>' +
      '<div class="flex justify-between items-center text-[11px]">' +
      '<span class="text-slate-400 dark:text-slate-500">' + new Date(p.created_at).toLocaleDateString('zh-CN') + '</span>' +
      '<button onclick="event.stopPropagation();doDelete(' + p.id + ')" class="text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded-md text-xs transition-colors opacity-0 group-hover:opacity-100">删除</button></div></div>';
  }).join('');
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
load();

/**
 * Doc77 Register JS — registration modal with manual + discover + import tabs
 */

// ═══ Modal Show/Hide ═══
window.showRegisterModal = function () {
  var modal = document.getElementById('registerModal');
  if (modal) modal.style.display = 'flex';
  window.switchRegisterTab('manual');
  document.getElementById('regName').value = '';
  document.getElementById('regPath').value = '';
  document.getElementById('regError').style.display = 'none';
};

window.closeRegisterModal = function () {
  var modal = document.getElementById('registerModal');
  if (modal) modal.style.display = 'none';
};

// ═══ Tab Switching ═══
window.switchRegisterTab = function (tab) {
  document.querySelectorAll('#registerModal .modal-tab').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('#registerModal .tab-panel').forEach(function (panel) {
    panel.classList.remove('active');
  });
  var target = document.getElementById('tab-' + tab);
  if (target) target.classList.add('active');
  if (tab === 'discover') {
    document.getElementById('discoverCandidates').innerHTML = '';
    document.getElementById('discoverStatus').textContent = '';
    document.getElementById('discoverActions').style.display = 'none';
  }
  if (tab === 'import') {
    document.getElementById('gitDiscoverCandidates').innerHTML = '';
    document.getElementById('gitDiscoverStatus').textContent = '';
    document.getElementById('gitDiscoverActions').style.display = 'none';
    document.getElementById('workspaceStatus').textContent = '';
  }
};

// ═══ Tag label/icon maps ═══
var TAG_ICONS = {
  nodejs: '🟢',
  typescript: '🔷',
  python: '🐍',
  go: '🔵',
  rust: '🦀',
  java: '☕',
  dotnet: '💠',
  git: '📦',
  obsidian: '🗳️',
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
  obsidian: 'Obsidian',
};

// ═══ Git Discover ═══
window.doGitDiscover = async function () {
  var dirPath = document.getElementById('gitDiscoverPath').value.trim() || '~';
  var depth = parseInt(document.getElementById('gitDepth').value, 10) || 3;
  var status = document.getElementById('gitDiscoverStatus');
  var candidates = document.getElementById('gitDiscoverCandidates');
  var actions = document.getElementById('gitDiscoverActions');
  var btn = document.getElementById('btnGitDiscover');

  status.textContent = '扫描中...';
  candidates.innerHTML = '';
  actions.style.display = 'none';
  btn.disabled = true;

  try {
    var r = await fetch(
      '/api/discover/git?path=' + encodeURIComponent(dirPath) + '&depth=' + depth,
    );
    var d = await r.json();
    if (!r.ok) {
      status.textContent = '❌ ' + (d.error || '扫描失败');
      return;
    }

    status.textContent = '找到 ' + d.repositories.length + ' 个 Git 项目';
    if (!d.repositories.length) {
      status.textContent += ' (无新项目)';
      return;
    }

    candidates.innerHTML = d.repositories
      .map(function (repo) {
        var tagHtml = (repo.tags || [])
          .map(function (t) {
            return (
              ' <span style="font-size:10px;opacity:0.7">' +
              (TAG_ICONS[t] || '') +
              (TAG_LABELS[t] || t) +
              '</span>'
            );
          })
          .join('');
        return (
          '<label class="checkbox-row" style="margin-bottom:6px">' +
          '<input type="checkbox" class="git-candidate" data-path="' +
          escAttr(repo.path) +
          '" data-name="' +
          escAttr(repo.name) +
          '" checked>' +
          '<span>' +
          esc(repo.name) +
          tagHtml +
          '</span></label>'
        );
      })
      .join('');
    actions.style.display = 'block';
  } catch (e) {
    status.textContent = '❌ 网络错误: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

// ═══ Git batch register ═══
window.batchRegisterGit = async function () {
  var checks = document.querySelectorAll('.git-candidate:checked');
  var status = document.getElementById('gitDiscoverStatus');
  status.textContent = '注册中...';

  var count = 0;
  for (var i = 0; i < checks.length; i++) {
    var ch = checks[i];
    try {
      var r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ch.dataset.name, path: ch.dataset.path }),
      });
      if (r.ok) count++;
    } catch (e) {}
  }
  status.textContent = '✅ 已注册 ' + count + '/' + checks.length + ' 个项目';
  if (window.load) window.load();
};

// ═══ VS Code workspace import ═══
window.importWorkspace = async function () {
  var input = document.getElementById('workspacePath');
  var wsPath = input.value.trim();
  if (!wsPath) {
    wsPath = window.prompt('请输入 .code-workspace 文件路径:', '~/my.code-workspace');
    if (!wsPath) return;
    input.value = wsPath;
  }
  var status = document.getElementById('workspaceStatus');
  status.textContent = '导入中...';
  try {
    var r = await fetch('/api/projects/import-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: wsPath }),
    });
    var d = await r.json();
    if (!r.ok) {
      status.textContent = '❌ ' + (d.error || '导入失败');
      return;
    }
    var msg = '✅ 已注册 ' + d.imported.length + ' 个项目';
    if (d.skipped.length) msg += ' (跳过 ' + d.skipped.length + ' 个已存在)';
    status.textContent = msg;
    if (window.load) window.load();
  } catch (e) {
    status.textContent = '❌ ' + e.message;
  }
};

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

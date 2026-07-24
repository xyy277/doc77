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

  status.textContent = t('web.register.scanning');
  candidates.innerHTML = '';
  actions.style.display = 'none';
  btn.disabled = true;

  try {
    var r = await fetch(
      '/api/discover/git?path=' + encodeURIComponent(dirPath) + '&depth=' + depth,
    );
    var d = await r.json();
    if (!r.ok) {
      status.textContent = '❌ ' + (d.error || t('web.register.scanFailed'));
      return;
    }

    status.textContent = t('web.register.gitFound', { n: d.repositories.length });
    if (!d.repositories.length) {
      status.textContent += ' ' + t('web.register.noNew');
      return;
    }

    candidates.innerHTML = d.repositories
      .map(function (repo) {
        var tagHtml = (repo.tags || [])
          .map(function (tag) {
            return (
              ' <span style="font-size:10px;opacity:0.7">' +
              (TAG_ICONS[tag] || '') +
              (TAG_LABELS[tag] || tag) +
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
    status.textContent = t('web.register.networkError', { message: e.message });
  } finally {
    btn.disabled = false;
  }
};

// ═══ Git batch register ═══
window.batchRegisterGit = async function () {
  var checks = document.querySelectorAll('.git-candidate:checked');
  var status = document.getElementById('gitDiscoverStatus');
  status.textContent = t('web.register.registering');

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
  status.textContent = t('web.register.registered', { n: count, total: checks.length });
  if (window.load) window.load();
};

// ═══ VS Code workspace import ═══
window.importWorkspace = async function () {
  var input = document.getElementById('workspacePath');
  var wsPath = input.value.trim();
  if (!wsPath) {
    wsPath = await window.promptDialog({ title: t('web.register.wsPrompt'), placeholder: '~/my.code-workspace' });
    if (!wsPath) return;
    input.value = wsPath;
  }
  var status = document.getElementById('workspaceStatus');
  status.textContent = t('web.register.importing');
  try {
    var r = await fetch('/api/projects/import-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: wsPath }),
    });
    var d = await r.json();
    if (!r.ok) {
      status.textContent = '❌ ' + (d.error || t('web.register.importFailed'));
      return;
    }
    var msg = t('web.register.imported', { n: d.imported.length });
    if (d.skipped.length) msg += ' ' + t('web.register.skipped', { n: d.skipped.length });
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

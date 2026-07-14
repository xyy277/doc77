/**
 * Doc77 Discover JS — project discovery + candidate rendering
 */

var discoverResults = [];

window.doDiscover = async function() {
  var pathInput = document.getElementById('discoverPath');
  var status = document.getElementById('discoverStatus');
  var candidates = document.getElementById('discoverCandidates');
  var actions = document.getElementById('discoverActions');
  var btn = document.getElementById('btnDiscover');

  var scanPath = pathInput.value.trim() || '~';
  status.textContent = '🔍 扫描中...';
  candidates.innerHTML = '';
  actions.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '⏳ 扫描中...';
  btn.classList.add('btn-loading');

  try {
    var r = await fetch('/api/discover?path=' + encodeURIComponent(scanPath) + '&depth=2');
    if (!r.ok) {
      var err = await r.json();
      status.textContent = '❌ ' + (err.error || '扫描失败');
      btn.disabled = false;
      btn.innerHTML = '🔍 扫描';
      btn.classList.remove('btn-loading');
      return;
    }
    discoverResults = await r.json();

    if (!discoverResults.length) {
      status.textContent = '未发现候选项目（需要 .git + 至少 1 个 .md 文件）';
      btn.disabled = false;
      btn.innerHTML = '🔍 扫描';
      btn.classList.remove('btn-loading');
      return;
    }

    status.textContent = '发现 ' + discoverResults.length + ' 个候选项目';
    renderDiscoverCandidates();
    actions.style.display = 'block';
  } catch(e) {
    status.textContent = '❌ 网络错误';
  }

  btn.disabled = false;
  btn.innerHTML = '🔍 扫描';
  btn.classList.remove('btn-loading');
};

function renderDiscoverCandidates() {
  var container = document.getElementById('discoverCandidates');
  var html = '';

  discoverResults.forEach(function(item, index) {
    html += '<label class="discover-candidate">' +
      '<input type="checkbox" data-index="' + index + '" onchange="updateBatchButton()">' +
      '<span>📂</span>' +
      '<div class="candidate-info">' +
        '<div class="candidate-name">' + esc(item.name) + '</div>' +
        '<div class="candidate-path">' + esc(item.path) + '</div>' +
      '</div>' +
      '<span style="font-size:11px;color:var(--text-muted)">' + item.mdCount + ' .md</span>' +
    '</label>';
  });

  container.innerHTML = html;
}

window.updateBatchButton = function() {
  var checked = document.querySelectorAll('#discoverCandidates input:checked').length;
  var btn = document.querySelector('#discoverActions .btn');
  if (btn) {
    btn.textContent = '📋 批量注册选中 (' + checked + ')';
    btn.disabled = checked === 0;
  }
};

window.batchRegister = async function() {
  var checked = document.querySelectorAll('#discoverCandidates input:checked');
  if (!checked.length) { toast('请至少选择一个项目', 'info'); return; }

  showLoading('正在批量注册 ' + checked.length + ' 个项目...');
  var successCount = 0;
  var failCount = 0;

  for (var i = 0; i < checked.length; i++) {
    var item = discoverResults[parseInt(checked[i].dataset.index)];
    try {
      var r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.name, path: item.path }),
      });
      if (r.ok) {
        successCount++;
        // Disable the checkbox
        checked[i].disabled = true;
        checked[i].parentElement.classList.add('registered');
      } else {
        failCount++;
      }
    } catch(e) {
      failCount++;
    }
  }

  hideLoading();

  if (successCount > 0) {
    toast('成功注册 ' + successCount + ' 个项目', 'success');
    // Refresh the main dashboard
    fetch('/api/projects').then(function(r) { return r.json(); }).then(function(allProjects) {
      projects = allProjects;
      document.getElementById('projCount').textContent = allProjects.length;
      window.filterAndSort();
      window.renderFavorites(allProjects);
      window.renderStats();
    });
  }
  if (failCount > 0) {
    toast(failCount + ' 个注册失败（可能已存在）', 'error');
  }
};

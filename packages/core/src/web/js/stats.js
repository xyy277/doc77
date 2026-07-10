/**
 * Doc77 Stats JS — statistics panel rendering
 */

window.renderStats = async function() {
  var container = document.getElementById('statsContent');
  try {
    var r = await fetch('/api/stats');
    var d = await r.json();

    var html = '';
    html += '<div class="stats-item"><div class="stats-value">' + d.projects + '</div><div class="stats-label">项目</div></div>';
    html += '<div class="stats-item"><div class="stats-value">' + d.favoriteCount + '</div><div class="stats-label">收藏</div></div>';
    html += '<div class="stats-item"><div class="stats-label" style="margin-top:2px">最近活跃</div><div style="font-size:13px;font-weight:500">' + relativeTimeText(d.lastActive) + '</div></div>';

    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">加载失败</span>';
  }
};

window.refreshStats = function() {
  window.renderStats();
};

function relativeTimeText(isoString) {
  if (!isoString) return '暂无记录';
  var now = Date.now();
  var then = new Date(isoString).getTime();
  if (isNaN(then)) return '暂无记录';
  var diff = Math.floor((now - then) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}

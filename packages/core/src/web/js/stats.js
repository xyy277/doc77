/**
 * Doc77 Stats JS — statistics panel rendering
 */

window.renderStats = async function() {
  var container = document.getElementById('statsContent');
  try {
    var r = await fetch('/api/stats');
    var d = await r.json();

    container.innerHTML =
      '<div class="stat-block"><div class="stat-number">' + d.projects + '</div><div class="stat-label">项目</div></div>' +
      '<div class="stat-block"><div class="stat-number">' + d.favoriteCount + '</div><div class="stat-label">收藏</div></div>' +
      '<div class="stat-block stat-block-wide"><div class="stat-number stat-number-sm">' + relativeTimeText(d.lastActive) + '</div><div class="stat-label">最近活跃</div></div>';
  } catch(e) {
    container.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">加载失败</span>';
  }
};

window.refreshStats = function() {
  window.renderStats();
};

function relativeTimeText(epochMs) {
  if (!epochMs) return '尚无项目';
  var diff = Math.floor((Date.now() - epochMs) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 172800) return '昨天';
  return Math.floor(diff / 86400) + ' 天前';
}

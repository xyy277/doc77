/**
 * Doc77 Stats JS — statistics panel rendering (updates header badges)
 */

window.renderStats = async function () {
  try {
    var r = await fetch('/api/stats');
    var d = await r.json();

    var projEl = document.getElementById('headerProjCount');
    var favEl = document.getElementById('headerFavCount');
    var recentEl = document.getElementById('headerRecentCount');
    if (projEl) projEl.textContent = d.projects;
    if (favEl) favEl.textContent = d.favoriteCount;
    // recentCount is synced by dashboard.js renderRecent
  } catch (e) {
    // silent fail — badges just show "0"
  }
};

window.refreshStats = function () {
  window.renderStats();
};

function relativeTimeText(epochMs) {
  if (!epochMs || isNaN(epochMs)) return '尚无项目';
  var diff = Math.floor((Date.now() - epochMs) / 1000);
  if (diff < 0) return '尚无项目';
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 172800) return '昨天';
  return Math.floor(diff / 86400) + ' 天前';
}

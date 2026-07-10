/**
 * Doc77 Favorites JS — star toggle + favorites section rendering
 */

// ═══ Favorite Toggle ═══
window.toggleFavorite = async function(projectId) {
  try {
    var r = await fetch('/api/projects/' + projectId + '/favorite', { method: 'PUT' });
    if (!r.ok) { toast('操作失败', 'error'); return; }
    var d = await r.json();
    // Update star button in both project grid and favorites grid
    updateStarButtons(projectId, d.favorited);
    // Refresh everything
    window.refreshFavorites();
    window.filterAndSort();
    window.refreshStats();
    toast(d.favorited ? '已收藏' : '已取消收藏', 'success');
  } catch(e) {
    toast('操作失败', 'error');
  }
};

function updateStarButtons(projectId, favorited) {
  var buttons = document.querySelectorAll('.fav-star[data-id="' + projectId + '"]');
  buttons.forEach(function(btn) {
    if (favorited) {
      btn.classList.add('favorited');
      btn.textContent = '★';
    } else {
      btn.classList.remove('favorited');
      btn.textContent = '☆';
    }
  });
}

// ═══ Render Favorites Section ═══
window.renderFavorites = function(projects) {
  var favProjects = projects.filter(function(p) { return p.favorited; });
  var section = document.getElementById('favoritesSection');
  var grid = document.getElementById('favGrid');
  var countEl = document.getElementById('favCount');

  countEl.textContent = favProjects.length;

  if (favProjects.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  grid.innerHTML = favProjects.map(function(p) {
    return renderCompactCard(p, true);
  }).join('');
};

// ═══ Refresh (called by other modules after state change) ═══
window.refreshFavorites = function() {
  // Re-fetch projects to get latest favorited status
  fetch('/api/projects').then(function(r) { return r.json(); }).then(function(projects) {
    window.renderFavorites(projects);
  }).catch(function() {});
};

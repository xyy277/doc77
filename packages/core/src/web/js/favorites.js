/**
 * Doc77 Favorites JS — star toggle + favorites section rendering
 */

// ═══ Favorite Toggle ═══
window.toggleFavorite = async function(projectId) {
  try {
    var r = await fetch('/api/projects/' + projectId + '/favorite', { method: 'PUT' });
    if (!r.ok) { toast('操作失败', 'error'); return; }
    var d = await r.json();
    // Update star buttons in DOM
    updateStarButtons(projectId, d.favorited);
    // Update local projects array so filterAndSort picks up the change
    if (typeof projects !== 'undefined') {
      projects.forEach(function(p) {
        if (p.id === projectId) p.favorited = d.favorited ? 1 : 0;
      });
    }
    // Refresh sections
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
  var list = document.getElementById('favList');
  var countEl = document.getElementById('favCount');

  countEl.textContent = favProjects.length;

  if (favProjects.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  var html = '<div class="fav-pills">';
  favProjects.forEach(function(p) {
    html += '<a href="/preview.html?id=' + p.id + '" class="fav-pill" onclick="fetch(\'/api/projects/' + p.id + '/touch\',{method:\'POST\'}).catch(function(){})">⭐ ' + esc(p.name) + '</a>';
  });
  html += '</div>';
  list.innerHTML = html;
};

// ═══ Refresh (called by other modules after state change) ═══
window.refreshFavorites = function() {
  // Re-fetch projects to get latest favorited status
  fetch('/api/projects').then(function(r) { return r.json(); }).then(function(projects) {
    window.renderFavorites(projects);
  }).catch(function() {});
};

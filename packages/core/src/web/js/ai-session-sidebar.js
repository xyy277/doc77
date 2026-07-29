/**
 * AI Session Sidebar — left rail of the AI workspace.
 *
 * Responsibilities:
 *   - Load and render the list of chat sessions grouped by recency
 *     (Pinned / Today / Yesterday / This week / This month / Earlier)
 *   - Inline search (delegates to GET /api/ai/sessions?q=…)
 *   - Per-row actions: pin/unpin, archive, delete
 *   - Click a row → open the session in a new tab (via aiWorkspace.openSession)
 *
 * The sidebar is a singleton attached to window.aiSidebar. It does NOT own
 * session state — it merely renders whatever SessionStore returns and emits
 * "open" intents to the workspace orchestrator.
 */
(function () {
  'use strict';

  var SIDEBAR = null;
  var LIST = null;
  var SEARCH_INPUT = null;
  var currentQuery = '';
  var currentSessions = [];
  var activeSessionId = null;
  var debounceTimer = null;

  // Recency bucket boundaries (in ms, relative to now)
  var DAY = 24 * 60 * 60 * 1000;

  function init() {
    SIDEBAR = document.getElementById('aiSidebar');
    LIST = document.getElementById('aiSessionList');
    SEARCH_INPUT = document.getElementById('aiSessionSearch');
    if (!LIST) return;
    refresh();
  }

  /**
   * Fetch sessions from the backend and re-render.
   * Pass `keepSelection=false` to force a full redraw.
   */
  function refresh() {
    var url = '/api/ai/sessions?limit=200';
    if (currentQuery) url += '&q=' + encodeURIComponent(currentQuery);
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // API may return { sessions: [...] } or [...] — handle both
        currentSessions = (data && (data.sessions || data)) || [];
        render();
      })
      .catch(function () {
        currentSessions = [];
        render();
      });
  }

  /**
   * Group sessions by recency bucket. Pinned sessions are always hoisted
   * to a dedicated top group regardless of age.
   */
  function groupByRecency(sessions) {
    var now = Date.now();
    var groups = {
      pinned: [],
      today: [],
      yesterday: [],
      thisWeek: [],
      thisMonth: [],
      earlier: [],
    };
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (s.status === 'deleted') continue;
      if (s.pinned) { groups.pinned.push(s); continue; }
      var updated = new Date(s.updatedAt || s.created_at || s.createdAt || now).getTime();
      var age = now - updated;
      if (age < DAY) groups.today.push(s);
      else if (age < 2 * DAY) groups.yesterday.push(s);
      else if (age < 7 * DAY) groups.thisWeek.push(s);
      else if (age < 30 * DAY) groups.thisMonth.push(s);
      else groups.earlier.push(s);
    }
    return groups;
  }

  function bucketLabel(key) {
    return {
      pinned: t('web.ai.group.pinned'),
      today: t('web.ai.group.today'),
      yesterday: t('web.ai.group.yesterday'),
      thisWeek: t('web.ai.group.thisWeek'),
      thisMonth: t('web.ai.group.thisMonth'),
      earlier: t('web.ai.group.earlier'),
    }[key] || key;
  }

  function render() {
    if (!LIST) return;
    if (!currentSessions.length) {
      LIST.innerHTML = '<div class="ai-empty-list">' + esc(t('web.ai.sidebar.empty')) + '</div>';
      return;
    }

    var groups = groupByRecency(currentSessions);
    var order = ['pinned', 'today', 'yesterday', 'thisWeek', 'thisMonth', 'earlier'];
    var html = '';
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      var items = groups[key];
      if (!items.length) continue;
      html += '<div class="ai-session-group">';
      html += '<div class="ai-session-group-title">' + esc(bucketLabel(key)) + '</div>';
      for (var j = 0; j < items.length; j++) {
        html += renderRow(items[j]);
      }
      html += '</div>';
    }
    LIST.innerHTML = html;

    // Wire up row clicks (delegation)
    LIST.querySelectorAll('.ai-session-item').forEach(function (row) {
      row.addEventListener('click', function (e) {
        // Ignore clicks on action buttons
        if (e.target.closest('.sess-action-btn')) return;
        var sid = row.dataset.sid;
        if (sid) window.aiWorkspace.openSession(sid);
      });
    });
  }

  function renderRow(s) {
    var sid = s.id;
    var title = s.title || (t('web.ai.tab.new'));
    var isActive = sid === activeSessionId;
    var meta = formatRelative(s.updatedAt || s.updated_at || s.createdAt || s.created_at);

    var pinIcon = s.pinned ? '<span class="pin-icon">📌</span>' : '';
    var cls = 'ai-session-item' + (isActive ? ' active' : '');

    var html = '<div class="' + cls + '" data-sid="' + escAttr(sid) + '" title="' + escAttr(title) + '">';
    html += pinIcon;
    html += '<span class="sess-title">' + esc(title) + '</span>';
    html += '<span class="sess-meta">' + esc(meta) + '</span>';
    html += '<span class="sess-actions">';
    html += '<button class="sess-action-btn" data-act="pin" title="' + (s.pinned ? 'Unpin' : 'Pin') + '">' + (s.pinned ? '📍' : '📌') + '</button>';
    html += '<button class="sess-action-btn" data-act="archive" title="Archive">🗄</button>';
    html += '<button class="sess-action-btn" data-act="delete" title="Delete">🗑</button>';
    html += '</span>';
    html += '</div>';
    return html;
  }

  function formatRelative(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var diff = now - d;
    if (diff < DAY && d.getDate() === now.getDate()) {
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }
    if (diff < 2 * DAY) return t('web.ai.group.yesterday');
    if (diff < 7 * DAY) {
      var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return days[d.getDay()] || '';
    }
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function onSearch(value) {
    currentQuery = (value || '').trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 250);
  }

  function setActive(sid) {
    activeSessionId = sid;
    // Re-render to update the active highlight without a network round-trip
    if (currentSessions.length) render();
  }

  /** Handle per-row action button clicks via event delegation. */
  function onListClick(e) {
    var btn = e.target.closest('.sess-action-btn');
    if (!btn) return;
    e.stopPropagation();
    var row = btn.closest('.ai-session-item');
    if (!row) return;
    var sid = row.dataset.sid;
    var act = btn.dataset.act;
    if (act === 'pin') doTogglePin(sid);
    else if (act === 'archive') doArchive(sid);
    else if (act === 'delete') doDelete(sid);
  }

  function doTogglePin(sid) {
    var s = findSession(sid);
    if (!s) return;
    // SessionStore stores pinned as 0/1 integer; the PATCH route accepts a
    // boolean and converts. Send a boolean to match the API contract.
    var newPinned = !s.pinned;
    fetch('/api/ai/sessions/' + encodeURIComponent(sid), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: newPinned }),
    }).then(function (r) { return r.json(); }).then(function () {
      toast(newPinned ? t('web.ai.toast.pinned') : t('web.ai.toast.unpinned'), 'success');
      refresh();
    }).catch(function () { toast('Error', 'error'); });
  }

  function doArchive(sid) {
    fetch('/api/ai/sessions/' + encodeURIComponent(sid), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    }).then(function (r) { return r.json(); }).then(function () {
      toast(t('web.ai.toast.sessionArchived'), 'success');
      // If archiving the active session, the workspace will pick another
      window.aiWorkspace.onSessionArchived(sid);
      refresh();
    }).catch(function () { toast('Error', 'error'); });
  }

  function doDelete(sid) {
    if (!confirm(t('web.ai.confirm.deleteSession'))) return;
    fetch('/api/ai/sessions/' + encodeURIComponent(sid), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function () {
        toast(t('web.ai.toast.sessionDeleted'), 'success');
        window.aiWorkspace.onSessionDeleted(sid);
        refresh();
      })
      .catch(function () { toast('Error', 'error'); });
  }

  function findSession(sid) {
    for (var i = 0; i < currentSessions.length; i++) {
      if (currentSessions[i].id === sid) return currentSessions[i];
    }
    return null;
  }

  /** Mobile: toggle sidebar visibility. */
  function toggleMobile() {
    if (SIDEBAR) SIDEBAR.classList.toggle('mobile-open');
  }

  // Wire up action-button delegation once DOM is ready
  document.addEventListener('DOMContentLoaded', function () {
    init();
    if (LIST) {
      LIST.addEventListener('click', onListClick);
    }
  });

  // Expose singleton
  window.aiSidebar = {
    init: init,
    refresh: refresh,
    setActive: setActive,
    onSearch: onSearch,
    toggleMobile: toggleMobile,
  };
})();

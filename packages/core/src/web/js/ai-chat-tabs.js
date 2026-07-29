/**
 * AI Chat Tabs — multi-session tab strip + per-tab message state.
 *
 * Each tab owns:
 *   - sessionId (string, server-assigned)
 *   - title (string, derived from first user message)
 *   - messages (array of rendered message descriptors)
 *   - status: 'idle' | 'loading' | 'streaming'
 *   - abortController (active during streaming, for stop button)
 *
 * Tab state is persisted to localStorage so the workspace survives page
 * reloads. The active tab's messages are rendered into #aiMessages; inactive
 * tabs keep their state in memory and only re-render when activated.
 *
 * The component does NOT call the LLM directly — it delegates message
 * sending to aiInput.send(), which in turn drives aiWorkspace.runSession().
 * Tabs are purely a presentation/state layer.
 */
(function () {
  'use strict';

  var STRIP = null;
  var MSGS = null;

  /** @type {Array<{id:string,sessionId:string,title:string,status:string,messages:Array,projectId:?number,createdAt:number}>} */
  var tabs = [];
  var activeTabId = null;
  var STORAGE_KEY = 'doc77_ai_tabs_v1';

  function init() {
    STRIP = document.getElementById('aiTabsStrip');
    MSGS = document.getElementById('aiMessages');
    if (!STRIP || !MSGS) return;

    // Restore tabs from localStorage (best-effort; ignore corruption)
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(saved) && saved.length) {
        tabs = saved.map(function (s) {
          return {
            id: s.id || genId(),
            sessionId: s.sessionId,
            title: s.title || t('web.ai.tab.new'),
            status: 'idle',
            messages: [], // reloaded on activation
            projectId: s.projectId || null,
            createdAt: s.createdAt || Date.now(),
          };
        });
        activeTabId = tabs[0].id;
      }
    } catch (e) { tabs = []; }

    renderStrip();
    if (tabs.length === 0) {
      // Show welcome screen; a tab will be created on first send
      renderWelcome();
    } else {
      // Reload the active tab's messages from the server
      activate(tabs[0].id, /*forceReload=*/true);
    }
  }

  function persist() {
    try {
      var slim = tabs.map(function (tab) {
        return {
          id: tab.id, sessionId: tab.sessionId, title: tab.title,
          projectId: tab.projectId, createdAt: tab.createdAt,
        };
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch (e) { /* storage full / disabled — non-fatal */ }
  }

  function genId() {
    return 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /**
   * Create a new tab. If `sessionId` is omitted, no server session is
   * created yet — the session is created lazily on the first /api/ai/chat
   * call. Returns the new tab id.
   */
  function createTab(opts) {
    opts = opts || {};
    var tab = {
      id: genId(),
      sessionId: opts.sessionId || null,
      title: opts.title || t('web.ai.tab.new'),
      status: 'idle',
      messages: [],
      projectId: opts.projectId || null,
      createdAt: Date.now(),
    };
    tabs.push(tab);
    persist();
    renderStrip();
    activate(tab.id);
    return tab.id;
  }

  /** Activate a tab by id, optionally force-reloading its messages. */
  function activate(tabId, forceReload) {
    var tab = findTab(tabId);
    if (!tab) return;
    activeTabId = tabId;
    renderStrip();
    if (forceReload || tab.messages.length === 0) {
      if (tab.sessionId) {
        loadSessionMessages(tab);
      } else {
        tab.messages = [];
        renderWelcome();
      }
    } else {
      renderMessages(tab);
    }
    window.aiSidebar.setActive(tab.sessionId);
    // Focus the input
    if (window.aiInput) window.aiInput.focus();
  }

  /** Close a tab. If it's the active one, switch to a neighbor. */
  function closeTab(tabId) {
    var idx = -1;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === tabId) { idx = i; break; }
    }
    if (idx < 0) return;
    tabs.splice(idx, 1);
    persist();
    if (activeTabId === tabId) {
      if (tabs.length === 0) {
        activeTabId = null;
        renderStrip();
        renderWelcome();
      } else {
        var next = tabs[Math.min(idx, tabs.length - 1)];
        activate(next.id, true);
      }
    } else {
      renderStrip();
    }
  }

  function findTab(tabId) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === tabId) return tabs[i];
    }
    return null;
  }

  /** Find a tab already bound to a given server sessionId. */
  function findBySession(sessionId) {
    if (!sessionId) return null;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].sessionId === sessionId) return tabs[i];
    }
    return null;
  }

  function getActive() {
    return activeTabId ? findTab(activeTabId) : null;
  }

  /**
   * Load the current-branch message path from the server and render it.
   * Called on tab activation or after a branch switch.
   */
  function loadSessionMessages(tab) {
    if (!tab || !tab.sessionId) { renderWelcome(); return; }
    tab.status = 'loading';
    renderStrip();
    fetch('/api/ai/sessions/' + encodeURIComponent(tab.sessionId) + '/messages/path')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        tab.status = 'idle';
        tab.messages = (data && data.path) || [];
        // Refresh tab title from session if it was renamed
        if (data && data.session && data.session.title) {
          // The path endpoint doesn't return session — fetch separately if needed
        }
        renderMessages(tab);
        renderStrip();
      })
      .catch(function () {
        tab.status = 'idle';
        tab.messages = [];
        renderMessages(tab);
        renderStrip();
      });
  }

  // ── Strip rendering ──
  function renderStrip() {
    if (!STRIP) return;
    if (tabs.length === 0) { STRIP.innerHTML = ''; return; }
    var html = '';
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var isActive = tab.id === activeTabId;
      var cls = 'ai-tab' + (isActive ? ' active' : '');
      var title = tab.title || t('web.ai.tab.new');
      var loading = tab.status === 'streaming' || tab.status === 'loading';
      html += '<div class="' + cls + '" data-tab="' + escAttr(tab.id) + '" title="' + escAttr(title) + '">';
      if (loading) html += '<span class="tab-loading"></span>';
      html += '<span class="tab-title">' + esc(title) + '</span>';
      html += '<span class="tab-close" data-close="' + escAttr(tab.id) + '" title="Close">✕</span>';
      html += '</div>';
    }
    STRIP.innerHTML = html;

    STRIP.querySelectorAll('.ai-tab').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.closest('.tab-close')) return;
        activate(el.dataset.tab);
      });
    });
    STRIP.querySelectorAll('.tab-close').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        closeTab(el.dataset.close);
      });
    });
  }

  // ── Welcome screen (no active session) ──
  function renderWelcome() {
    if (!MSGS) return;
    var html = '<div class="ai-welcome-hero">';
    html += '<h1>' + esc(t('web.ai.welcome.title')) + '</h1>';
    html += '<p>' + esc(t('web.ai.welcome.desc')) + '</p>';
    html += '<div class="ai-quick-grid">';
    html += quickCard('📊', 'web.ai.quick.analyzeProject', 'web.ai.quick.analyzeProject.desc', "aiWorkspace.quickStart('analyzeProject')");
    html += quickCard('📝', 'web.ai.quick.summarizeDoc', 'web.ai.quick.summarizeDoc.desc', "aiWorkspace.quickStart('summarizeDoc')");
    html += quickCard('🔍', 'web.ai.quick.findDuplicates', 'web.ai.quick.findDuplicates.desc', "aiWorkspace.quickStart('findDuplicates')");
    html += quickCard('🗂️', 'web.ai.quick.smartClassify', 'web.ai.quick.smartClassify.desc', "aiWorkspace.quickStart('smartClassify')");
    html += '</div></div>';
    MSGS.innerHTML = html;
  }

  function quickCard(icon, titleKey, descKey, onclick) {
    return '<div class="ai-quick-card" onclick="' + onclick + '">' +
      '<div class="qc-icon">' + icon + '</div>' +
      '<div class="qc-title">' + esc(t(titleKey)) + '</div>' +
      '<div class="qc-desc">' + esc(t(descKey)) + '</div>' +
      '</div>';
  }

  // ── Messages rendering ──
  /**
   * Render the active tab's messages. Each message descriptor is either a
   * persisted AiMessageRecord (from /messages/path) or a transient runtime
   * bubble (user input just typed, assistant streaming). The renderer
   * branches on `msg.role` and presence of `msg.streaming`.
   */
  function renderMessages(tab) {
    if (!MSGS) return;
    if (!tab.messages || tab.messages.length === 0) {
      renderWelcome();
      return;
    }
    var html = '';
    for (var i = 0; i < tab.messages.length; i++) {
      html += window.aiMessageBranch.renderMessage(tab, tab.messages[i], i);
    }
    MSGS.innerHTML = html;
    // Scroll to bottom
    var wrap = document.getElementById('aiMessagesWrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
    // Wire up per-message actions (regenerate / edit / copy / branch nav)
    window.aiMessageBranch.wireActions(tab);
  }

  /** Append a runtime message descriptor to the active tab and re-render. */
  function appendRuntimeMessage(desc) {
    var tab = getActive();
    if (!tab) return null;
    var entry = {
      id: desc.id || genId(),
      role: desc.role,
      content: desc.content || '',
      streaming: !!desc.streaming,
      toolCalls: desc.toolCalls || [],
      createdAt: Date.now(),
      runtime: true,
    };
    tab.messages.push(entry);
    renderMessages(tab);
    return entry;
  }

  /** Patch the last assistant message (streaming token accumulation). */
  function appendToLastAssistant(text) {
    var tab = getActive();
    if (!tab || !tab.messages.length) return;
    var last = tab.messages[tab.messages.length - 1];
    if (last.role !== 'assistant') return;
    last.content += text;
    // Incremental DOM update — avoid full re-render on every token
    var bubble = MSGS.querySelector('[data-msg="' + last.id + '"] .ai-msg-bubble');
    if (bubble) {
      bubble.textContent = last.content;
    } else {
      renderMessages(tab);
    }
    var wrap = document.getElementById('aiMessagesWrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }

  /** Mark streaming complete on the last assistant message. */
  function finalizeLastAssistant() {
    var tab = getActive();
    if (!tab) return;
    if (tab.messages.length) {
      tab.messages[tab.messages.length - 1].streaming = false;
    }
    tab.status = 'idle';
    renderStrip();
  }

  /** Set tab status (e.g. 'streaming') and refresh the strip indicator. */
  function setStatus(tabId, status) {
    var tab = findTab(tabId);
    if (!tab) return;
    tab.status = status;
    renderStrip();
  }

  /** Update the tab's title (e.g. after first user message). */
  function setTabTitle(tabId, title) {
    var tab = findTab(tabId);
    if (!tab) return;
    tab.title = title || tab.title;
    persist();
    renderStrip();
  }

  /** Bind a server sessionId to a tab (lazy creation on first send). */
  function bindSession(tabId, sessionId, title) {
    var tab = findTab(tabId);
    if (!tab) return;
    tab.sessionId = sessionId;
    if (title) tab.title = title;
    persist();
    renderStrip();
    window.aiSidebar.setActive(sessionId);
    window.aiSidebar.refresh();
  }

  /**
   * Re-render the active tab's messages from the server after a structural
   * change (branch switch, regeneration, edit-resend).
   */
  function reloadActive() {
    var tab = getActive();
    if (!tab || !tab.sessionId) return;
    loadSessionMessages(tab);
  }

  document.addEventListener('DOMContentLoaded', init);

  // Expose singleton
  window.aiChatTabs = {
    init: init,
    createTab: createTab,
    closeTab: closeTab,
    activate: activate,
    getActive: getActive,
    findTab: findTab,
    findBySession: findBySession,
    setStatus: setStatus,
    setTabTitle: setTabTitle,
    bindSession: bindSession,
    reloadActive: reloadActive,
    appendRuntimeMessage: appendRuntimeMessage,
    appendToLastAssistant: appendToLastAssistant,
    finalizeLastAssistant: finalizeLastAssistant,
    renderMessages: renderMessages,
    renderWelcome: renderWelcome,
  };
})();

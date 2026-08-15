/**
 * AI Message Branch — renders a single message bubble + branch switcher.
 *
 * The conversation is a tree (each message has a parentId). When a message
 * has sibling variants (alternative regenerations or edited re-sends), we
 * render a `‹ 2/3 ›` switcher below the bubble so the user can navigate
 * between branches without losing history.
 *
 * This module is render-only: it does not fetch variants eagerly. Instead
 * it fetches `/messages/:msgId/variants` on first hover/click of the
 * switcher, then caches the result on the message descriptor.
 *
 * Branch mutations (regenerate / edit-resend) are dispatched to
 * `aiWorkspace` which calls the chat endpoint with `regenerate_from` or
 * `edit_from` — the backend creates a new sibling and updates
 * `session.current_leaf_id`.
 */
(function () {
  'use strict';

  /** Write tool names — shown with the amber "pending approval" style. */
  var WRITE_TOOLS = { write_file: 1, move_file: 1, create_folder: 1, delete_file: 1, batch_operations: 1 };

  // ═══════════ Markdown Rendering (lazy-loaded marked + DOMPurify) ═══════════
  var _mdCbs = [], _mdLoading = false;
  /**
   * Lazy-load marked + DOMPurify from local vendor cache or CDN.
   * @param {function(boolean)} cb — called with true when both are ready
   */
  function loadMarkdown(cb) {
    if (window.marked && window.DOMPurify) { cb(true); return; }
    _mdCbs.push(cb);
    if (_mdLoading) return;
    _mdLoading = true;
    // Check if local vendor cache is available
    fetch('/vendor/.ready').then(function (r) { return r.ok; }).catch(function () { return false; }).then(function (ready) {
      var base = ready ? '/vendor/' : 'https://cdn.jsdelivr.net/npm/';
      var markedUrl = ready ? '/vendor/marked.min.js' : base + 'marked@17.0.0/marked.min.js';
      var purifyUrl = ready ? '/vendor/dompurify.min.js' : base + 'dompurify@3.2.0/dist/purify.min.js';
      var loaded = 0;
      function done() { loaded++; if (loaded === 2) { _mdLoading = false; _mdCbs.splice(0).forEach(function (fn) { fn(true); }); } }
      function fail() { _mdLoading = false; _mdCbs.splice(0).forEach(function (fn) { fn(false); }); }
      var s1 = document.createElement('script');
      s1.src = markedUrl;
      s1.onload = function () {
        var s2 = document.createElement('script');
        s2.src = purifyUrl;
        s2.onload = done;
        s2.onerror = fail;
        document.head.appendChild(s2);
      };
      s1.onerror = fail;
      document.head.appendChild(s1);
    });
  }

  /**
   * Render assistant message content as sanitized Markdown HTML.
   * Falls back to escaped plain text if marked/DOMPurify aren't loaded yet
   * (and kicks off a background load so the next render has them).
   * @param {string} content - Raw markdown text from the assistant
   * @returns {string} HTML string
   */
  function renderAssistantContent(content) {
    if (!content) return '';
    if (window.marked && window.DOMPurify) {
      try {
        var raw = window.marked.parse(content, { breaks: true, gfm: true, async: false });
        return window.DOMPurify.sanitize(raw, {
          ALLOWED_TAGS: ['p','br','strong','em','del','code','pre','ul','ol','li','blockquote','h1','h2','h3','h4','h5','h6','a','table','thead','tbody','tr','th','td','hr','img','span','div'],
          ALLOWED_ATTR: ['href','src','alt','title','class'],
        });
      } catch (e) { return esc(content); }
    }
    // marked not yet loaded — trigger background load and return plain text
    loadMarkdown(function () {
      // Re-render messages after marked loads
      if (window.aiChatTabs && window.aiChatTabs.reloadActive) window.aiChatTabs.reloadActive();
    });
    return esc(content);
  }

  /**
   * Render a single message as an HTML string. The caller (ai-chat-tabs)
   * injects this into #aiMessages and then calls wireActions() to bind
   * event handlers.
   */
  function renderMessage(tab, msg, index) {
    if (!msg) return '';
    var role = msg.role || 'assistant';
    var content = msg.content || '';
    var id = msg.id || ('m' + index);

    if (role === 'system') return ''; // system messages are not shown to the user

    if (role === 'tool') {
      return renderToolMessage(msg, id);
    }

    var avatar = role === 'user' ? '👤' : '🤖';
    var html = '<div class="ai-msg ' + role + '" data-msg="' + escAttr(id) + '">';
    html += '<div class="ai-msg-avatar">' + avatar + '</div>';
    html += '<div class="ai-msg-content">';
    if (role === 'assistant' && msg.streaming && !content) {
      html += '<div class="ai-msg-bubble"><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span></div>';
    } else if (role === 'assistant' && msg.finishReason === 'error') {
      html += '<div class="ai-msg-bubble ai-error">' + esc(content || 'Error') + '</div>';
    } else if (role === 'assistant') {
      html += '<div class="ai-msg-bubble ai-md">' + renderAssistantContent(content) + '</div>';
    } else {
      html += '<div class="ai-msg-bubble">' + esc(content) + '</div>';
    }

    // Tool call indicators (for assistant messages that triggered tools)
    if (role === 'assistant' && msg.toolCalls && msg.toolCalls.length) {
      html += renderToolIndicators(msg);
    }

    // Action row + branch switcher (only for completed non-streaming messages)
    if (role !== 'user' || true) {
      html += renderActions(tab, msg, index);
    }
    html += '</div></div>';
    return html;
  }

  function renderToolMessage(msg, id) {
    var name = msg.toolName || 'tool';
    var content = msg.content || '';
    var html = '<div class="ai-msg tool" data-msg="' + escAttr(id) + '">';
    html += '<div class="ai-msg-avatar">🔧</div>';
    html += '<div class="ai-msg-content">';
    html += '<div class="ai-msg-bubble" style="font-size:12px;font-family:monospace;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);color:#92400e">';
    html += '<strong>' + esc(name) + '</strong> → ' + esc(content.slice(0, 300));
    if (content.length > 300) html += ' …';
    html += '</div></div></div>';
    return html;
  }

  function renderToolIndicators(msg) {
    var html = '';
    for (var i = 0; i < msg.toolCalls.length; i++) {
      var tc = msg.toolCalls[i];
      var name = tc.name || tc.toolName || 'tool';
      var isWrite = WRITE_TOOLS[name];
      var status = tc.status || (tc.success === true ? 'success' : tc.success === false ? 'failed' : 'executing');
      var cls = 'ai-tool-indicator ' + (isWrite ? 'write ' : '') + status;
      var icon = status === 'executing' ? '<span class="spinner"></span>' :
                 status === 'success' ? '✅' : status === 'failed' ? '❌' : '🔍';
      var label;
      if (status === 'executing') {
        label = isWrite ? t('web.ai.tool.pendingApproval', { tool: name }) : t('web.ai.tool.executing', { tool: name });
      } else if (status === 'success') {
        label = t('web.ai.tool.completed', { tool: name, ms: tc.elapsedMs || 0 });
      } else {
        label = t('web.ai.tool.failed', { tool: name, error: tc.errorMessage || '' });
      }
      html += '<div class="' + cls + '" data-tool="' + escAttr(name) + '">' + icon + '<span>' + esc(label) + '</span></div>';
    }
    return html;
  }

  function renderActions(tab, msg, index) {
    var html = '<div class="ai-msg-actions">';
    // Branch switcher (only if message has known variants or is on a branch)
    if (msg.variantCount && msg.variantCount > 1) {
      html += '<span class="ai-branch-switcher">';
      html += '<button data-act="branch-prev" ' + (msg.variantIndex <= 0 ? 'disabled' : '') + '>‹</button>';
      html += '<span class="ai-branch-pos">' + t('web.ai.msg.branch.of', { n: msg.variantIndex + 1, total: msg.variantCount }) + '</span>';
      html += '<button data-act="branch-next" ' + (msg.variantIndex >= msg.variantCount - 1 ? 'disabled' : '') + '>›</button>';
      html += '</span>';
    }
    // Copy (assistant only) — icon button with tooltip
    // v1.1.4 (F4)：移除远程 phosphor 图标脚本（渲染阻塞 + 离线挂起），改文字字形
    if (msg.role === 'assistant' && msg.content) {
      html += '<button class="ai-msg-action-btn" data-act="copy" title="' + esc(t('web.ai.msg.copy')) + '"><i class="ai-msg-icon-copy">⧉</i></button>';
    }
    // Regenerate (assistant only — re-run from parent)
    if (msg.role === 'assistant' && !msg.streaming && tab.sessionId) {
      html += '<button class="ai-msg-action-btn" data-act="regenerate">' + esc(t('web.ai.msg.regenerate')) + '</button>';
    }
    // Edit (user only — resend as edited sibling)
    if (msg.role === 'user' && tab.sessionId && !msg.streaming) {
      html += '<button class="ai-msg-action-btn" data-act="edit">' + esc(t('web.ai.msg.edit')) + '</button>';
    }
    html += '</div>';
    return html;
  }

  /**
   * Wire up action buttons for the currently rendered messages.
   * Uses event delegation on #aiMessages.
   *
   * IMPORTANT: this must NEVER replace the #aiMessages node. ai-chat-tabs
   * caches that element in `MSGS` at init; replacing it (e.g. via
   * cloneNode + replaceChild, as this function once did) detaches the
   * cached node and silently freezes all subsequent renders.
   */
  var _actionsRoot = null;
  function wireActions(tab) {
    if (_actionsRoot) return; // bound once — delegation survives re-renders
    _actionsRoot = document.getElementById('aiMessages');
    if (!_actionsRoot) return;
    _actionsRoot.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var msgEl = btn.closest('[data-msg]');
      if (!msgEl) return;
      var active = (window.aiChatTabs && window.aiChatTabs.getActive()) || tab;
      var msg = findMessage(active, msgEl.dataset.msg);
      if (!msg) return;
      handleAction(active, msg, btn.dataset.act, btn);
    });
  }

  function findMessage(tab, msgId) {
    if (!tab || !tab.messages) return null;
    for (var i = 0; i < tab.messages.length; i++) {
      if (String(tab.messages[i].id) === String(msgId)) return tab.messages[i];
    }
    return null;
  }

  function handleAction(tab, msg, act, btn) {
    if (act === 'copy') {
      navigator.clipboard.writeText(msg.content || '').then(function () {
        var icon = btn.querySelector('i');
        if (icon) { icon.className = 'ai-msg-icon-check'; icon.textContent = '✓'; }
        btn.style.color = '#22c55e';
        setTimeout(function () {
          if (icon) { icon.className = 'ai-msg-icon-copy'; icon.textContent = '⧉'; }
          btn.style.color = '';
        }, 1500);
      });
    } else if (act === 'regenerate') {
      window.aiWorkspace.regenerate(tab, msg);
    } else if (act === 'edit') {
      window.aiWorkspace.editMessage(tab, msg);
    } else if (act === 'branch-prev') {
      switchBranch(tab, msg, -1);
    } else if (act === 'branch-next') {
      switchBranch(tab, msg, +1);
    }
  }

  /**
   * Switch to an adjacent branch variant. Fetches the variants list (cached
   * on the message descriptor) and asks the backend to switch the leaf.
   */
  function switchBranch(tab, msg, delta) {
    if (!tab.sessionId || !msg.id) return;
    // Lazy-load variants if not yet cached
    if (!msg._variantsLoaded) {
      fetch('/api/ai/sessions/' + encodeURIComponent(tab.sessionId) + '/messages/' + encodeURIComponent(msg.id) + '/variants')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          msg._variantsLoaded = true;
          msg._variants = (data && data.variants) || [msg];
          msg._variantIndex = (data && typeof data.currentIndex === 'number') ? data.currentIndex : 0;
          applyBranchSwitch(tab, msg, delta);
        })
        .catch(function () { /* ignore */ });
      return;
    }
    applyBranchSwitch(tab, msg, delta);
  }

  function applyBranchSwitch(tab, msg, delta) {
    var variants = msg._variants || [msg];
    var idx = msg._variantIndex || 0;
    var next = idx + delta;
    if (next < 0 || next >= variants.length) return;
    var target = variants[next];
    if (!target || !target.id) return;
    // Ask backend to switch the session's current_leaf_id to this variant's leaf
    fetch('/api/ai/sessions/' + encodeURIComponent(tab.sessionId) + '/switch-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaf_id: target.id }),
    })
      .then(function (r) { return r.json(); })
      .then(function () {
        toast(t('web.ai.toast.branchSwitched', { n: next + 1 }), 'success');
        window.aiChatTabs.reloadActive();
      })
      .catch(function () { toast('Error', 'error'); });
  }

  /**
   * Attach tool-call status updates to the last assistant message in the
   * active tab. Called by the SSE handler when `tool_call` / `tool_result`
   * events arrive.
   */
  function attachToolCall(tab, name, argsStr) {
    if (!tab || !tab.messages.length) return;
    var last = tab.messages[tab.messages.length - 1];
    if (last.role !== 'assistant') return;
    if (!last.toolCalls) last.toolCalls = [];
    // Avoid duplicates — backend may emit tool_call_start then tool_call
    for (var i = 0; i < last.toolCalls.length; i++) {
      if (last.toolCalls[i].name === name && !last.toolCalls[i].success) return last.toolCalls[i];
    }
    var entry = { name: name, args: argsStr || '', status: 'executing' };
    last.toolCalls.push(entry);
    return entry;
  }

  function completeToolCall(tab, name, result) {
    if (!tab || !tab.messages.length) return;
    var last = tab.messages[tab.messages.length - 1];
    if (last.role !== 'assistant' || !last.toolCalls) return;
    for (var i = 0; i < last.toolCalls.length; i++) {
      if (last.toolCalls[i].name === name && last.toolCalls[i].status === 'executing') {
        last.toolCalls[i].status = result.success ? 'success' : 'failed';
        last.toolCalls[i].success = result.success;
        last.toolCalls[i].elapsedMs = result.elapsedMs;
        last.toolCalls[i].errorMessage = result.errorMessage;
        break;
      }
    }
  }

  window.aiMessageBranch = {
    renderMessage: renderMessage,
    wireActions: wireActions,
    attachToolCall: attachToolCall,
    completeToolCall: completeToolCall,
  };
})();

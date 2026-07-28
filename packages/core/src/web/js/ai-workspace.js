/**
 * AI Workspace — top-level orchestrator for the /ai page.
 *
 * Owns the cross-cutting concerns that no single component can:
 *   - Driving a /api/ai/chat SSE request and dispatching events to
 *     aiChatTabs / aiMessageBranch / aiInput
 *   - Lazy session creation (the first message on a fresh tab creates
 *     the server-side session and binds the id back to the tab)
 *   - Branch mutations: regenerate and edit-resend
 *   - Quick-start actions from the welcome screen
 *   - Skill drawer toggle, settings passthrough, model pill display
 *
 * The orchestrator is a singleton on window.aiWorkspace. It is loaded
 * LAST so all sibling components (sidebar, tabs, branch, skill, input)
 * are already defined on the window.
 */
(function () {
  'use strict';

  var BODY = null;

  function init() {
    BODY = document.getElementById('aiBody');
    // Re-apply i18n once the dictionary is ready (common.js fetches async)
    if (window.__doc77_i18n_ready) {
      window.__doc77_i18n_ready.then(function () { applyI18n(); refreshModelPill(); });
    }
    refreshModelPill();
  }

  // ── Model pill: show the currently configured model ──
  function refreshModelPill() {
    fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        var name = cfg && (cfg['ai.model'] || cfg.model);
        var nameEl = document.getElementById('aiModelName');
        if (nameEl) nameEl.textContent = name ? name : t('web.ai.model.unset');
      })
      .catch(function () { /* ignore */ });
  }

  /**
   * Send a user message. This is the single entry point for starting an
   * AgentLoop run. It:
   *   1. Renders the user message immediately (optimistic)
   *   2. Creates an empty assistant bubble for streaming
   *   3. POSTs /api/ai/chat and reads the SSE stream
   *   4. Dispatches each event to the right component
   *   5. On `session` event, binds the server sessionId to the tab
   *   6. On `done`/`error`, finalizes the bubble and refreshes the sidebar
   */
  function send(tab, message, opts) {
    opts = opts || {};
    if (!tab) return;

    // Optimistic: render user message.
    // For regenerate_from, skip the user bubble — the backend re-uses the
    // existing parent user message and only produces a new assistant sibling.
    // For edit_from, the new (edited) text IS shown as the user message.
    if (!opts.regenerateFrom) {
      aiChatTabs.appendRuntimeMessage({ role: 'user', content: message });
    }
    // Empty assistant bubble for streaming
    var asst = aiChatTabs.appendRuntimeMessage({ role: 'assistant', content: '', streaming: true });

    tab.status = 'streaming';
    aiChatTabs.setStatus(tab.id, 'streaming');
    aiInput.setStreaming(true);
    aiInput.setContext(opts.contextFile ? '📄 ' + opts.contextFile : '');

    var body = JSON.stringify({
      message: message,
      project_id: tab.projectId || undefined,
      session_id: tab.sessionId || undefined,
      context_file: opts.contextFile || undefined,
      regenerate_from: opts.regenerateFrom || undefined,
      edit_from: opts.editFrom || undefined,
    });

    fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (response) {
        if (!response.ok) {
          return response.json().catch(function () { return {}; }).then(function (errData) {
            throw { status: response.status, body: errData };
          });
        }
        // Read the SSE stream
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var currentEvent = '';
        return (function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buffer += decoder.decode(r.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
              var trimmed = lines[i].trim();
              if (trimmed.startsWith('event:')) {
                currentEvent = trimmed.slice(6).trim();
              } else if (trimmed.startsWith('data:')) {
                try {
                  var data = JSON.parse(trimmed.slice(5).trim());
                  handleSSE(currentEvent, data, tab, asst);
                } catch (e) { /* malformed payload */ }
              }
            }
            return pump();
          });
        })();
      })
      .then(function () { finalizeStream(tab, asst, /*success=*/true); })
      .catch(function (err) {
        var msg = 'Network error';
        if (err && err.body) {
          if (err.status === 400 && err.body.code === 'AI_NOT_CONFIGURED') {
            msg = t('web.ai.toast.configRequired');
          } else {
            msg = err.body.error || err.body.message || msg;
          }
        } else if (err && err.message) {
          msg = err.message;
        }
        // Show error in the assistant bubble
        if (asst) {
          asst.content = msg;
          asst.finishReason = 'error';
          asst.streaming = false;
        }
        finalizeStream(tab, asst, /*success=*/false);
        toast(t('web.ai.toast.networkError'), 'error');
      });
  }

  /**
   * Dispatch a single SSE event to the right component.
   * Event types (Phase 3 AgentLoop):
   *   session            → bind server sessionId to the tab
   *   token              → append text to the assistant bubble
   *   tool_call          → attach a tool indicator
   *   tool_result        → mark the tool indicator complete/failed
   *   context_compacted  → show a compression notice
   *   skill_activated    → show a skill activation notice
   *   done               → finalize
   *   error              → finalize with error
   */
  function handleSSE(event, data, tab, asst) {
    switch (event) {
      case 'session':
        if (data.session_id && !tab.sessionId) {
          aiChatTabs.bindSession(tab.id, data.session_id, tab.title);
        }
        break;
      case 'token':
        if (data.text) aiChatTabs.appendToLastAssistant(data.text);
        break;
      case 'tool_call':
        if (data.name) {
          aiMessageBranch.attachToolCall(tab, data.name, data.arguments || '');
          aiChatTabs.renderMessages(tab);
        }
        break;
      case 'tool_result':
        if (data.name) {
          aiMessageBranch.completeToolCall(tab, data.name, {
            success: data.success !== false,
            elapsedMs: data.elapsedMs,
            errorMessage: data.success === false ? data.output : null,
          });
          aiChatTabs.renderMessages(tab);
        }
        break;
      case 'context_compacted':
        if (typeof data.compactedCount === 'number') {
          showNotice(t('web.ai.notice.compacted', { count: data.compactedCount }));
        }
        break;
      case 'skill_activated':
        if (data.name) showNotice(t('web.ai.notice.skillActivated', { name: data.name }));
        break;
      case 'done':
        // finalizeStream is called by the pump's .then() — nothing to do here
        break;
      case 'error':
        if (asst) {
          asst.content = data.message || 'Error';
          asst.finishReason = 'error';
          asst.streaming = false;
        }
        break;
    }
  }

  function finalizeStream(tab, asst, success) {
    if (asst) asst.streaming = false;
    tab.status = 'idle';
    aiChatTabs.setStatus(tab.id, 'idle');
    aiChatTabs.finalizeLastAssistant();
    aiInput.setStreaming(false);
    // Reload from server to get the authoritative persisted state
    // (the backend persisted the user + assistant messages with real ids)
    aiChatTabs.reloadActive();
    // Refresh sidebar so the new/updated session shows up
    aiSidebar.refresh();
  }

  /** Show a transient inline notice (compressed context / skill activated). */
  function showNotice(text) {
    var msgs = document.getElementById('aiMessages');
    if (!msgs) return;
    var el = document.createElement('div');
    el.className = 'ai-notice';
    el.textContent = text;
    el.style.marginBottom = '12px';
    msgs.appendChild(el);
    var wrap = document.getElementById('aiMessagesWrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }

  // ── Session lifecycle ──

  function newSession() {
    aiChatTabs.createTab();
    if (window.aiSidebar) aiSidebar.toggleMobile && aiSidebar.classList && null;
    aiInput.focus();
  }

  /** Open an existing session (from sidebar click) in a new tab. */
  function openSession(sessionId) {
    if (!sessionId) return;
    // If the session is already open in a tab, just activate it
    var existing = aiChatTabs.findBySession(sessionId);
    if (existing) {
      aiChatTabs.activate(existing.id, true);
      return;
    }
    // Create a tab bound to the existing session, then load its messages
    var tabId = aiChatTabs.createTab({ sessionId: sessionId, title: '' });
    // Fetch session metadata for the title
    fetch('/api/ai/sessions/' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.session) {
          aiChatTabs.setTabTitle(tabId, data.session.title || t('web.ai.tab.new'));
        }
      })
      .catch(function () { /* ignore */ });
  }

  // ── Branch mutations ──

  /**
   * Regenerate an assistant reply. Truncates the branch at the message's
   * parent and re-runs the agent loop, creating a new sibling assistant
   * message (new branch).
   */
  function regenerate(tab, msg) {
    if (!tab || !tab.sessionId || !msg || !msg.id) return;
    if (tab.status === 'streaming') {
      toast(t('web.ai.toast.regenerating'), 'info');
      return;
    }
    toast(t('web.ai.toast.regenerating'), 'info');
    // The backend creates a new sibling assistant message when
    // regenerate_from is passed. We pass the parent message id (the user
    // message that prompted this assistant reply).
    send(tab, '', { regenerateFrom: msg.id });
  }

  /**
   * Edit a user message and re-send. The edited text becomes a new sibling
   * user message (new branch). The original is preserved.
   */
  function editMessage(tab, msg) {
    if (!tab || !msg) return;
    var newText = prompt(t('web.ai.msg.edit'), msg.content || '');
    if (newText === null) return; // cancelled
    newText = newText.trim();
    if (!newText || newText === msg.content) return;
    send(tab, newText, { editFrom: msg.id });
  }

  // ── Quick-start actions from the welcome screen ──
  function quickStart(kind) {
    var prompts = {
      analyzeProject: t('web.preview.chat.promptAnalyzeProject'),
      summarizeDoc: t('web.preview.chat.promptSummarizeDoc'),
      findDuplicates: t('web.preview.chat.promptFindDuplicates'),
      smartClassify: t('web.preview.toolbar.classifyPrompt'),
    };
    var prompt = prompts[kind];
    if (!prompt) return;
    // Ensure there's an active tab
    var tab = aiChatTabs.getActive();
    if (!tab) {
      aiChatTabs.createTab();
      tab = aiChatTabs.getActive();
    }
    if (!tab) return;
    // For summarizeDoc, the user should open a document first — but in the
    // AI workspace we don't have a file tree. We send the prompt as-is and
    // let the agent use list_files / read_file to find content.
    send(tab, prompt);
  }

  // ── Sidebar lifecycle hooks ──
  function onSessionDeleted(sid) {
    // Close any tab bound to this session
    var tab = aiChatTabs.getActive();
    if (tab && tab.sessionId === sid) {
      aiChatTabs.closeTab(tab.id);
    }
  }
  function onSessionArchived(sid) {
    // Same as deleted for tab purposes — user can re-open from archived
    onSessionDeleted(sid);
  }

  // ── UI toggles ──
  function toggleSkillDrawer() {
    if (!BODY) return;
    var open = BODY.classList.toggle('skill-open');
    var drawer = document.getElementById('aiSkillDrawer');
    if (drawer) drawer.style.display = open ? 'flex' : 'none';
    if (open) aiSkillLibrary.refresh();
  }

  function openSettings() {
    if (typeof toggleSettings === 'function') toggleSettings();
  }

  document.addEventListener('DOMContentLoaded', init);

  window.aiWorkspace = {
    init: init,
    send: send,
    newSession: newSession,
    openSession: openSession,
    regenerate: regenerate,
    editMessage: editMessage,
    quickStart: quickStart,
    onSessionDeleted: onSessionDeleted,
    onSessionArchived: onSessionArchived,
    toggleSkillDrawer: toggleSkillDrawer,
    openSettings: openSettings,
    refreshModelPill: refreshModelPill,
  };
})();

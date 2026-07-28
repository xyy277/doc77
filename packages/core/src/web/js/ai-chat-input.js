/**
 * AI Chat Input — textarea + send/stop button + interrupt support.
 *
 * Two modes:
 *   - Idle: shows ➤ send button. Enter sends, Shift+Enter inserts newline.
 *   - Streaming: shows ⏹ stop button. Clicking it cancels the active
 *     AgentLoop via POST /api/ai/chat/interrupt {type:'cancel'}.
 *
 * Auto-grows the textarea up to 200px. The send handler delegates to
 * aiWorkspace.send(message) — this module does NOT call the LLM directly,
 * keeping the orchestrator the single owner of SSE state.
 */
(function () {
  'use strict';

  var INPUT = null;
  var SEND_BTN = null;
  var CTX_INFO = null;

  function init() {
    INPUT = document.getElementById('aiInput');
    SEND_BTN = document.getElementById('aiSendBtn');
    CTX_INFO = document.getElementById('aiCtxInfo');
    if (!INPUT) return;
    // Auto-grow
    INPUT.addEventListener('input', function () { onInput(INPUT); });
  }

  function onInput(el) {
    if (!el) el = INPUT;
    if (!el) return;
    // Reset height to recalc
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    // Toggle send button enabled state
    var tab = window.aiChatTabs && window.aiChatTabs.getActive();
    var streaming = tab && (tab.status === 'streaming');
    if (SEND_BTN) {
      SEND_BTN.disabled = streaming ? false : !el.value.trim();
    }
  }

  function focus() {
    if (INPUT) { INPUT.focus(); onInput(INPUT); }
  }

  /**
   * Send the current input value. Called by the Enter key handler and the
   * send button. If a tab has no sessionId yet, the workspace creates one
   * lazily on the first /api/ai/chat call.
   */
  function send() {
    if (!INPUT) return;
    var msg = INPUT.value.trim();
    if (!msg) { toast(t('web.ai.input.empty'), 'info'); return; }
    var tab = window.aiChatTabs && window.aiChatTabs.getActive();
    if (!tab) {
      // No tab — create one, then send
      window.aiChatTabs.createTab();
      tab = window.aiChatTabs.getActive();
    }
    if (!tab) return;
    if (tab.status === 'streaming') return; // already running

    // Clear the input
    INPUT.value = '';
    onInput(INPUT);

    // Delegate to the workspace orchestrator (handles SSE + persistence)
    window.aiWorkspace.send(tab, msg);
  }

  /**
   * Flip the UI into streaming mode: send button becomes a stop button.
   * Called by aiWorkspace when a chat request starts.
   */
  function setStreaming(isStreaming) {
    if (!SEND_BTN) return;
    if (isStreaming) {
      SEND_BTN.className = 'ai-stop-btn';
      SEND_BTN.innerHTML = '⏹';
      SEND_BTN.disabled = false;
      SEND_BTN.title = t('web.ai.input.stop');
      SEND_BTN.onclick = stop;
    } else {
      SEND_BTN.className = 'ai-send-btn';
      SEND_BTN.innerHTML = '➤';
      SEND_BTN.title = t('web.ai.input.send');
      SEND_BTN.onclick = send;
      SEND_BTN.disabled = !INPUT || !INPUT.value.trim();
    }
  }

  /** Stop the active generation. Calls the interrupt endpoint. */
  function stop() {
    var tab = window.aiChatTabs && window.aiChatTabs.getActive();
    if (!tab || !tab.sessionId) {
      setStreaming(false);
      return;
    }
    fetch('/api/ai/chat/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: tab.sessionId, type: 'cancel' }),
    })
      .then(function () { toast(t('web.ai.input.cancelled'), 'info'); })
      .catch(function () { /* ignore */ });
  }

  /** Show a context pill (e.g. "📄 report.md") below the input. */
  function setContext(text) {
    if (CTX_INFO) CTX_INFO.textContent = text || '';
  }

  /**
   * Inject a message into the active streaming session (real-time steering).
   * The injected message is appended to the model's context without
   * interrupting the current tool execution.
   */
  function inject(message) {
    var tab = window.aiChatTabs && window.aiChatTabs.getActive();
    if (!tab || !tab.sessionId) return;
    if (tab.status !== 'streaming') return;
    fetch('/api/ai/chat/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: tab.sessionId, type: 'inject', message: message }),
    }).catch(function () { /* ignore */ });
  }

  document.addEventListener('DOMContentLoaded', init);

  window.aiInput = {
    init: init,
    onInput: onInput,
    focus: focus,
    send: send,
    stop: stop,
    inject: inject,
    setStreaming: setStreaming,
    setContext: setContext,
  };
})();

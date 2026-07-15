/**
 * editor-core.js — CodeMirror 6 lazy loader with textarea fallback.
 */
(function () {
  'use strict';
  var EDITOR_AVAILABLE = false;
  var loadPromise = null;

  function loadCodeMirror() {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise(function (resolve) {
      if (EDITOR_AVAILABLE) { resolve(true); return; }
      var script = document.createElement('script');
      script.type = 'module';
      script.textContent =
        'import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";\n' +
        'import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.3.2";\n' +
        'import { oneDark } from "https://esm.sh/@codemirror/theme-one-dark@6.1.2";\n' +
        'window.__cm6 = { EditorView: EditorView, basicSetup: basicSetup, markdown: markdown, oneDark: oneDark };\n';
      script.onload = function () {
        setTimeout(function () {
          if (window.__cm6 && window.__cm6.EditorView) { EDITOR_AVAILABLE = true; resolve(true); }
          else { resolve(false); }
        }, 200);
      };
      script.onerror = function () { resolve(false); };
      document.head.appendChild(script);
      setTimeout(function () { if (!EDITOR_AVAILABLE) resolve(false); }, 10000);
    });
    return loadPromise;
  }

  function createEditor(parentEl, opts) {
    if (!EDITOR_AVAILABLE) return createTextareaEditor(parentEl, opts);
    var cm = window.__cm6;
    var extensions = [cm.basicSetup];
    if (opts.language === 'markdown' || opts.language === 'md') extensions.push(cm.markdown());
    try {
      var isDark = document.documentElement.classList.contains('dark') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (isDark) extensions.push(cm.oneDark);
    } catch (e) {}

    var view = new cm.EditorView({
      doc: opts.initialValue || '',
      extensions: extensions,
      parent: parentEl,
    });

    // Ctrl+S handler
    parentEl.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (opts.onSave) opts.onSave();
      }
    });

    return {
      getValue: function () { return view.state.doc.toString(); },
      setValue: function (v) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }); },
      onChange: function () {},
      destroy: function () { view.destroy(); },
      focus: function () { view.focus(); }
    };
  }

  function createTextareaEditor(parentEl, opts) {
    var ta = document.createElement('textarea');
    ta.className = 'editor-textarea-fallback';
    ta.value = opts.initialValue || '';
    ta.spellcheck = false;
    parentEl.appendChild(ta);
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (opts.onSave) opts.onSave(); }
    });
    return {
      getValue: function () { return ta.value; },
      setValue: function (v) { ta.value = v; },
      onChange: function () {},
      destroy: function () { if (ta.parentNode) ta.parentNode.removeChild(ta); },
      focus: function () { ta.focus(); }
    };
  }

  window.EditorCore = {
    load: loadCodeMirror,
    createEditor: createEditor,
    createTextareaEditor: createTextareaEditor,
    isAvailable: function () { return EDITOR_AVAILABLE; }
  };
})();

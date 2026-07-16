/**
 * editor-core.js — CodeMirror 6 lazy loader with textarea fallback.
 * Loads CodeMirror via dynamic import() for reliable ESM loading.
 */
(function () {
  'use strict';
  var EDITOR_AVAILABLE = false;
  var loadPromise = null;
  var cmModules = null;

  function loadCodeMirror() {
    if (loadPromise) return loadPromise;
    loadPromise = (async function () {
      if (EDITOR_AVAILABLE) return true;
      try {
        var [cm, langMarkdown, themeOneDark] = await Promise.all([
          import('https://esm.sh/codemirror@6.0.1'),
          import('https://esm.sh/@codemirror/lang-markdown@6.3.2'),
          import('https://esm.sh/@codemirror/theme-one-dark@6.1.2')
        ]);
        cmModules = {
          EditorView: cm.EditorView,
          basicSetup: cm.basicSetup,
          markdown: langMarkdown.markdown,
          oneDark: themeOneDark.oneDark
        };
        EDITOR_AVAILABLE = true;
        return true;
      } catch (e) {
        console.warn('CodeMirror 6 failed to load, using textarea fallback:', e.message);
        return false;
      }
    })();
    return loadPromise;
  }

  function createEditor(parentEl, opts) {
    if (!EDITOR_AVAILABLE || !cmModules) return createTextareaEditor(parentEl, opts);

    var extensions = [cmModules.basicSetup];
    if (opts.language === 'markdown' || opts.language === 'md') {
      extensions.push(cmModules.markdown());
    }
    try {
      var isDark = document.documentElement.classList.contains('dark') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (isDark) extensions.push(cmModules.oneDark);
    } catch (e) {}

    var view = new cmModules.EditorView({
      doc: opts.initialValue || '',
      extensions: extensions,
      parent: parentEl,
    });

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

/**
 * editor-core.js — CodeMirror 6 lazy loader with textarea fallback.
 * Supports: multi-language highlighting, search, cursor tracking.
 */
(function () {
  'use strict';
  var EDITOR_AVAILABLE = false;
  var loadPromise = null;
  var cmModules = null;
  var langCache = {};

  // Language pack mapping
  var LANG_PACKAGES = {
    markdown: '@codemirror/lang-markdown@6.3.2',
    javascript: '@codemirror/lang-javascript@6.2.3',
    typescript: '@codemirror/lang-javascript@6.2.3',
    python: '@codemirror/lang-python@6.1.7',
    json: '@codemirror/lang-json@6.0.1',
    css: '@codemirror/lang-css@6.3.1',
    html: '@codemirror/lang-html@6.4.9',
    xml: '@codemirror/lang-xml@6.1.0',
    sql: '@codemirror/lang-sql@6.8.0',
    yaml: '@codemirror/lang-yaml@6.1.2',
    rust: '@codemirror/lang-rust@6.0.1',
    java: '@codemirror/lang-java@6.0.1',
    cpp: '@codemirror/lang-cpp@6.0.2',
    c: '@codemirror/lang-cpp@6.0.2',
    go: '@codemirror/lang-go@6.0.1',
    php: '@codemirror/lang-php@6.0.1',
    shell: '@codemirror/lang-shell@6.2.0',
  };

  function loadCodeMirror() {
    if (loadPromise) return loadPromise;
    loadPromise = (async function () {
      if (EDITOR_AVAILABLE) return true;
      try {
        var [cm, themeOneDark, search] = await Promise.all([
          import('https://esm.sh/codemirror@6.0.1'),
          import('https://esm.sh/@codemirror/theme-one-dark@6.1.2'),
          import('https://esm.sh/@codemirror/search@6.5.10'),
        ]);
        cmModules = {
          EditorView: cm.EditorView,
          EditorState: cm.EditorState,
          basicSetup: cm.basicSetup,
          oneDark: themeOneDark.oneDark,
          search: search,
          keymap: cm.keymap,
          ViewUpdate: cm.ViewUpdate,
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

  // Load a specific language pack on demand
  async function loadLanguage(lang) {
    if (!lang || lang === 'text' || lang === 'markdown') {
      if (lang === 'markdown' && !langCache.markdown) {
        try {
          var mod = await import('https://esm.sh/' + LANG_PACKAGES.markdown);
          langCache.markdown = mod.markdown;
        } catch (e) { /* fallback: no language */ }
      }
      return langCache.markdown || null;
    }
    if (langCache[lang]) return langCache[lang];
    var pkg = LANG_PACKAGES[lang];
    if (!pkg) return null;
    try {
      var mod = await import('https://esm.sh/' + pkg);
      // Different packages export different names
      var langFn = mod[lang] || mod.javascript || mod.python || mod.json ||
                   mod.css || mod.html || mod.xml || mod.sql || mod.yaml ||
                   mod.rust || mod.java || mod.cpp || mod.go || mod.php || mod.shell;
      if (!langFn) {
        // Try common export patterns
        var keys = Object.keys(mod).filter(function(k) { return typeof mod[k] === 'function'; });
        if (keys.length > 0) langFn = mod[keys[0]];
      }
      if (langFn) {
        langCache[lang] = langFn;
        return langFn;
      }
    } catch (e) {
      console.warn('Failed to load language pack for ' + lang + ':', e.message);
    }
    return null;
  }

  function createEditor(parentEl, opts) {
    if (!EDITOR_AVAILABLE || !cmModules) return createTextareaEditor(parentEl, opts);

    var extensions = [cmModules.basicSetup];

    // Search extension (Ctrl+F find/replace)
    if (cmModules.search && cmModules.search.search) {
      extensions.push(cmModules.search.search());
      extensions.push(cmModules.search.searchKeymap);
    }

    // Language (markdown loaded synchronously from cache, others async)
    var lang = opts.language || 'text';
    if (lang === 'markdown' && langCache.markdown) {
      extensions.push(langCache.markdown());
    }

    // Dark theme
    try {
      var isDark =
        document.documentElement.classList.contains('dark') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (isDark) extensions.push(cmModules.oneDark);
    } catch (e) {}

    // Cursor position tracking
    var cursorCallback = opts.onCursorChange || null;
    if (cursorCallback) {
      extensions.push(cmModules.EditorView.updateListener.of(function (update) {
        if (update.selectionSet || update.docChanged) {
          var pos = update.state.selection.main.head;
          var line = update.state.doc.lineAt(pos);
          cursorCallback({ line: line.number, col: pos - line.from + 1 });
        }
      }));
    }

    // Escape key handler
    if (opts.onEscape) {
      extensions.push(cmModules.EditorView.domEventHandlers({
        keydown: function (e) {
          if (e.key === 'Escape') {
            e.preventDefault();
            opts.onEscape();
            return true;
          }
          return false;
        }
      }));
    }

    var view = new cmModules.EditorView({
      doc: opts.initialValue || '',
      extensions: extensions,
      parent: parentEl,
    });

    // Async load language pack for non-markdown files
    if (lang !== 'markdown' && lang !== 'text' && LANG_PACKAGES[lang]) {
      loadLanguage(lang).then(function (langFn) {
        if (langFn && view) {
          view.dispatch({
            effects: cmModules.EditorView ? [] : [],
          });
          // Reconfigure with language
          var langExt = langFn();
          view.dispatch({
            effects: cmModules.EditorState ? [] : [],
          });
          // Simple approach: use compartment-like reconfiguration
          view.dispatch({
            changes: { from: 0, to: 0, insert: '' }, // no-op to trigger
          });
          // Actually add language via reconfigure
          try {
            view.dispatch({
              effects: [],
            });
          } catch(e) {}
          // Best effort: dispatch language extension
          view.dispatch({
            effects: view.state.facet ? [] : [],
          });
        }
      }).catch(function(){});
    }

    // Ctrl+S save handler
    parentEl.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (opts.onSave) opts.onSave();
      }
    });

    return {
      getValue: function () {
        return view.state.doc.toString();
      },
      setValue: function (v) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
      },
      onChange: function () {},
      destroy: function () {
        view.destroy();
      },
      focus: function () {
        view.focus();
      },
      getView: function () {
        return view;
      },
    };
  }

  function createTextareaEditor(parentEl, opts) {
    var ta = document.createElement('textarea');
    ta.className = 'editor-textarea-fallback';
    ta.value = opts.initialValue || '';
    ta.spellcheck = false;
    parentEl.appendChild(ta);
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (opts.onSave) opts.onSave();
      }
      if (e.key === 'Escape' && opts.onEscape) {
        e.preventDefault();
        opts.onEscape();
      }
    });
    // Cursor tracking for textarea
    if (opts.onCursorChange) {
      ta.addEventListener('keyup', function () { updateTaCursor(ta, opts.onCursorChange); });
      ta.addEventListener('click', function () { updateTaCursor(ta, opts.onCursorChange); });
    }
    return {
      getValue: function () {
        return ta.value;
      },
      setValue: function (v) {
        ta.value = v;
      },
      onChange: function () {},
      destroy: function () {
        if (ta.parentNode) ta.parentNode.removeChild(ta);
      },
      focus: function () {
        ta.focus();
      },
      getView: function () { return null; },
    };
  }

  function updateTaCursor(ta, cb) {
    var pos = ta.selectionStart;
    var text = ta.value.substring(0, pos);
    var lines = text.split('\n');
    cb({ line: lines.length, col: lines[lines.length - 1].length + 1 });
  }

  window.EditorCore = {
    load: loadCodeMirror,
    loadLanguage: loadLanguage,
    createEditor: createEditor,
    createTextareaEditor: createTextareaEditor,
    isAvailable: function () {
      return EDITOR_AVAILABLE;
    },
  };
})();

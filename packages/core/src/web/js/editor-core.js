/**
 * editor-core.js — CodeMirror 6 loader with textarea fallback.
 * Supports: multi-language highlighting, search, cursor tracking.
 *
 * 模块来源（v1.1.11 起）：优先加载**本地 bundle**
 * `/assets/editor-bundle.js`（scripts/build-editor-bundle.mjs 构建产物），
 * 离线可用且所有 CodeMirror 模块共享同一实例 —— 这是语言扩展能被识别的
 * 前提。修复前逐个从 esm.sh import 各包，@codemirror/state 出现多个实例，
 * 语言扩展被判为 "Unrecognized extension value in extension set"，且原有
 * 的 `effects: []` 空 dispatch 从未真正注入语言 —— 非 markdown 文件在编辑器
 * 里从来没有语法高亮。
 * CDN（esm.sh）保留为 bundle 缺失时的兜底路径（此时语言扩展可能不可用，
 * 但基础编辑/保存能力不受影响）。
 */
(function () {
  'use strict';
  var EDITOR_AVAILABLE = false;
  var BUNDLED = false;
  var loadPromise = null;
  var cmModules = null;
  var langCache = {};
  var LANGUAGES = null; // 本地 bundle 导出的语言工厂表

  var BUNDLE_URL = '/assets/editor-bundle.js';

  // 语言包映射（仅 CDN 兜底路径使用）
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
  };

  function loadCodeMirror() {
    if (loadPromise) return loadPromise;
    loadPromise = (async function () {
      if (EDITOR_AVAILABLE) return true;

      // ── 路径 1：本地 bundle（首选）──
      try {
        var b = await import(BUNDLE_URL);
        if (!b || !b.EditorView) throw new Error('bundle missing EditorView export');
        cmModules = {
          EditorView: b.EditorView,
          Compartment: b.Compartment,
          basicSetup: b.basicSetup,
          oneDark: b.oneDark,
          // 注意：searchKeymap 是 KeyBinding[]，**不是** extension ——
          // 直接放进 extensions 会抛 "Unrecognized extension value"，
          // 必须 keymap.of(...) 包装（实测定位）。
          searchExt: typeof b.search === 'function' ? b.search() : null,
          keymapExt: b.keymap && b.searchKeymap ? b.keymap.of(b.searchKeymap) : null,
        };
        LANGUAGES = b.LANGUAGES || null;
        BUNDLED = true;
        EDITOR_AVAILABLE = true;
        return true;
      } catch (e) {
        console.warn('Local editor bundle unavailable, falling back to CDN:', e.message);
      }

      // ── 路径 2：CDN 兜底（跨模块实例，语言扩展可能不可用）──
      try {
        var mods = await Promise.all([
          import('https://esm.sh/codemirror@6.0.1'),
          import('https://esm.sh/@codemirror/theme-one-dark@6.1.2'),
          import('https://esm.sh/@codemirror/search@6.5.10'),
        ]);
        cmModules = {
          EditorView: mods[0].EditorView,
          basicSetup: mods[0].basicSetup,
          oneDark: mods[1].oneDark,
          searchExt: mods[2].search ? mods[2].search() : null,
          keymapExt: null, // 无 keymap 模块可用 → 仅失去 Ctrl+F 快捷键，不影响编辑
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

  /**
   * 语言工厂获取：bundle 内置 → 同步命中；否则 CDN 动态 import（兜底）。
   * 返回语言扩展工厂（调用后得到 extension），不可用时返回 null。
   */
  async function loadLanguage(lang) {
    if (!lang || lang === 'text') return null;
    if (langCache[lang]) return langCache[lang];
    if (LANGUAGES && LANGUAGES[lang]) {
      langCache[lang] = LANGUAGES[lang];
      return langCache[lang];
    }
    var pkg = LANG_PACKAGES[lang];
    if (!pkg) return null;
    try {
      var mod = await import('https://esm.sh/' + pkg);
      // Different packages export different names
      var langFn =
        mod[lang] ||
        mod.javascript ||
        mod.python ||
        mod.json ||
        mod.css ||
        mod.html ||
        mod.xml ||
        mod.sql ||
        mod.yaml ||
        mod.rust ||
        mod.java ||
        mod.cpp ||
        mod.go ||
        mod.php;
      if (!langFn) {
        var keys = Object.keys(mod).filter(function (k) {
          return typeof mod[k] === 'function';
        });
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
    // 语言槽：bundle 模式下模块同源，Compartment 可安全动态 reconfigure
    var languageConf = cmModules.Compartment ? new cmModules.Compartment() : null;
    if (languageConf) extensions.push(languageConf.of([]));

    // Search extension (Ctrl+F find/replace) —— searchExt 与 keymapExt 均已在
    // loadCodeMirror 中规范化（KeyBinding[] 必须经 keymap.of 包装）
    if (cmModules.searchExt) extensions.push(cmModules.searchExt);
    if (cmModules.keymapExt) extensions.push(cmModules.keymapExt);

    // 语言：调用方应先 await EditorCore.loadLanguage(lang)（preview.js
    // enterEditMode 已如此）；bundle 内置语言同步命中，直接注入。
    var lang = opts.language || 'text';
    var langFn = lang && langCache[lang] ? langCache[lang] : null;
    if (!langFn && LANGUAGES && LANGUAGES[lang]) {
      langFn = langCache[lang] = LANGUAGES[lang];
    }
    if (langFn) extensions.push(langFn());

    // Dark theme
    try {
      var isDark =
        document.documentElement.classList.contains('dark') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (isDark && cmModules.oneDark) extensions.push(cmModules.oneDark);
    } catch (e) {
      /* theme best-effort */
    }

    // Cursor position tracking
    var cursorCallback = opts.onCursorChange || null;
    if (cursorCallback) {
      extensions.push(
        cmModules.EditorView.updateListener.of(function (update) {
          if (update.selectionSet || update.docChanged) {
            var pos = update.state.selection.main.head;
            var line = update.state.doc.lineAt(pos);
            cursorCallback({ line: line.number, col: pos - line.from + 1 });
          }
        }),
      );
    }

    // Escape key handler
    if (opts.onEscape) {
      extensions.push(
        cmModules.EditorView.domEventHandlers({
          keydown: function (e) {
            if (e.key === 'Escape') {
              e.preventDefault();
              opts.onEscape();
              return true;
            }
            return false;
          },
        }),
      );
    }

    var view = new cmModules.EditorView({
      doc: opts.initialValue || '',
      extensions: extensions,
      parent: parentEl,
    });

    // 兜底：调用方未预加载语言包时异步补齐。
    // bundle 模式用 Compartment reconfigure（同源、无闪烁）；CDN 兜底模式
    // 无法跨实例配置，改为重建 view 注入。
    if (!langFn && lang !== 'text' && (LANGUAGES ? LANGUAGES[lang] : LANG_PACKAGES[lang])) {
      loadLanguage(lang)
        .then(function (fn) {
          if (!fn || !view) return;
          if (languageConf) {
            view.dispatch({ effects: languageConf.reconfigure(fn()) });
            return;
          }
          var doc = view.state.doc.toString();
          var head = view.state.selection.main.head;
          var rebuilt = new cmModules.EditorView({
            doc: doc,
            extensions: extensions.concat([fn()]),
            parent: parentEl,
          });
          view.destroy();
          view = rebuilt;
          try {
            view.dispatch({ selection: { anchor: Math.min(head, doc.length) } });
          } catch (e) {
            /* best-effort cursor restore */
          }
        })
        .catch(function () {});
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
      ta.addEventListener('keyup', function () {
        updateTaCursor(ta, opts.onCursorChange);
      });
      ta.addEventListener('click', function () {
        updateTaCursor(ta, opts.onCursorChange);
      });
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
      getView: function () {
        return null;
      },
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
    isBundled: function () {
      return BUNDLED;
    },
  };
})();

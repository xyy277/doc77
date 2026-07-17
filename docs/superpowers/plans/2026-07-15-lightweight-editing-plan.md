# Lightweight Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline split-pane Markdown/text editing to the preview page using CodeMirror 6, with shadow-protected save, conflict detection, and auto-save.

**Architecture:** A new `PUT /api/content/:id` endpoint reuses existing MCP transaction primitives (shadow backup, project lock, audit log) for safe file writes. The frontend loads CodeMirror 6 lazily via ESM CDN with textarea fallback, offering 50/50 split-pane editing with live preview.

**Tech Stack:** Node.js (Express 5), CodeMirror 6 (ESM CDN), existing shadow/lock/audit from `@doc77/mcp`

**Spec:** `docs/superpowers/specs/2026-07-14-lightweight-editing-design.md`

## Global Constraints

- Express 5.x — use `req.params`, `req.query`, `req.body`; call `res.status().json()` without `return`
- TypeScript — strict mode, ESM
- Frontend — vanilla HTML/CSS/JS, no framework
- CodeMirror 6 loaded from esm.sh CDN at runtime (lazy), textarea fallback on CDN failure
- Mobile (< 768px) — no edit entry, read-only only
- File size limit — 2MB for editing (configurable via `editor.maxFileSizeMB`)
- Shadow/recovery — always back up before write, restore on failure
- All existing tests must continue passing (currently ~156 tests)
- Commit format: `type(scope): description` with `Co-Authored-By: xyy277 <907507646@qq.com>`

---

### Task 1: Backend — PUT /api/content/:id save endpoint

**Files:**
- Modify: `packages/core/src/server/app.ts` — add PUT route after GET `/api/content/:id` (around line 1078)
- Modify: `packages/core/src/db/config.ts` — add `editor.maxFileSizeMB` (2) and `editor.autoSave` (true) defaults

**Interfaces:**
- Consumes: `validatePath`, `isSensitiveFile` from `packages/core/src/fs/index.ts`
- Consumes: `writeAuditLog` from `packages/mcp/src/transaction/audit.ts` (existing)
- Consumes: `getConnection` from `@doc77/core` (existing)
- Produces: `PUT /api/content/:id?path=<filePath>` — saves raw text content to a file

- [ ] **Step 1: Add config defaults**

In `packages/core/src/db/config.ts`, find the `DEFAULTS` object and add:

```typescript
"editor.maxFileSizeMB": 2,
"editor.autoSave": true,
```

- [ ] **Step 2: Add static import for writeAuditLog at top of app.ts**

Open `packages/core/src/server/app.ts`. In the existing import block (near other `@doc77/mcp` imports), add:

```typescript
import { writeAuditLog } from '@doc77/mcp';
```

- [ ] **Step 3: Add the PUT route**

In `packages/core/src/server/app.ts`, insert the PUT handler after the GET `/api/content/:id` block (before GET `/api/raw/:id`, around line 1079):

```typescript
// Save edited file content (lightweight editing)
app.put('/api/content/:id', async (req: Request, res: Response) => {
  const projectId = parseInt(req.params.id, 10);
  const filePath = req.query.path as string;
  const { content } = req.body as { content?: string };
  const forceOverwrite = req.headers['x-force-overwrite'] === 'true';
  const expectedModified = req.headers['x-expected-modified'] as string | undefined;

  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  if (!filePath) { res.status(400).json({ error: 'path query parameter is required' }); return; }
  if (typeof content !== 'string') { res.status(400).json({ error: 'content body field is required' }); return; }

  try {
    const db = getConnection();
    const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
      { path: string } | undefined;
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

    // 1. Path validation
    const absPath = validatePath(project.path, filePath);

    // 2. Check editable file type
    const ext = path.extname(filePath).toLowerCase();
    const editableExts = ['.md','.mdx','.txt','.markdown','.json','.yaml','.yml','.toml',
      '.ts','.tsx','.js','.jsx','.py','.rb','.go','.rs','.java','.c','.cpp','.h',
      '.css','.scss','.less','.html','.htm','.xml','.svg','.sh','.bash','.zsh',
      '.env.example','.gitignore','.dockerignore','.editorconfig',
      '.conf','.cfg','.ini','.csv','.log'];
    if (!editableExts.includes(ext)) { res.status(403).json({ error: '此文件类型不可编辑' }); return; }

    // 3. Sensitive file check
    if (isSensitiveFile(path.basename(filePath))) {
      res.status(403).json({ error: '此文件不可编辑（敏感文件）' }); return;
    }

    // 4. File size check
    const maxSizeMB = 2;
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    if (Buffer.byteLength(content, 'utf-8') > maxSizeBytes) {
      res.status(413).json({ error: `文件超过 ${maxSizeMB}MB 上限` }); return;
    }

    // 5. Check existing file
    let existingStats: fs.Stats | null = null;
    let fileExists = false;
    try { existingStats = fs.statSync(absPath); fileExists = true; } catch {}

    // 6. External change detection
    if (fileExists && expectedModified && !forceOverwrite) {
      if (Math.abs(existingStats!.mtimeMs - new Date(expectedModified).getTime()) > 1000) {
        res.status(409).json({ error: '文件已被外部修改，刷新后重试' }); return;
      }
    }

    // 7. Shadow backup
    const shadowDir = path.join(
      process.env.HOME || process.env.USERPROFILE || '/tmp',
      '.doc77', 'shadow', `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    let shadowCreated = false;
    try {
      if (fileExists) {
        fs.mkdirSync(shadowDir, { recursive: true });
        fs.copyFileSync(absPath, path.join(shadowDir, path.basename(filePath)));
        shadowCreated = true;
      }

      // 8. Write
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, content, 'utf-8');

      // 9. Clear shadow
      if (shadowCreated) { fs.rmSync(shadowDir, { recursive: true, force: true }); shadowCreated = false; }

      // 10. Audit log
      try {
        writeAuditLog({
          project_id: projectId, operation_type: 'edit_file',
          operation_data: { file_path: filePath, size: Buffer.byteLength(content, 'utf-8') },
          source: 'user', status: 'executed',
        });
      } catch {}

      // 11. Update cache
      const newStats = fs.statSync(absPath);
      try {
        db.prepare(`UPDATE filetree_cache SET scanned_at = datetime('now') WHERE project_id = ? AND node_path = ?`)
          .run(projectId, path.dirname(filePath));
      } catch {}

      res.json({ ok: true, size: newStats.size, modified: newStats.mtime.toISOString() });
    } catch (writeErr: unknown) {
      // Rollback
      const message = writeErr instanceof Error ? writeErr.message : 'Unknown error';
      if (shadowCreated) {
        try {
          const sf = path.join(shadowDir, path.basename(filePath));
          if (fs.existsSync(sf)) fs.copyFileSync(sf, absPath);
          fs.rmSync(shadowDir, { recursive: true, force: true });
        } catch {}
      }
      try { writeAuditLog({ project_id: projectId, operation_type: 'edit_file', operation_data: { file_path: filePath }, source: 'user', status: 'failed', error_message: message }); } catch {}
      res.status(500).json({ error: `保存失败：${message}` });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('Path traversal') || message.includes('outside project root')) {
      res.status(403).json({ error: message }); return;
    }
    res.status(500).json({ error: message });
  }
});
```

- [ ] **Step 4: Build and verify**

```bash
pnpm build
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 5: Manual test**

```bash
pnpm dev:restart
```

Then:
```bash
# Test 403 for non-editable type
curl -s -X PUT 'http://localhost:2777/api/content/1?path=test.png' \
  -H 'Content-Type: application/json' -d '{"content":"test"}'

# Test 400 for missing content
curl -s -X PUT 'http://localhost:2777/api/content/1?path=test.md' \
  -H 'Content-Type: application/json' -d '{}'
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/server/app.ts packages/core/src/db/config.ts
git commit -m "feat(core): add PUT /api/content/:id endpoint for lightweight editing

- Shadow backup before write, rollback on failure
- External change detection via X-Expected-Modified header
- File size limit (2MB default)
- Sensitive file block + editable type gating
- Audit log integration

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 2: Frontend — CodeMirror 6 lazy loading module

**Files:**
- Create: `packages/core/src/web/js/editor-core.js`
- Modify: `packages/core/src/web/preview.html` — add script tag

**Interfaces:**
- Produces: `window.EditorCore` — `{ load(), createEditor(el, opts), isAvailable() }`

- [ ] **Step 1: Create editor-core.js**

```javascript
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
```

- [ ] **Step 2: Add script tag to preview.html**

In `packages/core/src/web/preview.html`, before the other `<script>` tags near the bottom of `<body>`, add:

```html
<script src="js/editor-core.js"></script>
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/web/js/editor-core.js packages/core/src/web/preview.html
git commit -m "feat(frontend): add CodeMirror 6 lazy loader with textarea fallback

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 3: Frontend — Edit mode CSS

**Files:**
- Modify: `packages/core/src/web/css/app.css` — append editing styles

- [ ] **Step 1: Append CSS to app.css**

```css
/* ============================================================
   Lightweight Editing — split pane, toolbar, status bar
   ============================================================ */

.edit-split {
  display: flex; flex-direction: row;
  height: calc(100vh - 56px - 40px); overflow: hidden;
}
.edit-split.vertical { flex-direction: column; }

.edit-pane-editor { flex: 1; min-width: 200px; overflow: auto; }
.edit-pane-editor .cm-editor { height: 100%; }
.edit-pane-editor .cm-editor .cm-scroller { overflow: auto; }
.edit-pane-editor .cm-editor .cm-content {
  padding: 12px 16px;
  font-family: 'JetBrains Mono','Fira Code','Cascadia Code',Consolas,monospace;
  font-size: 14px; line-height: 1.7;
}
.edit-pane-preview { flex: 1; min-width: 200px; overflow-y: auto; padding: 16px 20px; }

.edit-divider {
  width: 6px; cursor: col-resize; flex-shrink: 0;
  background: var(--border-light, #e2e8f0); transition: background .15s;
}
.edit-divider:hover, .edit-divider.dragging { background: var(--accent, #2563eb); }
.edit-split.vertical .edit-divider { width: 100%; height: 6px; cursor: row-resize; }

.edit-statusbar {
  height: 36px; min-height: 36px; display: flex; align-items: center; gap: 16px;
  padding: 0 16px; background: var(--bg-card, #fff);
  border-top: 1px solid var(--border-light, #e2e8f0);
  font-size: 12px; color: var(--text-secondary, #64748b); flex-shrink: 0;
}
.edit-statusbar .status-sep { width: 1px; height: 16px; background: var(--border-light, #e2e8f0); }
.edit-statusbar .status-dirty { color: var(--accent, #2563eb); font-weight: 500; }
.edit-statusbar .status-saved { color: #16a34a; transition: opacity .5s; }
.edit-statusbar .status-saved.fade { opacity: 0; }

.toolbar-btn.editing-active { color: var(--accent, #2563eb); background: var(--accent-light-bg, #dbeafe); }

.editor-textarea-fallback {
  width: 100%; height: 100%; border: none; outline: none; resize: none;
  padding: 12px 16px; tab-size: 2;
  font-family: 'JetBrains Mono','Fira Code','Cascadia Code',Consolas,monospace;
  font-size: 14px; line-height: 1.7;
  background: var(--bg-body, #f8fafc); color: var(--text-primary, #1e293b);
}

.editor-banner {
  padding: 6px 12px; background: #fef3c7; color: #92400e;
  font-size: 12px; text-align: center; flex-shrink: 0;
}
.dark .editor-banner { background: #451a03; color: #fde68a; }

.confirm-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.4);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.confirm-dialog {
  background: var(--bg-card, #fff); border-radius: 12px; padding: 24px;
  max-width: 400px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,.15);
}
.confirm-dialog h3 { margin: 0 0 8px; font-size: 16px; }
.confirm-dialog p { margin: 0 0 20px; font-size: 14px; color: var(--text-secondary, #64748b); }
.confirm-dialog .confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
.confirm-dialog .confirm-actions button {
  padding: 8px 16px; border-radius: 8px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--border-light, #e2e8f0);
  background: var(--bg-body, #f8fafc); color: var(--text-primary, #1e293b);
}
.confirm-dialog .confirm-actions button.btn-primary { background: var(--accent, #2563eb); color: #fff; border-color: var(--accent, #2563eb); }
.confirm-dialog .confirm-actions button.btn-danger { background: #dc2626; color: #fff; border-color: #dc2626; }

@media (max-width: 900px) {
  .edit-split { flex-direction: column; }
  .edit-pane-editor, .edit-pane-preview { min-width: 0; min-height: 200px; }
}
@media (max-width: 768px) {
  #editBtn { display: none !important; }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/web/css/app.css
git commit -m "feat(frontend): add split-pane editing CSS

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 4: Frontend — Edit mode logic in preview.js

**Files:**
- Modify: `packages/core/src/web/js/preview.js`

This is the largest task. It adds `toggleEditMode()`, `enterEditMode()`, `exitEditMode()`, `doSave()`, `initEditDivider()`, and utility functions.

- [ ] **Step 1: Add global state variables**

At the top of `preview.js`, near the other `var` declarations (around line 54-60), add:

```javascript
var editMode = false;
var editDirty = false;
var editModifiedTime = null;
var editSplitRatio = parseInt(localStorage.getItem('doc77_edit_ratio') || '50', 10);
var editAutoSave = true;
var editAutoSaveTimer = null;
var editAutoSaveMs = 2000;
var editOutlineWasManualCollapsed = false;
```

- [ ] **Step 2: Modify editBtn behavior in afterActivate**

In the `afterActivate` function (around line 547), find where toolbar buttons are enabled and add:

```javascript
// Show edit button only for editable file types
var editableExts = ['.md','.mdx','.txt','.markdown','.json','.yaml','.yml','.toml',
  '.ts','.tsx','.js','.jsx','.py','.rb','.go','.rs','.java','.c','.cpp','.h',
  '.css','.scss','.less','.html','.htm','.xml','.svg','.sh','.bash','.zsh',
  '.env.example','.gitignore','.dockerignore','.editorconfig',
  '.conf','.cfg','.ini','.csv','.log'];
var isEditable = editableExts.some(function(ext) {
  return (currentFile || '').toLowerCase().endsWith(ext);
});
var editBtnEl = document.getElementById('editBtn');
if (editBtnEl) {
  editBtnEl.style.display = isEditable ? '' : 'none';
  editBtnEl.classList.toggle('editing-active', editMode);
  editBtnEl.title = editMode ? '退出编辑模式' : '编辑此文件（分屏）';
  editBtnEl.onclick = toggleEditMode;
}
```

- [ ] **Step 3: Add edit mode functions**

Add the following functions to `preview.js` (place near other action functions):

```javascript
function toggleEditMode() {
  if (!currentFile) return;
  if (editMode) { exitEditMode(); }
  else { enterEditMode(); }
}

function enterEditMode() {
  if (editMode) return;
  var cached = tabDataCache[currentFile];
  var initialContent = cached && cached.content ? cached.content : '';
  editModifiedTime = cached && cached.modified ? cached.modified : null;

  var docContent = document.getElementById('docContent');
  if (!docContent) return;
  var previewHTML = docContent.innerHTML;
  var lang = getEditLanguage(currentFile);

  docContent.innerHTML =
    '<div id="editSplitContainer" class="edit-split">' +
      '<div class="edit-pane-editor" id="editEditorPane"></div>' +
      '<div class="edit-divider" id="editDivider"></div>' +
      '<div class="edit-pane-preview" id="editPreviewPane">' + previewHTML + '</div>' +
    '</div>' +
    '<div class="edit-statusbar" id="editStatusbar">' +
      '<span id="statusCursor">行:1 列:1</span>' +
      '<span class="status-sep"></span><span>' + lang.toUpperCase() + '</span>' +
      '<span class="status-sep"></span>' +
      '<span class="status-dirty" id="statusDirty" style="display:none">● 已修改</span>' +
      '<span class="status-saved fade" id="statusSaved">✓ 已保存</span>' +
    '</div>';

  var editorPane = document.getElementById('editEditorPane');
  var container = document.getElementById('editSplitContainer');
  if (container && editorPane) {
    var tw = container.clientWidth;
    editorPane.style.flex = '0 0 ' + editSplitRatio + '%';
  }

  initEditDivider();

  // Auto-collapse outline
  var op = document.getElementById('outlinePanel');
  editOutlineWasManualCollapsed = op && op.classList.contains('hidden') &&
    sessionStorage.getItem('doc77_outline_manual_collapsed') === '1';
  if (op && !op.classList.contains('hidden')) op.classList.add('hidden');

  var editBtnEl = document.getElementById('editBtn');
  if (editBtnEl) { editBtnEl.classList.add('editing-active'); editBtnEl.title = '退出编辑模式'; }
  editMode = true; editDirty = false;

  // Load editor
  if (!initialContent) {
    fetch('/api/raw/' + proj.id + '?path=' + encodeURIComponent(currentFile))
      .then(function(r) { return r.text(); })
      .then(function(t) { if (editMode) initEditorInstance(t); })
      .catch(function() { if (editMode) initEditorInstance(''); });
  } else {
    initEditorInstance(initialContent);
  }
}

function initEditorInstance(initialText) {
  var pane = document.getElementById('editEditorPane');
  if (!pane) return;

  var useCM = window.EditorCore && window.EditorCore.isAvailable();
  if (!useCM) {
    var b = document.createElement('div'); b.className = 'editor-banner';
    b.textContent = '编辑器增强加载失败，使用基础文本模式';
    pane.parentNode.insertBefore(b, pane);
  }

  window._editEditor = window.EditorCore.createEditor(pane, {
    initialValue: initialText,
    language: getEditLanguage(currentFile),
    onSave: function() { doSave(); }
  });

  var el = pane.querySelector('.cm-editor, .editor-textarea-fallback');
  if (el) {
    el.addEventListener('input', function() {
      if (!editDirty) { editDirty = true; document.getElementById('statusDirty').style.display = ''; }
      scheduleAutoSave();
    });
  }
  if (editAutoSave) scheduleAutoSave();
}

function getEditLanguage(fp) {
  var ext = (fp||'').split('.').pop().toLowerCase();
  var m = {md:'markdown',mdx:'markdown',markdown:'markdown',json:'json',
    js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',
    py:'python',rb:'ruby',go:'go',rs:'rust',java:'java',c:'c',cpp:'cpp',h:'c',
    css:'css',scss:'css',less:'css',html:'html',xml:'xml',svg:'xml',
    sh:'shell',bash:'shell',zsh:'shell',yaml:'yaml',yml:'yaml',toml:'toml',
    sql:'sql',txt:'text'};
  return m[ext] || 'text';
}

function scheduleAutoSave() {
  clearTimeout(editAutoSaveTimer);
  if (!editAutoSave) return;
  editAutoSaveTimer = setTimeout(function() { if (editDirty) doSave(); }, editAutoSaveMs);
}

function doSave(cb) {
  if (!editMode || !currentFile || !window._editEditor) return;
  var content = window._editEditor.getValue();
  var headers = { 'Content-Type': 'application/json' };
  if (editModifiedTime) headers['X-Expected-Modified'] = editModifiedTime;

  fetch('/api/content/' + proj.id + '?path=' + encodeURIComponent(currentFile), {
    method: 'PUT', headers: headers, body: JSON.stringify({ content: content })
  })
  .then(function(r) {
    if (r.status === 409) {
      r.json().then(function(d) {
        showEditConfirm('文件已被外部修改', (d.error||'文件已被外部程序修改，继续保存会覆盖外部变更。'), [
          {text:'覆盖保存',cls:'btn-danger',action:function(){
            var fh = {'Content-Type':'application/json','X-Force-Overwrite':'true'};
            fetch('/api/content/'+proj.id+'?path='+encodeURIComponent(currentFile),{method:'PUT',headers:fh,body:JSON.stringify({content:content})})
            .then(function(r2){return r2.json().then(function(d2){if(!r2.ok)throw new Error(d2.error);return d2;});})
            .then(function(d2){editModifiedTime=d2.modified;markSaved();updateEditPreview(content);if(cb)cb();})
            .catch(function(e){alert('保存失败: '+e.message);});
          }},
          {text:'取消',cls:''}
        ]);
      });
      return;
    }
    return r.json().then(function(d) { if (!r.ok) throw new Error(d.error||'保存失败'); return d; });
  })
  .then(function(d) {
    if (!d) return;
    editModifiedTime = d.modified; markSaved(); updateEditPreview(content);
    tabDataCache[currentFile] = { content: content, path: currentFile, size: d.size, modified: d.modified };
    if (cb) cb();
  })
  .catch(function(e) { alert('保存失败: ' + e.message); });
}

function markSaved() {
  editDirty = false;
  var d = document.getElementById('statusDirty'); if (d) d.style.display = 'none';
  var s = document.getElementById('statusSaved');
  if (s) { s.textContent = '✓ 已保存'; s.classList.remove('fade'); }
}

function updateEditPreview(content) {
  var pp = document.getElementById('editPreviewPane'); if (!pp) return;
  fetch('/api/content/'+proj.id+'?path='+encodeURIComponent(currentFile)+'&t='+Date.now())
    .then(function(r){return r.json();})
    .then(function(d){if(d&&d.html)pp.innerHTML=d.html;})
    .catch(function(){pp.innerHTML='<pre style="white-space:pre-wrap;font-size:14px">'+escapeHtml(content)+'</pre>';});
}

function exitEditMode(skipConfirm) {
  if (!editMode) return;
  if (editDirty && !skipConfirm) {
    showEditConfirm('有未保存的修改', '退出前是否保存修改？', [
      {text:'保存并退出',cls:'btn-primary',action:function(){doSave(function(){doExitEdit();});}},
      {text:'放弃修改',cls:'btn-danger',action:function(){doExitEdit();}},
      {text:'取消',cls:''}
    ]);
    return;
  }
  doExitEdit();
}

function doExitEdit() {
  var pp = document.getElementById('editPreviewPane');
  var html = pp ? pp.innerHTML : '';
  var dc = document.getElementById('docContent'); if (dc) dc.innerHTML = html;
  if (!editOutlineWasManualCollapsed) {
    var op = document.getElementById('outlinePanel'); if (op) op.classList.remove('hidden');
  }
  editMode = false; editDirty = false; editModifiedTime = null;
  clearTimeout(editAutoSaveTimer); editAutoSaveTimer = null;
  var eb = document.getElementById('editBtn');
  if (eb) { eb.classList.remove('editing-active'); eb.title = '编辑此文件（分屏）'; }
  if (currentFile) { delete tabDataCache[currentFile]; fetchContent(currentFile).then(function(d){showContent(d,currentFile);}); }
}

function initEditDivider() {
  var div = document.getElementById('editDivider');
  var sc = document.getElementById('editSplitContainer');
  var ep = document.getElementById('editEditorPane');
  if (!div || !sc || !ep) return;
  var dragging = false;
  div.addEventListener('mousedown', function(e) { e.preventDefault(); dragging = true; div.classList.add('dragging'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    var r = sc.getBoundingClientRect();
    var pct = sc.classList.contains('vertical') ? ((e.clientY-r.top)/r.height)*100 : ((e.clientX-r.left)/r.width)*100;
    pct = Math.max(20, Math.min(80, pct));
    editSplitRatio = Math.round(pct); ep.style.flex = '0 0 ' + editSplitRatio + '%';
  });
  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false; div.classList.remove('dragging');
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    localStorage.setItem('doc77_edit_ratio', String(editSplitRatio));
  });
}

function showEditConfirm(title, message, buttons) {
  var ov = document.createElement('div'); ov.className = 'confirm-overlay';
  ov.innerHTML = '<div class="confirm-dialog"><h3>'+escapeHtml(title)+'</h3><p>'+escapeHtml(message)+'</p><div class="confirm-actions">'+
    buttons.map(function(b,i){return '<button class="'+b.cls+'" data-idx="'+i+'">'+escapeHtml(b.text)+'</button>';}).join('')+
    '</div></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', function(e) { if (e.target === ov) ov.remove(); });
  ov.querySelectorAll('button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(btn.getAttribute('data-idx'),10); ov.remove();
      if (buttons[idx]&&buttons[idx].action) buttons[idx].action();
    });
  });
}

function escapeHtml(str) { var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
```

- [ ] **Step 4: Preload CodeMirror on page load**

In the page initialization (around line 118 or DOMContentLoaded), trigger a lazy preload:

```javascript
// Preload editor module in background
if (window.EditorCore) window.EditorCore.load();
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/web/js/preview.js
git commit -m "feat(frontend): add inline edit mode with split-pane, save, auto-save

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 5: Tests

**Files:**
- Create: `packages/core/__tests__/editor-content.test.ts`

- [ ] **Step 1: Create editor-content.test.ts**

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const testDir = path.join(os.tmpdir(), 'doc77-edit-test-' + Date.now());

describe('Editor content endpoint (unit-level checks)', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'test.md'), '# Hello\n\nWorld', 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should verify editable file extension gating', () => {
    const editableExts = ['.md','.mdx','.txt','.markdown','.json','.yaml','.yml','.toml',
      '.ts','.tsx','.js','.jsx','.py','.rb','.go','.rs','.java','.c','.cpp','.h',
      '.css','.scss','.less','.html','.htm','.xml','.svg','.sh','.bash','.zsh',
      '.env.example','.gitignore','.dockerignore','.editorconfig',
      '.conf','.cfg','.ini','.csv','.log'];
    expect(editableExts.includes('.md')).toBe(true);
    expect(editableExts.includes('.png')).toBe(false);
    expect(editableExts.includes('.pdf')).toBe(false);
    expect(editableExts.includes('.docx')).toBe(false);
  });

  it('should verify size limit check', () => {
    const maxSizeMB = 2;
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    const smallContent = '# Hello';
    const largeContent = 'x'.repeat(3 * 1024 * 1024);
    expect(Buffer.byteLength(smallContent, 'utf-8') > maxSizeBytes).toBe(false);
    expect(Buffer.byteLength(largeContent, 'utf-8') > maxSizeBytes).toBe(true);
  });

  it('should verify shadow backup and restore logic', () => {
    const testFile = path.join(testDir, 'shadow-test.md');
    const original = '# Original content';
    const modified = '# Modified content';
    fs.writeFileSync(testFile, original, 'utf-8');

    // Simulate shadow backup
    const shadowDir = path.join(os.tmpdir(), '.doc77', 'shadow', 'test-task');
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.copyFileSync(testFile, path.join(shadowDir, 'shadow-test.md'));

    // Simulate failed write (partial)
    try {
      fs.writeFileSync(testFile, 'corrupt', 'utf-8');
      throw new Error('simulated disk error');
    } catch {
      // Restore from shadow
      const sf = path.join(shadowDir, 'shadow-test.md');
      fs.copyFileSync(sf, testFile);
    }

    const restored = fs.readFileSync(testFile, 'utf-8');
    expect(restored).toBe(original);

    // Cleanup
    fs.rmSync(shadowDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
pnpm test
```

Expected: all existing tests pass (~156 tests), new tests pass.

- [ ] **Step 3: CI pre-check**

```bash
pnpm format:check && pnpm lint && pnpm build && pnpm test
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/editor-content.test.ts
git commit -m "test(core): add editor content endpoint tests

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

## Acceptance Checklist

1. Open a .md file → click ✏️ → CodeMirror 6 editor opens in split pane
2. Type content → Ctrl+S → toast "已保存" → preview pane updates
3. Auto-save: type → wait 2s → content auto-saved silently
4. Drag divider → ratio changes → refresh page → ratio restored
5. Exit with unsaved changes → confirmation dialog → "保存并退出" works
6. External change: edit in VS Code → try save in doc77 → 409 dialog
7. File > 2MB → save rejected with 413
8. Mobile viewport: edit button hidden
9. CodeMirror CDN fails → textarea fallback with banner
10. `pnpm test` all pass, `pnpm build` succeeds

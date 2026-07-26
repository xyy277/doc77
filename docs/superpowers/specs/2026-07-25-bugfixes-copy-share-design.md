# Bug 修复 + 复制/分享功能增强 — 设计文档

> 日期: 2026-07-25 | 版本: v1.0.9

## 一、背景

v1.0.8 测试发现 6 个 bug + 2 个功能需求：

### Bug 清单

| # | Bug | 根因 | 涉及文件 |
|---|-----|------|---------|
| 1 | 文档预览自动滚动不工作 | `contentArea` 可能为 null，自停条件过于激进 | `preview.js` |
| 2 | 预览页设置抽屉看不到面板 | 可能的 z-index/CSS specificity 问题 | `preview.html` / `app.css` |
| 3 | Gallery Albums 不能删除 | 后端 API 已实现，UI 缺删除按钮 | `gallery-album.js` |
| 4 | Album 中图片无法移出 | 后端 API 已实现，UI 缺操作入口 | `gallery.html` / `gallery-album.js` |
| 5 | Electron 原生菜单 | 未设置 Menu，显示默认菜单 | `electron/main.ts` |
| 6 | Dashboard 点 Star 跳 GitHub 后无返回机制 | Electron 外链在系统浏览器打开 | `electron/main.ts` |

### 功能需求

| # | 功能 | 状态 | 说明 |
|---|------|------|------|
| F1 | 预览页 MD 文档一键复制 | **新建** | 悬浮 FAB 按钮（方案 A），复制原始 Markdown 内容 |
| F2 | 分享页复制功能 | **增强** | 在现有分享页 `/s/:token` 增加复制按钮 |

> **注意：** 分享系统（创建链接、QR 码、分享页面渲染）在 v1.0.8 已完整实现。
> 本次仅需：F1 预览页 Copy FAB + F2 分享页 Copy 按钮 + `/api/share/:token/data` 返回 rawContent。

---

## 二、详细设计

### Bug 1 — 文档预览自动滚动修复

**文件:** `packages/core/src/web/js/preview.js:1247-1264`

**改动:**

```javascript
function toggleAutoScroll() {
  if (autoScrollActive) {
    cancelAnimationFrame(autoScrollRAF);
    autoScrollRAF = null;
    autoScrollActive = false;
    document.getElementById('autoScrollBtn').textContent = '▶';
    document.getElementById('scrollSpeed').classList.add('hidden');
    return;
  }
  autoScrollActive = true;
  document.getElementById('autoScrollBtn').textContent = '⏸';
  document.getElementById('scrollSpeed').classList.remove('hidden');
  autoScrollSpeed = parseFloat(document.getElementById('scrollSpeed').value) || 60;
  var lastTime = performance.now();
  var a = document.getElementById('contentArea');
  if (!a) { autoScrollActive = false; return; }  // ← guard clause
  function step(time) {
    if (!autoScrollActive) return;
    var a = document.getElementById('contentArea'); // ← re-get in case DOM changed
    if (!a) { autoScrollActive = false; return; }
    var delta = Math.min((time - lastTime) / 1000, 0.1); // ← cap delta
    a.scrollTop += autoScrollSpeed * delta;
    lastTime = time;
    if (a.scrollTop >= a.scrollHeight - a.clientHeight) { toggleAutoScroll(); return; } // ← remove -2
    autoScrollRAF = requestAnimationFrame(step);
  }
  autoScrollRAF = requestAnimationFrame(step);
}
```

**改动量:** ~8 行修改

---

### Bug 2 — 设置抽屉修复

**文件:** `packages/core/src/web/css/app.css`（or `preview.html:227`）

**根因假设:** 设置面板 `.settings-panel` 可能被 `contentArea`（`position:relative`）的 stacking context 遮挡。或不正确的 z-index。

**改动（首选方案）：**

在 `app.css:1741` 的 `.settings-panel` 中添加 `z-index: 51`：

```css
.settings-panel {
  position: relative;
  z-index: 51;  /* ← 高于 contentArea 的 z-index */
  width: 100%;
  /* ... 其余不变 */
}
```

**改动量:** 1 行

---

### Bug 3 — Album 删除 UI

**文件:** `packages/gallery/src/web/js/gallery-album.js`

**改动:** 在 `renderAlbumSidebar` 的每个 album `<a>` 标签后添加删除按钮：

```javascript
'<button onclick="event.stopPropagation();event.preventDefault();' +
'if(confirm(\'Delete album \\\'' + escHtml(a.name).replace(/'/g, "\\'") + '\\\'?\\nThis cannot be undone.\')){' +
'GalleryAlbum.deleteAlbum(' + a.id + ').then(function(){location.reload()})' +
'}" ' +
'class="ml-auto text-doc77-500 hover:text-red-500 transition-colors p-0.5 shrink-0 opacity-0 group-hover:opacity-100" ' +
'title="Delete album">' +
'<i class="ph ph-trash text-xs"></i></button>'
```

> 使用 `confirm()` 而不是 toast 确认弹窗，因为 gallery 页面没有复杂 dialog 组件，保持简洁。

同时在 `gallery.html` 中暴露 `confirmDeleteAlbum` 函数以支持更优雅的确认（可选增强）。

**改动量:** ~8 行

---

### Bug 4 — 移出 Album UI

**文件:** `packages/gallery/src/web/gallery.html`

**改动:** 在 selection toolbar（`#selection-toolbar`）中，当 `currentView === 'album'` 时添加 "Remove from album" 按钮：

```javascript
// selection-toolbar innerHTML 添加:
'<button class="p-2 hover:bg-blue-700 rounded-md transition-colors" title="Remove from album" ' +
'onclick="removeSelectedFromAlbum()" id="btn-remove-album" style="display:none">' +
'<i class="ph ph-minus-circle text-xl"></i></button>'
```

**在 `toggleSelectMode` 中联动可见性：**
```javascript
// 进入 select mode 时:
var removeBtn = document.getElementById('btn-remove-album');
if (removeBtn) removeBtn.style.display = state.currentView === 'album' ? '' : 'none';
```

**新增 `removeSelectedFromAlbum` 函数：**
```javascript
async function removeSelectedFromAlbum() {
  var paths = Array.from(state.selectedIds);
  if (paths.length === 0) { window.toast('No items selected', 'warning'); return; }
  // Get albumId from current URL or state
  var albumId = state.currentAlbumId;
  if (!albumId) { window.toast('Not in album view', 'error'); return; }
  try {
    for (var i = 0; i < paths.length; i++) {
      await fetch('/api/albums/' + albumId + '/items', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: state.projectId, file_path: paths[i] }),
      });
    }
    state.selectedIds.clear();
    updateSelectionUI();
    loadAlbumGallery(albumId, state.currentAlbumName);
    loadAlbums(); // refresh album item counts
    window.toast('Removed ' + paths.length + ' items from album', 'success');
  } catch (e) {
    window.toast('Failed to remove: ' + (e.message || 'unknown error'), 'error');
  }
}
```

**同步改动：** `loadAlbumGallery` 需要保存 `state.currentAlbumId` 和 `state.currentAlbumName`。

**改动量:** ~30 行

---

### Bug 5 — Electron 菜单定制（方案 B）

**文件:** `packages/electron/src/main.ts`

**改动:** 在 `app.whenReady()` 之前添加菜单构建逻辑：

```typescript
import { app, BrowserWindow, Menu /* ← add Menu */, ... } from 'electron';

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS: keep system app menu (About, Quit, etc.)
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    // macOS: keep standard Edit menu
    ...(isMac ? [{ role: 'editMenu' as const }] : []),
    // Minimal Help menu (cross-platform)
    {
      role: 'help',
      submenu: [
        {
          label: 'About Doc77',
          click: () => {
            if (mainWindow) {
              mainWindow.loadURL(`http://localhost:${server?.port ?? 28888}`);
            }
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 在 app.whenReady() 回调中调用:
app.whenReady().then(() => {
  buildAppMenu();
  boot().catch(reportBootFailure);
});
```

**改动量:** ~20 行

---

### Bug 6 — Electron GitHub 外链处理

**文件:** `packages/electron/src/main.ts`

**改动:** 在 `createWindow` 中添拦截外部链接，在系统浏览器打开：

```typescript
// 在 createWindow 中，BrowserWindow 配置后:
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  // 外链用系统浏览器打开
  const parsed = new URL(url);
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  }
  return { action: 'allow' };
});
```

**可选：** 在 preload 中暴露 `isElectron` 标记，让 web 页面的外链在点击时自动由 shell 打开。

**改动量:** ~10 行

---

### F1 — 预览页 Copy FAB

**文件:** `packages/core/src/web/js/preview.js` + `preview.html`

**设计：** 在 `contentArea` 内添加 sticky FAB 按钮，与 `backToTopBtn` 纵向排列：

```
┌──────────────────────────────┐
│  Content Area                │
│                         ┌──┐ │  ← Copy FAB (sticky bottom:80px)
│                         │📋│ │
│                         └──┘ │
│                         ┌──┐ │  ← Back to top (sticky bottom:24px)
│                         │↑ │ │
│                         └──┘ │
└──────────────────────────────┘
```

**实现：**

1. 在 `preview.html` 的 `contentArea` 中添加 Copy FAB HTML（与 `backToTopBtn` 同级）：

```html
<button id="copyContentBtn" onclick="copyDocumentContent()"
  data-i18n-title="web.preview.copyContent" title="Copy content"
  style="position:sticky;bottom:80px;float:right;margin-right:12px;z-index:20;
    width:36px;height:36px;border-radius:50%;background:var(--accent,#2563eb);
    color:#fff;border:none;cursor:pointer;display:none;align-items:center;
    justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);
    transition:opacity 0.2s,transform 0.2s"
  onmouseover="this.style.transform='scale(1.1)'"
  onmouseout="this.style.transform='scale(1)'">
  📋
</button>
```

2. 在 `preview.js` 中添加 `copyDocumentContent` 函数：

```javascript
function copyDocumentContent() {
  // Get raw content from the server
  if (!currentFile) { toast(t('web.preview.openDocFirst'), 'error'); return; }
  var btn = document.getElementById('copyContentBtn');
  var origHTML = btn.innerHTML;
  fetch('/api/content/' + pid + '?path=' + encodeURIComponent(currentFile))
    .then(function(r) { if (!r.ok) throw new Error(); return r.text(); })
    .then(function(raw) {
      if (navigator.clipboard) {
        return navigator.clipboard.writeText(raw);
      } else {
        fallbackCopy(raw);  // reuse existing fallback
        return Promise.resolve();
      }
    })
    .then(function() {
      btn.innerHTML = '✓';
      setTimeout(function() { btn.innerHTML = origHTML; }, 1500);
    })
    .catch(function() {
      // Fallback: copy from DOM
      var docContent = document.getElementById('docContent') || document.querySelector('.doc-content');
      if (docContent) {
        var text = docContent.textContent || '';
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).catch(function() { fallbackCopy(text); });
        } else {
          fallbackCopy(text);
        }
        btn.innerHTML = '✓';
        setTimeout(function() { btn.innerHTML = origHTML; }, 1500);
      }
    });
}
```

3. 按钮显示/隐藏逻辑：
   - 在 `afterActivate` 中：MD 文件时 `display: flex`，否则 `display: none`
   - 在 `beforeActivate` / 关闭文件时：`display: none`

**改动量:** ~40 行

---

### F2 — 分享页 Copy 按钮

**文件:** `packages/core/src/export/helpers.ts`（`renderSharePage`）+ `packages/core/src/server/app.ts`（share data API）

**步骤 1：** 修改 `/api/share/:token/data` 返回 `rawContent` 字段（仅 markdown/code/text 类型）：

```typescript
// app.ts line 1865 — 在 markdown 分支:
rendered = {
  type: 'markdown',
  content: renderMarkdown(content, { ... }),
  rawContent: content,  // ← 新增
};
```

同样在 code、text 分支添加 `rawContent`。

**步骤 2：** 在分享页头部添加 Copy 按钮：

```html
<!-- 在 doc77-share-header 中添加 -->
<button id="copyBtn" onclick="copySharedContent()"
  style="padding:6px 12px;font-size:12px;font-weight:500;
    background:var(--accent);color:#fff;border:none;border-radius:6px;
    cursor:pointer">
  📋 <span id="copyBtnText">Copy</span>
</button>
```

**步骤 3：** 在分享页 `<script>` 中添加 `copySharedContent`：

```javascript
var _rawContent = '';
function copySharedContent() {
  var text = _rawContent;
  if (!text) {
    // Fallback: get text from rendered DOM
    text = document.getElementById('content').textContent || '';
  }
  var btn = document.getElementById('copyBtnText');
  var orig = btn.textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() {
      btn.textContent = '✓ Copied!';
      setTimeout(function() { btn.textContent = orig; }, 1500);
    }).catch(function() {
      // fallback
    });
  }
}

// 在 fetch 回调中保存 rawContent:
// .then(function(d) { _rawContent = d.rawContent || ''; ... })
```

**改动量:** ~25 行（app.ts + helpers.ts）

---

## 三、改动文件汇总

| # | 文件 | 改动类型 | 行数 |
|---|------|---------|------|
| B1 | `packages/core/src/web/js/preview.js` | 修改 | ~8 |
| B2 | `packages/core/src/web/css/app.css` | 修改 | ~1 |
| B3 | `packages/gallery/src/web/js/gallery-album.js` | 修改 | ~8 |
| B4 | `packages/gallery/src/web/gallery.html` | 修改+新增 | ~30 |
| B5 | `packages/electron/src/main.ts` | 新增 | ~20 |
| B6 | `packages/electron/src/main.ts` | 新增 | ~10 |
| F1 | `packages/core/src/web/js/preview.js` + `preview.html` | 新增 | ~40 |
| F2 | `packages/core/src/server/app.ts` + `export/helpers.ts` | 修改+新增 | ~25 |

**总计：** 8 个文件，~142 行改动

---

## 四、测试要点

1. **B1:** 打开长 MD 文档 → 点击 ▶ 自动滚动 → 确认匀速滚动 → 打开短文档 → 确认不抛异常
2. **B2:** 预览页 → 点击 ⚙ 设置 → 确认抽屉面板从右侧滑入可见
3. **B3:** Gallery → Albums → hover album → 删除按钮出现 → 点击 → 确认后 album 消失
4. **B4:** Gallery → 进入 album → Select mode → 选中图片 → Remove from album → 确认图片移除
5. **B5:** Electron 启动 → 确认 File/Edit/View/Window/Help 菜单已移除，仅保留 macOS 系统菜单
6. **B6:** Dashboard → 点 "Star on GitHub" → 系统浏览器打开 GitHub（不离开 Doc77 窗口）
7. **F1:** 预览页 → 打开 MD 文档 → Copy FAB 可见 → 点击 → "✓" 反馈 → 粘贴确认是原格式
8. **F2:** 分享链接 → 打开分享页 → 点击 "📋 Copy" → "✓ Copied!" 反馈 → 粘贴确认是原格式

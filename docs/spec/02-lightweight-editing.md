# 轻量编辑落地 — 设计文档

> 日期: 2026-07-27 | 优先级: Q3-2 | 状态: 设计（基于已有设计 `docs/superpowers/specs/2026-07-14-lightweight-editing-design.md`）

## 一、背景与目标

已有完整设计文档（2026-07-14），本 spec 补充实施细节与增强点。

**核心定位**：编辑是预览的自然延伸，覆盖"随手改几行"场景，重度编辑仍交给外部编辑器。

**目标**：
- Markdown / 纯文本 / 代码文件在预览页内直接编辑
- CodeMirror 6 分屏（源码 + 实时预览）
- Ctrl+S 保存 + 可选自动保存
- Shadow 备份保护 + 外部变更冲突检测
- 移动端不显示编辑入口（保持只读）

## 二、实施分阶段

### Phase 1：Markdown 编辑（MVP）

| 项 | 内容 |
|----|------|
| 支持格式 | `.md`, `.mdx`, `.txt` |
| 编辑器 | CodeMirror 6（ESM CDN + 离线降级 textarea） |
| 布局 | 左右分屏 50/50，可拖拽（最小 200px/侧） |
| 保存 | Ctrl+S 手动 + 自动保存（去抖 2s，可关闭） |
| 安全 | Shadow 备份 → 写入 → 成功清除/失败回滚 |
| 冲突 | mtime 对比 → 409 → 用户选择覆盖/取消 |

### Phase 2：代码文件编辑

| 项 | 内容 |
|----|------|
| 新增格式 | `.ts`, `.js`, `.py`, `.json`, `.yaml`, `.toml`, `.sh`, `.css`, `.html` 等 |
| 语法高亮 | CodeMirror 6 `@codemirror/lang-*` 按需加载 |
| 预览区 | 代码文件不显示实时预览，改为全屏编辑器 + 行号 |
| 大小限制 | 2MB 上限不变 |

### Phase 3：增强体验

- 编辑历史（Undo 多步 + 本地快照）
- 查找替换（CodeMirror 内置 search extension）
- 多文件 tab 编辑（同时打开多个编辑器 tab）
- 格式化（Prettier 集成，可选）

## 三、API 设计

### 3.1 `PUT /api/content/:id`

```
PUT /api/content/:id?path=docs/readme.md
Content-Type: application/json
Headers:
  X-Expected-Modified: 2026-07-14T10:00:00Z   (可选，冲突检测)
  X-Force-Overwrite: true                      (可选，强制覆盖)
Body: { "content": "# Updated\n\nNew content." }

Response 200: { "ok": true, "size": 42, "modified": "2026-07-27T10:30:00Z" }
Response 403: { "error": "此文件类型不可编辑", "code": "EDIT_TYPE_DENIED" }
Response 409: { "error": "文件已被外部修改", "code": "CONFLICT", "serverModified": "..." }
Response 413: { "error": "文件超过 2MB 上限", "code": "TOO_LARGE" }
Response 423: { "error": "文件被锁定", "code": "LOCKED" }
```

### 3.2 执行流程

```
1. validatePath(root, filePath)
2. isSensitiveFile(path) → 403
3. isEditableExtension(path) → 403 (非文本类)
4. stat.size > 2MB → 413
5. acquireFileLock(projectId, filePath) → 423 if locked
6. X-Expected-Modified vs actual mtime → 409 (unless X-Force-Overwrite)
7. shadow.create(projectId, filePath)  // 备份原文件
8. fs.writeFileSync(absPath, content, 'utf-8')
9. audit.log('edit', { projectId, filePath, size })
10. shadow.clear(projectId, filePath)  // 成功，清除备份
11. releaseFileLock()
12. emit SSE event: { type: 'file-changed', path }
```

### 3.3 可编辑扩展名白名单

```typescript
const EDITABLE_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.text',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.css', '.scss', '.less', '.html', '.xml', '.svg',
  '.sql', '.graphql', '.proto',
  '.gitignore', '.editorconfig', '.prettierrc',
]);
```

## 四、前端实现要点

### 4.1 CodeMirror 6 加载策略

```javascript
async function loadEditor() {
  try {
    // 1. 尝试 vendor 本地（Electron / 已缓存）
    const { EditorView, basicSetup } = await import('/vendor/codemirror/index.js');
    return { EditorView, basicSetup, source: 'vendor' };
  } catch {
    try {
      // 2. CDN fallback
      const { EditorView, basicSetup } = await import('https://esm.sh/codemirror@6');
      return { EditorView, basicSetup, source: 'cdn' };
    } catch {
      // 3. textarea 降级
      return null;
    }
  }
}
```

### 4.2 分屏布局

```
┌──────────────────────┬─────────────────────────────┐
│  CodeMirror 6        │  预览区（marked 实时渲染）    │
│  - 行号              │  - 300ms debounce 刷新       │
│  - 语法高亮          │  - 同步滚动（可选）          │
│  - 光标位置          │                             │
├──────────────────────┴─────────────────────────────┤
│ 行:42 列:15 │ Markdown │ ● 已修改 │ ✓ 已保存      │
└──────────────────────────────────────────────────────┘
```

### 4.3 快捷键

| 快捷键 | 操作 |
|--------|------|
| Ctrl+S / Cmd+S | 保存 |
| Ctrl+Shift+P | 切换预览显示/隐藏 |
| Ctrl+Z / Ctrl+Y | 撤销/重做（CodeMirror 内置） |
| Ctrl+F | 查找（CodeMirror search） |
| Escape | 退出编辑模式 |

## 五、配置项

| 配置 key | 默认值 | 说明 |
|---------|--------|------|
| `editor.enabled` | `true` | 是否启用内置编辑 |
| `editor.autoSave` | `true` | 自动保存开关 |
| `editor.autoSaveDelay` | `2000` | 自动保存延迟 ms |
| `editor.maxFileSize` | `2097152` | 可编辑文件大小上限 (bytes) |
| `editor.syncScroll` | `true` | 分屏同步滚动 |
| `editor.tabSize` | `2` | 缩进宽度 |

## 六、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/core/src/server/app.ts` | 修改 | 新增 PUT /api/content/:id |
| `packages/core/src/server/editable.ts` | 新增 | 可编辑扩展名白名单 + 校验逻辑 |
| `packages/core/src/web/js/editor.js` | 新增 | 编辑模式主逻辑（CM6 加载/分屏/保存） |
| `packages/core/src/web/js/preview.js` | 修改 | 集成编辑入口 + 模式切换 |
| `packages/core/src/web/css/app.css` | 修改 | 分屏/状态栏/分隔线样式 |
| `packages/core/src/web/preview.html` | 修改 | 编辑按钮 + 分屏容器 |
| `packages/core/__tests__/editor-content.test.ts` | 新增 | PUT API 测试 |

## 七、验收标准

1. 打开 .md → 点 ✏️ → CodeMirror 分屏出现 → 编辑 → Ctrl+S → 预览刷新
2. 自动保存：编辑后 2s 无操作 → 状态栏显示 "✓ 已保存"
3. 外部冲突：编辑中外部修改文件 → 保存 → 409 弹窗 → 可选覆盖
4. Shadow 回滚：模拟写入失败 → 原文件不变
5. 降级：断网 + 无 vendor → textarea 可编辑可保存
6. 移动端：不显示 ✏️ 按钮
7. 大文件：> 2MB → 提示不可编辑
8. 现有 237+ 测试全部通过

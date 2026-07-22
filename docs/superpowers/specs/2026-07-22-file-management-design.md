# 文件管理功能设计文档

**日期**：2026-07-22
**状态**：设计完成，待实施

---

## 背景与目标

当前 doc77 的左侧树结构仅支持浏览和打开文件。用户需要通过 Web UI 完成基本的文件管理操作（新建、重命名、删除、收藏），而无需切换到终端或文件管理器。

**目标**：赋予 doc77 在系统层面管理文件的基本能力，同时保持高性能和低复杂度。

---

## 右键菜单设计

| 右键目标 | 菜单项 |
|---|---|
| 目录 | 新建文件 / 新建文件夹 / 重命名 / 删除 |
| 文件 | 收藏(切换) / 重命名 / 删除 |

所有操作通过现有的 `promptDialog()`（输入名称）或 `confirmDialog()`（删除确认）收集用户意图，结果通过 `toast()` 反馈。

**明确不包含**（YAGNI）：
- 拖拽移动（复杂度高，MCP `move_file` 可覆盖需求）
- 复制/粘贴（低频操作，MCP `copy_file` 可覆盖）
- 批量操作（保留给 MCP 层）

---

## 架构概览

```
用户右键 → Context Menu → promptDialog/confirmDialog
    ↓
fetch() → REST API（直接 FS 操作 + validatePath）
    ↓
fs.mkdir / fs.writeFile / fs.rename / fs.unlink
    ↓
成功 → EventBus.emit('file-tree:changed') → SSE → 前端 refreshTree()
失败 → 错误响应 → toast()
```

**核心原则**：Web UI 用户手动操作 = 已审批。不走 MCP 审批队列，直接执行 FS 操作。

---

## API 设计

全部在 `packages/core/src/server/app.ts` 中新增。统一以 project `:id` + query `?path=` 标识操作目标。

### 端点清单

| 方法 | 端点 | Body | 返回 | 说明 |
|---|---|---|---|---|
| `POST` | `/api/tree/:id/file?path=dir/` | `{ name: string }` | `{ path, type, size }` | 创建空文件 |
| `POST` | `/api/tree/:id/folder?path=dir/` | `{ name: string }` | `{ path, type }` | 创建目录 |
| `PUT` | `/api/tree/:id/rename?path=target` | `{ newName: string }` | `{ oldPath, newPath }` | 重命名文件/目录 |
| `DELETE` | `/api/tree/:id?path=target` | — | `{ path, movedToTrash }` | 删除（自动检测文件/目录类型） |
| `PUT` | `/api/tree/:id/bookmark?path=file` | `{ action: "add" \| "remove" }` | `{ path, bookmarked }` | 收藏/取消收藏 |
| `GET` | `/api/tree/:id/bookmarks` | — | `{ bookmarks: Array<{path,created_at}> }` | 获取书签列表 |
| `POST` | `/api/tree/:id/bookmarks/migrate` | `{ bookmarks: Array<{path,time}> }` | `{ imported: number }` | localStorage → SQLite 迁移（幂等） |

### 安全措施（每个端点强制）

1. **路径验证**：`validatePath(projectRoot, requestedPath)` — 防路径穿越
2. **敏感文件拦截**：`isSensitiveFile(name)` — 阻止操作 `.env`、`*.key`、`.git` 等
3. **名称合法性**：禁止空值、含 `/` 或 `\`、`..`、长度 > 255 字节
4. **冲突检测**：新建/重命名时目标已存在 → `409 Conflict`
5. **非空目录保护**：删除目录前检查是否为空，非空 → `400 "Directory not empty"`

### 删除安全兜底（不依赖 `@doc77/mcp`）

为保持 `@doc77/core` 不依赖 `@doc77/mcp`，删除操作不复用 MCP 的 shadow backup。改为简化策略：

```
fs.rename(target, <projectRoot>/.doc77-trash/<timestamp>-<name>)
```

- 垃圾目录在服务启动时 GC（清理 >30 天的条目）
- 若 trash 目录不可写（跨设备等），回退到直接 `fs.unlinkSync` / `fs.rmdirSync`

---

## SSE 自动刷新

### 现有基础设施

- `@doc77/mcp` 提供 `EventBus`（`EventEmitter`），已通过 CLI 注入到 Express 层
- `packages/core/src/server/events.ts` 的 `createEventsHandler(bus)` 已转发 `task:executed`、`task:failed` 到浏览器
- 前端已接入 SSE 连接
- 前端已有 `refreshTree()` 函数（`preview.js:288`）

### 改动

| 层 | 改动 |
|---|---|
| `events.ts` | `FORWARDED_EVENTS` 新增 `'file-tree:changed'` |
| `app.ts` | `createApp()` 新增可选第 4 参数 `eventBus?: MinimalBus`；CRUD 端点成功时 `eventBus?.emit('file-tree:changed', payload)` |
| `bin/doc77.ts` | 将 `getEventBus()` 传给 `createApp()` |
| `preview.js` | SSE `file-tree:changed` 事件处理 → 若变更路径在当前展开树内 → `refreshTree()` |

### Payload

```typescript
interface FileTreeChangedPayload {
  projectId: number;
  path: string;       // 变更发生的目录路径
  opType: 'create_file' | 'create_folder' | 'rename' | 'delete';
}
```

**性能优化**：仅当变更的 `projectId` 与当前打开的 project 匹配时刷新；若变更路径不在当前展开的树分支内，可跳过（可选优化）。

---

## 书签升级：localStorage → SQLite

### 新表

```sql
CREATE TABLE IF NOT EXISTS file_bookmarks (
    project_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, file_path),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

此表加入 `packages/core/src/db/migrations.ts` 的 `SCHEMA_SQL`。

### 迁移策略

1. 前端 `renderBookmarks()` 检测 `localStorage.getItem('doc77-bookmarks')` 中有数据
2. 若存在 → 调用 `POST /api/tree/:id/bookmarks/migrate` 批量导入
3. 服务端 `INSERT OR IGNORE` 保证幂等
4. 迁移成功后前端 `localStorage.removeItem('doc77-bookmarks')`

### 前端改动

- `addBookmark(filePath)`：`localStorage` 读写 → `PUT /api/tree/:id/bookmark`
- `removeBookmark(filePath)`：同上
- `getBookmarks()`：`localStorage` → `GET /api/tree/:id/bookmarks`
- `renderBookmarks()`：触发迁移 + 刷新渲染

---

## 前端改动清单

| 文件 | 改动 |
|---|---|
| `preview.html` | 无需结构改动（`ctxMenu` 元素已存在） |
| `preview.js` | `showCtxMenu(x, y, entry)` 重写：根据 `entry.type` 渲染不同菜单项 |
| `preview.js` | `makeNode()` 中给目录 `row` 也绑定 `contextmenu` 事件 |
| `preview.js` | SSE `file-tree:changed` 处理器 |
| `preview.js` | `addBookmark/removeBookmark/getBookmarks/renderBookmarks` 改写为 API 调用 |
| `preview.js` | 首次迁移逻辑（`renderBookmarks` 中检测旧 localStorage） |
| `app.css` | 上下文菜单样式微调（支持 separator、danger 操作等） |
| `common.js` | 无需改动（`promptDialog`、`confirmDialog`、`toast` 已满足需求） |

### i18n 新增 Key

```
web.preview.ctxMenu.newFile        → "新建文件"
web.preview.ctxMenu.newFolder      → "新建文件夹"
web.preview.ctxMenu.rename         → "重命名"
web.preview.ctxMenu.delete         → "删除"
web.preview.ctxMenu.bookmarkAdd    → "添加到收藏"
web.preview.ctxMenu.bookmarkRemove → "取消收藏"
web.preview.prompt.newFileName     → "输入文件名称"
web.preview.prompt.newFolderName   → "输入文件夹名称"
web.preview.prompt.renameTitle     → "重命名"
web.preview.toast.fileCreated      → "文件已创建"
web.preview.toast.folderCreated    → "文件夹已创建"
web.preview.toast.renamed          → "已重命名"
web.preview.toast.deleted          → "已删除"
web.preview.toast.renameFailed     → "重命名失败"
web.preview.toast.deleteFailed     → "删除失败"
web.preview.error.dirNotEmpty      → "目录不为空，请先清空内容"
web.preview.error.nameConflict     → "该名称已存在"
web.preview.confirm.deleteFile     → "确定要删除此文件？"
web.preview.confirm.deleteFolder   → "确定要删除此文件夹？"
```

---

## 不变部分（直接复用）

| 模块 | 文件 |
|---|---|
| 路径验证 | `packages/core/src/fs/index.ts` — `validatePath()`, `isSensitiveFile()` |
| 对话框 | `packages/core/src/web/js/common.js` — `promptDialog()`, `confirmDialog()`, `toast()` |
| 树刷新 | `packages/core/src/web/js/preview.js:288` — `refreshTree()` |
| 右键菜单元素 | `preview.html:265` — `#ctxMenu` |
| 右键菜单样式 | `app.css:1860` — `.ctx-menu` |
| SSE 架构 | `packages/core/src/server/events.ts` — `createEventsHandler()` |
| 数据库连接 | `packages/core/src/db/connection.ts` — `getConnection()` |
| Migration 框架 | `packages/core/src/db/migrations.ts` — `runMigrations()` |
| 目录扫描缓存 | `packages/core/src/scanner/index.ts` — `clearCache()` 用于操作后失效 |

---

## 错误处理矩阵

| 场景 | HTTP 状态 | 前端反馈 |
|---|---|---|
| 路径穿越 | 403 | toast 错误信息 |
| 敏感文件 | 403 | toast 错误信息 |
| 名称含非法字符 | 400 | toast "无效的文件名" |
| 目标已存在 | 409 | toast "该名称已存在" |
| 目录不为空（删除） | 400 | toast "目录不为空" |
| 项目不存在 | 404 | toast 错误信息 |
| FS 操作失败 | 500 | toast 错误信息 |
| 网络错误 | — | toast "网络异常，请重试" |

---

## 验证方案

### 手动测试

1. **新建文件**：右键目录 → 新建文件 → 输入 `test.md` → 树自动刷新，新文件出现
2. **新建文件夹**：右键目录 → 新建文件夹 → 输入 `new-folder` → 树自动刷新
3. **重命名**：右键文件 → 重命名 → 输入新名称 → 树自动刷新
4. **删除**：右键文件 → 删除 → 确认 → 树自动刷新
5. **收藏切换**：右键文件 → 收藏 → 书签面板出现该项；再次右键 → 取消收藏
6. **书签迁移**：在 localStorage 有旧书签的情况下打开 preview → 自动迁移 → 旧数据清除
7. **SSE 推送**：在浏览器 A 操作 → 浏览器 B 的树自动刷新
8. **安全验证**：尝试操作 `.env` / `../etc/passwd` → 403 被拒
9. **冲突验证**：新建已存在的名称 → 409 提示

### 自动化测试

```bash
pnpm test  # 现有 138 tests 必须全部通过
```

新增单元测试覆盖：
- 名称校验逻辑（非法字符、边界长度）
- bookmark CRUD 的 API 级别测试

---

## 参考

- 架构文档：`docs/design/system-architecture.md`
- 实施跟踪：`docs/planning/implementation-status.md`
- MCP 写工具参考：`packages/mcp/src/tools/write.ts`
- 事务执行器参考：`packages/mcp/src/transaction/executor.ts`

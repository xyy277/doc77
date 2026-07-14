# 轻量文档编辑功能 — 设计文档

> 日期：2026-07-14 | 状态：设计完成，待用户审阅

## 1. Context

Doc77 当前定位为纯只读预览器，设计哲学明确写有"预览 ≠ 编辑"。README 推荐用户需要编辑时唤起 VS Code 或系统编辑器（`/api/reveal` 端点）。这一决策被证明是合理的——预览体验已打磨得相当完善（21 项 Markdown 语法支持，237 测试全部通过）。

但随着用户日常使用，频繁在"浏览器预览 ↔ 外部编辑器修改"之间切换越来越低效。典型场景：阅读一篇 Markdown 笔记时发现错别字或需要补充几行内容，此时唤起 VS Code 太重了——修改 3s，编辑器启动 5s。用户需要一种**在预览器中直接完成轻量修改**的能力。

本设计遵循一个核心约束：**编辑是预览的自然延伸，而非替代。** 外部编辑器仍然是重度编辑的首选，doc77 内置编辑只覆盖"随手改几行"的场景。

## 2. 设计决策

### 2.1 编辑范围：Markdown + 纯文本

| 范围 | 决策 | 理由 |
|---|---|---|
| Markdown（.md, .mdx） | ✅ 第一期 | 最频繁的编辑需求 |
| 代码/配置文件（.ts, .py, .json, .yaml, .toml 等） | ✅ 第二期 | CodeMirror 6 原生支持语法高亮 |
| Office 文档（.docx, .xlsx） | ❌ 不支持 | 二进制格式，"轻量编辑"不现实 |
| 图片 / PDF / 视频 | ❌ 不支持 | 超出文本编辑器语义 |

### 2.2 编辑器选型：CodeMirror 6

| 方案 | 体积 | 复杂度 | 体验 | 选择 |
|---|---|---|---|---|
| CodeMirror 6 | ~200KB (gzip ~60KB) | 中 | 语法高亮、行号、extension 体系 | ✅ |
| 纯 textarea | 0 | 极低 | 无语法高亮、无行号 | ❌ |
| contenteditable WYSIWYG | 视实现 | 高 | 所见即所得 | ❌ 格式易出问题 |

CodeMirror 6 通过 vendor 体系离线缓存，不增加首屏加载开销。打开编辑模式时才按需加载。

### 2.3 分屏模式：源码 + 实时预览

```
┌──────────────────────┬─────────────────────────────┐
│                      │                             │
│   CodeMirror 6       ││  预览区（现有 marked 渲染）  │
│   - 行号             │                             │
│   - 语法高亮          │   - 即时刷新                │
│   - Ctrl+S 保存      │                             │
│                      │                             │
├──────────────────────┴─────────────────────────────┤
│ 行:42 列:15 | ● 已修改 | Markdown                   │
└──────────────────────────────────────────────────────┘
```

- 默认 50/50 分屏，分隔线 6px 可拖拽调整比例（最小 200px / 侧）
- 拖拽比例记忆到 localStorage
- 响应式 < 900px：上下分屏
- 移动端：**不显示编辑入口**，保持只读

## 3. API 设计

### 3.1 `PUT /api/content/:id`（新增）

```
PUT /api/content/:id?path=docs/readme.md
Content-Type: application/json
Body: { "content": "# New Heading\n\nUpdated content." }

Response 200: { "ok": true, "size": 42, "modified": "2026-07-14T10:30:00Z" }
Response 403: { "error": "此文件类型不可编辑" }
Response 409: { "error": "文件已被外部修改，刷新后重试" }
Response 413: { "error": "文件超过 2MB 上限" }
Response 500: { "error": "保存失败：<reason>" }
```

**执行流程：**

1. 查询 project → root path
2. `validatePath(root, filePath)` — 复用现有路径安全校验
3. `isSensitiveFile(path)` — 复用现有敏感文件过滤
4. 大小检查（> 2MB → 拒绝）
5. Shadow 备份原文件（复用 `packages/mcp/src/transaction/shadow.ts`）
6. 外部变更检测：对比 `mtime` vs 打开时的 `timestamp`，不同 → 409（前端弹窗确认后可通过 header `X-Force-Overwrite: true` 覆盖）
7. `fs.writeFileSync(absPath, content, 'utf-8')`
8. 写入 audit log（复用 `packages/mcp/src/transaction/audit.ts`）
9. 成功 → 清除 shadow；失败 → 从 shadow 回滚原文件
10. 返回新 size + modified 时间戳

**并发控制：** 使用现有 MCP 项目级文件锁（`acquireProjectLock` / `releaseProjectLock`），同一文件同时仅一个编辑者能保存。

## 4. 前端设计

### 4.1 工具栏按钮重新设计

```
现有工具栏按钮重排：

[🔍 搜索] [📖 大纲] [🔊 TTS] [✏️] [🔗] [▶️ 运行] ...

  ✏️ 铅笔 icon → 内联分屏编辑（保留现有 icon）
     - 点击进入编辑模式，icon 变为高亮激活态（蓝色）
     - 再次点击退出编辑模式（有脏数据时弹确认）

  🔗 外链 icon → 系统编辑器打开（现有 /api/reveal 功能）
     - 替代旧的编辑按钮行为
     - 视觉语义：跳出当前页去外部工具
```

### 4.2 编辑模式交互

**进入编辑：**
1. 点击 ✏️ → 懒加载 CodeMirror 6（vendor → CDN → textarea 降级）
2. 获取原始文件内容（优先从缓存 `tabDataCache`，miss 时 GET `/api/content/:id`）
3. 替换当前内容区为分屏布局
4. 右侧大纲面板自动折叠（animateOut），为编辑区腾出空间
5. 记录文件原始 `modified` 时间戳（用于外部变更检测）

**退出编辑：**
1. 检查 dirty flag
   - `true` → 弹窗："有未保存的修改" [保存并退出] [放弃修改] [取消]
   - `false` → 直接退出
2. 清理 CodeMirror 实例
3. 恢复大纲面板（仅当退出前用户没有手动折叠大纲）
4. 刷新预览内容

### 4.3 右侧大纲自动折叠规则

```
进入编辑模式
  → 右侧面板自动 collapse（animateOut）
  → 如果用户原本就是手动折叠的 → 记录状态为 "manual_collapsed"，退出时保持折叠
  → 如果是编辑模式触发的折叠 → 记录为 "editor_collapsed"，退出时自动展开

退出编辑模式
  → manual_collapsed → 不展开
  → editor_collapsed → animateIn 恢复
```

### 4.4 保存策略

| 方式 | 触发条件 | 行为 |
|---|---|---|
| **Ctrl+S / Cmd+S** | 用户按键 | 立即保存，toast 反馈，阻止浏览器默认行为 |
| **自动保存** | 去抖 2s（可配置关闭） | 静默保存，状态栏短暂亮"✓ 已保存" |
| **退出前保存** | 离开编辑模式前 | 检查 dirty flag，弹确认框 |

配置项：`editor.autoSave`（默认 `true`），通过现有 Settings 面板管理。

### 4.5 状态栏

编辑模式底部固定状态栏（40px），左对齐显示 4 个区域：

```
行:42 列:15  │  Markdown  │  ● 已修改  │  ✓ 已保存 (2s 前)
                                                └─ 保存成功后显示 3s 后渐隐
```

### 4.6 外部变更冲突

```
PUT 请求前
  → 附带 header X-Expected-Modified: <timestamp>

服务端
  → 对比实际 mtime vs X-Expected-Modified
  → 一致 → 正常保存，200
  → 不一致 → 返回 409 Conflict

前端收到 409
  → 弹窗："文件已被外部修改（可能是 VS Code 等工具），继续保存会覆盖外部变更"
  → [覆盖保存] → 重新 PUT 加 X-Force-Overwrite: true
  → [取消] → 回到编辑模式，用户可手动对比
```

### 4.7 错误降级

| 场景 | 处理 |
|---|---|
| CodeMirror 6 加载失败 | 降级 textarea + 顶栏 banner 提示"编辑器加载失败，使用基础模式" |
| Vendor 离线 + CDN 不通 | 同上，降级 textarea |
| 保存失败（磁盘满 / 权限） | toast 错误详情，编辑器内容不清空，shadow 保留原文件 |
| 超过 2MB 文件 | 进入编辑模式时提示"文件过大，建议用外部编辑器"，仍可打开但性能警告 |

## 5. Vendor 注册

CodeMirror 6 官方不提供预构建 CDN bundle，需要自行打包或使用 ESM import map 从 CDN 按需加载。

**方案：ESM import 从 CDN 加载（esm.sh）**

```javascript
// 前端按需加载，不经过 vendor-install
import { EditorView, basicSetup } from 'https://esm.sh/codemirror@6';
import { markdown } from 'https://esm.sh/@codemirror/lang-markdown@6';
```

**离线降级策略：**

1. 首次加载：esm.sh CDN（带浏览器 HTTP 缓存）
2. 浏览器 Service Worker / HTTP Cache 命中 → 离线可用
3. CDN 不可用 → 降级为浏览器原生 `<textarea>` 基础编辑

**Electron 内置方案：** CodeMirror 6 的 ESM 模块在打包时通过构建脚本下载到 `vendor/` 目录，前端通过本地路径加载。

> **注意：** 具体的 CDN 地址和离线打包方案在实施阶段确定，取决于 esm.sh / skypack / jsdelivr 的可用性和项目构建工具链兼容性。`checksum` 也将在 vendor-install 下载时自动计算。

## 6. 测试策略

### 单元测试

| 文件 | 新增 | 覆盖点 |
|---|---|---|
| `packages/core/__tests__/editor-content.test.ts`（新增） | ~10 tests | PUT endpoint、大小限制、文件锁、shadow 回滚、敏感文件拒绝 |
| `packages/core/__tests__/renderers.test.ts` | +2 | 编辑模式下的 renderer 兼容 |

### E2E（Playwright）

| 场景 | 步骤 |
|---|---|
| 编辑→保存→预览一致 | 打开 .md → 切编辑 → 改内容 → Ctrl+S → 切预览 → 验证内容更新 |
| 脏状态提示 | 编辑改内容 → 点退出 → 弹窗出现 → 选"放弃" → 退出，内容不变 |
| 拖拽分屏 | 进入编辑 → mousedown 分隔线 → mousemove → mouseup → 比例变化 |
| 比例记忆 | 拖到 60/40 → 退出编辑 → 重新进入 → 恢复 60/40 |
| 大纲自动折叠 | 大纲展开 → 切编辑 → 大纲收起 → 退编辑 → 大纲展开 |
| 手动折叠保持 | 手动折叠大纲 → 切编辑 → 退编辑 → 大纲保持折叠 |
| 外部变更冲突 | 编辑中 → 外部程序修改同文件 → Ctrl+S → 409 弹窗 |
| CodeMirror 降级 | 拦截 vendor 请求 → 切编辑 → textarea 模式可正常编辑保存 |

### 集成测试

| 场景 | 验证 |
|---|---|
| Shadow 回滚 | 模拟磁盘写失败 → 原文件内容完整恢复 |
| 并发写保护 | 两个请求同时 PUT 同一文件 → 第二个等待锁释放 |
| 大文件拒绝 | PUT 3MB 文件 → 413 → 原文件未改动 |

## 7. 文件变更清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `packages/core/src/server/app.ts` | 修改 | 新增 `PUT /api/content/:id` 端点 |
| `packages/core/src/server/vendor.ts` | 修改 | 新增 CodeMirror 6 vendor 定义 |
| `packages/core/src/web/js/preview.js` | 修改 | 编辑模式切换、CodeMirror 懒加载、保存逻辑、分屏拖拽 |
| `packages/core/src/web/js/common.js` | 修改 | 新增 `editor.autoSave` 配置项 + 确认弹窗组件 |
| `packages/core/src/web/css/app.css` | 修改 | 分屏布局、编辑工具栏、状态栏、分隔线拖拽、textarea 降级样式 |
| `packages/core/__tests__/editor-content.test.ts` | 新增 | PUT endpoint 测试 |
| `packages/core/__tests__/renderers.test.ts` | 修改 | 编辑兼容测试 |
| `.github/workflows/ci.yml` | 修改 | vendor-install 步骤确保 CodeMirror bundle 就绪（已有） |
| `README.md` | 修改 | 更新"当前定位"段落，移除"暂不支持编辑" |

### 不变更

- `packages/mcp/` — 复用其 shadow、audit、lock 模块，不修改
- `packages/electron/` — vendor extraResources 配置已有，无需改动
- `packages/ai/` — 不涉及
- `packages/cli/` — 不涉及

## 8. 验收标准

1. **基本编辑**：打开 .md 文件 → 点击编辑 → 修改内容 → Ctrl+S → 预览更新
2. **自动保存**：编辑 → 等 2s → 内容自动落盘（可配置关闭）
3. **拖拽分屏**：分隔线可拖拽调整，比例记忆跨 session
4. **大纲折叠**：编辑自动折叠，退出自动恢复（手动折叠不被覆盖）
5. **外部变更检测**：编辑中外部修改文件 → 保存时弹窗警告
6. **Shadow 保护**：保存失败 → 原文件完整无损
7. **离线降级**：vendor 缺失时降级 textarea，基本编辑可用
8. **移动端只读**：手机/平板不显示编辑入口
9. **所有现有测试继续通过**（237 tests）
10. **大文件**：超过 2MB 拒绝保存，超过 1MB 进入编辑时给性能提示

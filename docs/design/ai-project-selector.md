# AI 工作区项目选择器 — 设计文档

> 状态：待实施（设计 v1）
> 面向：中文开发团队
> 关联：`docs/design/system-architecture.md`、`docs/planning/implementation-status.md`

## 1. 背景与目标

### 问题

AI 工作区（`/ai`）目前**无法选择项目上下文**：

- 前端 `tab.projectId` 只可能在 `createTab` 时被外部传入，AI 页面内没有任何选择入口
- 会话请求携带 `project_id: tab.projectId || undefined` —— 未选择时为空
- 服务端无 `project_id` 时：文件工具全部不可用（已实现引导：AI 提示用户选择项目，仅保留 `list_projects`）

结果是：用户必须离开 AI 页面、通过其他页面打开项目，才能让 AI 分析文件 —— 流程断裂。

### 目标

1. 在 AI 工作区提供**项目选择器**（下拉/切换），会话与项目绑定
2. 绑定关系**持久化**（重启后恢复）：前端 localStorage + 服务端 SessionStore
3. 切换项目时**正确重置上下文**（agent 重建，历史保留）
4. 无项目时保持现有引导行为（AI 提示用户选择）

## 2. 现状分析

### 2.1 前端

| 模块 | 现状 |
|---|---|
| `web/js/ai-chat-tabs.js` | `tab.projectId` 字段已存在（createTab 时可选传入），localStorage 持久化已含 projectId |
| `web/js/ai-workspace.js` | `send()` 请求体 `project_id: tab.projectId \|\| undefined`（ai-workspace.js:74） |
| `web/js/ai-session-sidebar.js` | 会话列表（`/api/ai/sessions`）—— 不显示项目归属 |
| `web/ai.html` | 无项目选择 UI |

### 2.2 服务端

| 模块 | 现状 |
|---|---|
| `db/session-store.ts` | `AiSession.projectId: number \| null` 已存在；`createSession` 支持 projectId；**`updateSession` 不支持 projectId**（Pick 仅 title/status/pinned/model/currentLeafId） |
| `server/routes/ai-sessions.ts` | `PATCH /api/ai/sessions/:id` **不接受 project_id**（仅 title/status/pinned/model） |
| `server/app.ts` `createAgentLoopHandler` | 每次请求**新建 AgentLoop**，历史从 SessionStore 恢复；`project_id` 来自请求体；`systemPrompt` 按请求注入项目上下文（`if (project_id && !context_file)`）—— **天然支持项目切换，无需改动 agent 缓存** |
| 无 project_id 引导 | 已实现（工具过滤为仅 `list_projects` + `ai.context.noProjectHint` system prompt 引导） |

### 2.3 关键结论

- **新 handler（createAgentLoopHandler）的项目切换语义已正确**：项目上下文每次请求注入，切换项目后 AI 自动使用新项目信息，历史消息按 session 保留
- 需要补的是：**前端选择 UI + 服务端 projectId 持久化通道（updateSession / PATCH）**

## 3. 设计方案

### 3.1 UI：项目选择器

**位置**：`ai.html` 的 tab strip 行（`#aiTabsStrip` 右侧）或输入区上方，放一个紧凑下拉：

```
┌──────────────────────────────────────────────────────────┐
│ [tab1] [tab2] [+]    📁 项目: [ 选择项目 ▾ ]              │
├──────────────────────────────────────────────────────────┤
│ （消息区）                                                 │
```

- **组件**：原生 `<select>` 或自定义 dropdown（复用现有样式体系，参考 sidebar 的 `.sess-action-btn` 风格）
- **选项**：
  - `无项目`（默认，`projectId = null`）
  - 项目列表（来自 `GET /api/projects`，展示 name）
- **每 tab 独立**：切换 tab 时选择器显示该 tab 的 projectId（tab 级状态，不全局共享）
- **切换行为**：
  - 设置 `tab.projectId` → persist（localStorage）
  - 同步服务端：`PATCH /api/ai/sessions/:id`（`{ project_id: <id> }`），**会话已创建（有 sessionId）时调用**
  - 显示提示 toast（"已切换到项目 X" / "已清除项目上下文"）
  - 选择器在会话无 sessionId 时禁用（会话创建后才绑定）

### 3.2 数据流

```
用户选择项目
  → aiWorkspace.setProject(pid)
    → tab.projectId = pid; aiChatTabs.persist()
    → (tab.sessionId 存在时) PATCH /api/ai/sessions/:id { project_id }
    → 下次 send(): project_id: tab.projectId ✓
  → 服务端：AgentLoop 用新 project_id 注入项目上下文 → 工具可用
```

**会话恢复**（前端打开已存在会话）：

```
loadSessionMessages(tab) 成功后
  → 响应含 session.projectId（/messages/path 端点需返回）
  → 若 tab.projectId 为空且 session.projectId 非空 → 回填 tab.projectId → persist
```

### 3.3 服务端 API 变更

1. **`session-store.ts` `updateSession`**：`Pick<AiSession, ...>` 增加 `'projectId'`；set 分支：`project_id = ?`
2. **`routes/ai-sessions.ts` `PATCH`**：接受 `project_id`（校验：null 或正整数；null 表示清除绑定）
3. **`routes/ai-messages.ts` `GET /messages/path`**：响应已含 `currentLeafId`/`messageCount`，**补充 `session.projectId`**（供前端恢复 tab.projectId）—— 或前端改用 `GET /api/ai/sessions/:id`（已返回完整 session）—— **优先：/messages/path 响应加 `projectId` 字段**（避免前端多一次请求）

### 3.4 会话切换语义（无需额外改动）

- `createAgentLoopHandler` 每次请求新建 AgentLoop、systemPrompt 按当前请求 `project_id` 注入 → **切换项目后下次消息自动使用新项目**
- 历史消息（`ai_messages` 树）按 session 存储，**不受 projectId 变化影响**
- 注意：**会话列表按 projectId 过滤**（`GET /api/ai/sessions?project_id=`）——切换项目后会话仍归原项目（**设计决策：会话一旦创建不迁移项目，仅影响后续 AI 上下文**；如需迁移可后续扩展）

### 3.5 持久化

| 层 | 存储 | 说明 |
|---|---|---|
| 前端 | localStorage（`doc77_ai_tabs_v1`） | 已含 projectId，切换即存 |
| 服务端 | `ai_sessions.project_id` | PATCH 写入；`/messages/path` 返回供恢复 |

## 4. 实施步骤

### Task 1：服务端 projectId 通道

- [ ] `packages/core/src/db/session-store.ts`：`updateSession` 支持 `projectId`（type Pick + set 分支）
- [ ] `packages/core/src/server/routes/ai-sessions.ts`：`PATCH` 接受 `project_id`（校验：`null` 或正整数）
- [ ] `packages/core/src/server/routes/ai-messages.ts`：`GET /messages/path` 响应加 `projectId: session.projectId`
- [ ] 测试：`packages/core/__tests__/ai-session-routes.test.ts` 增加 PATCH project_id 用例（设置/清除/非法值）

### Task 2：前端选择器 UI

- [ ] `packages/core/src/web/ai.html`：项目选择器容器（tab strip 行右侧），`id="aiProjectSelect"`
- [ ] `packages/core/src/web/js/ai-workspace.js`：
  - `loadProjects()`：`GET /api/projects` 填充选项（含"无项目"）
  - `setProject(pid)`：更新 tab.projectId → persist → PATCH 会话 → toast
  - `onTabActivated`：同步选择器显示当前 tab 的项目
- [ ] `packages/core/src/web/js/ai-chat-tabs.js`：`loadSessionMessages` 成功后回填 `tab.projectId`（响应含 projectId 时）
- [ ] `packages/core/src/web/css/app.css`：选择器样式（紧凑、与 tab strip 对齐）
- [ ] i18n 词条（zh/en）：`web.ai.project.select`（选择项目）、`web.ai.project.none`（无项目）、`web.ai.project.switched`（已切换）、`web.ai.project.cleared`（已清除）、`web.ai.project.bindAfterSession`（会话创建后可绑定）

### Task 3：验证

- [ ] `pnpm build` + `pnpm test` 全绿（新增测试含）
- [ ] 手动验证矩阵（见 §5）

## 5. 验证方案

| # | 场景 | 预期 |
|---|---|---|
| 1 | 无项目时提问"分析项目" | AI 提示选择项目（现有引导），不调文件工具 |
| 2 | 选择项目 A 后提问 | AI 能 list_files/read_file（工具可用） |
| 3 | 切换项目 A → B 后提问 | AI 使用 B 的项目上下文（system prompt 注入 B 的信息） |
| 4 | 刷新页面 | tab 的 projectId 从 localStorage 恢复，选择器正确显示 |
| 5 | 服务端重启后打开会话 | `/messages/path` 返回 projectId → tab.projectId 回填 |
| 6 | 清除项目（选"无项目"） | 后续提问回到引导行为 |
| 7 | 会话未创建（无 sessionId）时切换项目 | 选择器可用（记到 tab），PATCH 不调用（无 session）；首次消息创建会话后带 project_id |
| 8 | 非法 project_id PATCH | 400（校验失败） |

## 6. 风险与注意事项

1. **切换项目不迁移会话归属**：会话创建时的 project_id 用于列表过滤；切换只影响后续 AI 上下文。如需"迁移归属"后续单独设计
2. **多 tab 不同项目**：选择器是 tab 级状态，切 tab 时选择器需同步（注意事件绑定正确解绑，避免残留监听）
3. **`GET /api/projects` 鉴权**：AI 页面已有登录门禁，项目接口复用现有 auth 中间件即可
4. **i18n 双语**：所有新词条必须 zh/en 同步（`pnpm check:i18n` 校验）
5. **不与 graph/其他分支冲突**：当前分支 `feature/knowledge-graph` 有未提交改动（graph.html 等），开发前先确认工作区状态

## 7. 开发 Prompt（供其他 agent 使用）

> 将以下内容整体复制给开发 agent（Claude Code 或其他编码 agent）。

---

```
# 任务：为 Doc77 AI 工作区实现"项目选择器"功能

你是 Doc77（Node.js + TypeScript monorepo，4 个 package：core/mcp/ai/cli）的开发者。
按本 prompt 实施，完成后运行全部验证。

## 功能需求

AI 工作区页面（/ai）需要一个项目选择器：
1. 用户可为当前对话 tab 选择/清除项目（project_id 绑定）
2. 绑定持久化：前端 localStorage + 服务端 ai_sessions.project_id
3. 切换项目后 AI 自动使用新项目的上下文（服务端已支持，无需改 agent）
4. 无项目时保持现有行为（AI 引导用户选择项目，不调文件工具）

## 现状（已确认，不要重新调研）

- 前端 tab.projectId 字段已存在（web/js/ai-chat-tabs.js），localStorage 已持久化
- 发送请求已带 project_id: tab.projectId（web/js/ai-workspace.js:74）
- 服务端 createAgentLoopHandler 每次请求新建 AgentLoop，systemPrompt 按请求 project_id 注入项目上下文 —— 切换项目天然生效，无需改
- 无 project_id 时工具过滤为仅 list_projects + system prompt 引导（已实现，勿改动）
- 需要补：前端选择 UI + 服务端 projectId 持久化通道

## 实施步骤

### Task 1：服务端 projectId 通道
1. packages/core/src/db/session-store.ts：updateSession 的 fields Pick 增加 'projectId'，set 分支加 project_id = ?
2. packages/core/src/server/routes/ai-sessions.ts：PATCH /api/ai/sessions/:id 接受 project_id（null 或正整数；null 清除；非法返回 400）
3. packages/core/src/server/routes/ai-messages.ts：GET /api/ai/sessions/:id/messages/path 响应增加 projectId: session.projectId
4. 测试：packages/core/__tests__/ai-session-routes.test.ts 增加 PATCH project_id 用例（设置/清除/非法值 400）

### Task 2：前端选择器
1. packages/core/src/web/ai.html：tab strip 行加选择器容器 <select id="aiProjectSelect">（含"无项目"选项）
2. packages/core/src/web/js/ai-workspace.js：
   - loadProjects(): GET /api/projects 填充选项
   - setProject(pid): tab.projectId 更新 → aiChatTabs.persist() → (有 sessionId 时) PATCH /api/ai/sessions/:id {project_id} → toast 提示
   - tab 激活时同步选择器显示（aiChatTabs.activate 挂钩或事件）
3. packages/core/src/web/js/ai-chat-tabs.js：loadSessionMessages 成功后若 tab.projectId 为空且响应含 projectId → 回填并 persist
4. packages/core/src/web/css/app.css：选择器样式（紧凑）
5. i18n 词条（zh/en 同步）：web.ai.project.select / web.ai.project.none / web.ai.project.switched / web.ai.project.cleared
   （词条结构参考现有 web.ai.* 词条，位于 packages/core/src/i18n/locales/zh-CN.json 与 en-US.json）

## 验证（必须全部通过）

1. pnpm build（全量）
2. pnpm test（全量，含新增测试）
3. pnpm check:i18n（zh/en key 一致）
4. pnpm lint（0 error）
5. 手动验证矩阵（本地 dev:start 后）：
   - 无项目提问 → AI 引导选择（不调文件工具）
   - 选择项目 A 提问 → list_files 可用
   - 切 A → B 再提问 → AI 用 B 上下文
   - 刷新页面 → 选择器恢复 tab 项目
   - 重启 server 打开会话 → projectId 回填
   - 选"无项目" → 回到引导行为

## 规范（必须遵守）

- 文档/注释语言：术语用英文原文（project_id、tab、PATCH 等），说明文字用中文
- 不提交 git（用户另行决定）；不发布 npm
- 提交前运行 CI 预检：pnpm format:check && pnpm lint && pnpm check:i18n && pnpm build && pnpm test
- 未提交代码保护：不丢弃任何未提交改动；改动前 git status 确认
- 保持现有代码风格（文件内注释密度、命名、格式）
```

---

## 附录：涉及文件清单

| 文件 | 改动类型 |
|---|---|
| `packages/core/src/db/session-store.ts` | 修改（updateSession 支持 projectId） |
| `packages/core/src/server/routes/ai-sessions.ts` | 修改（PATCH 接受 project_id） |
| `packages/core/src/server/routes/ai-messages.ts` | 修改（/messages/path 返回 projectId） |
| `packages/core/src/web/ai.html` | 修改（选择器 UI） |
| `packages/core/src/web/js/ai-workspace.js` | 修改（loadProjects/setProject/tab 同步） |
| `packages/core/src/web/js/ai-chat-tabs.js` | 修改（projectId 回填） |
| `packages/core/src/web/css/app.css` | 修改（样式） |
| `packages/core/src/i18n/locales/zh-CN.json` | 修改（词条） |
| `packages/core/src/i18n/locales/en-US.json` | 修改（词条） |
| `packages/core/__tests__/ai-session-routes.test.ts` | 修改（新增测试） |

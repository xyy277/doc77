# Doc77 P0 BLOCKER 修复实施基线

> 日期：2026-07-31 ｜ 基于：`spec-review-2026-07-31.md` 审查报告
> 范围：仅 P0（19 条 🔴 BLOCKER），P1/P2 留作后续迭代
> 目标：让 10 个已实现功能从"写了模块但没通电"达到"可用"状态

---

## 一、总览

审查报告确认 19 条 🔴 BLOCKER，分布于 8 个 Spec（01/04/05/06/07/08/09/10）。本基线将其拆解为 **15 个独立任务**，按 3 阶段组织，标注依赖关系以支持并行执行。

### BLOCKER 分布

| Spec | BLOCKER 数 | 核心问题 |
|------|-----------|---------|
| 01 PWA | 1 | LAN-HTTP 下 Service Worker 无法注册（架构限制） |
| 04/05 同步 | 4 | 路由未挂载 + CLI 无命令 + changedFiles 硬编码空 + adapterConfig 键错位 + 缺失文件 |
| 06 隧道 | 3 | 前端面板缺失 + /config /devices 路由缺失 + TunnelConfig 缺策略字段（+安全项） |
| 07 AI/RAG | 2 | RAG 完全未实现 + 多 Provider 切换后端旁路 |
| 08 Electron | 2 | 无 fileAssociations + notifications.ts 未实现（+tray/快捷键/open-file 队列） |
| 09 冲突+E2EE | 4 | API 路由全缺 + ai-assist/前端缺失 + 适配器不加密 + 恢复码密钥派生 bug |
| 10 插件 | 3 | 渲染分发不调插件 + 无沙箱 + CLI/前端缺失 |

---

## 二、依赖图与并行矩阵

```
Phase 0（无依赖，全部可并行 — 7 个 agent）         Phase 1（依赖 P0，互相并行 — 5 个）     Phase 2（依赖 P1，互相并行 — 3 个）

T1 同步引擎核心 ─────────────┬────────────────────► T8 同步路由+scheduler ─────────────► T13 diff+conflict+ai-assist
                            │                      T9 适配器 E2EE                     T14 同步前端+CLI
T2 keyring 协议重设计 ───────┘                                        ┌──────► T15 插件 CLI+前端
                                                          │           │
T3 隧道安全修复 ────────────────────────────────────────► T12 隧道路由+前端
                                                          │
T4 AI 多 provider ─────────────────────────────────────► T10 RAG 模块 ─────────────────► T13
                                                          │
T5 渲染器派发 ─────────────────────────────────────────► T11 插件沙箱+API ─────────────► T15

T6 Electron 文件关联+通知 ──── （独立）
T7 PWA SW 文档化 ──────────── （独立）
```

| 阶段 | 任务 | 依赖 | 可与本阶段其他任务并行 |
|------|------|------|----------------------|
| 0 | T1 同步引擎核心 | 无 | ✅ 全部 |
| 0 | T2 keyring 协议重设计 | 无 | ✅ 全部 |
| 0 | T3 隧道安全修复 | 无 | ✅ 全部 |
| 0 | T4 AI 多 provider | 无 | ✅ 全部 |
| 0 | T5 渲染器派发 | 无 | ✅ 全部 |
| 0 | T6 Electron 文件关联+通知 | 无 | ✅ 全部 |
| 0 | T7 PWA SW 文档化 | 无 | ✅ 全部 |
| 1 | T8 同步路由+scheduler | T1 | ✅ T9/T10/T11/T12 |
| 1 | T9 适配器 E2EE | T1, T2 | ✅ T8/T10/T11/T12 |
| 1 | T10 RAG 模块 | T4 | ✅ T8/T9/T11/T12 |
| 1 | T11 插件沙箱+API | T5 | ✅ T8/T9/T10/T12 |
| 1 | T12 隧道路由+前端 | T3 | ✅ T8/T9/T10/T11 |
| 2 | T13 diff+conflict+ai-assist | T8, T10 | ✅ T14/T15 |
| 2 | T14 同步前端+CLI | T8 | ✅ T13/T15 |
| 2 | T15 插件 CLI+前端 | T11 | ✅ T13/T14 |

**最大并行度**：Phase 0 = 7 并行；Phase 1 = 5 并行；Phase 2 = 3 并行。

---

## 三、Phase 0 — 基础修复（全部可并行）

### T1 — 同步引擎核心修复

**对应 BLOCKER**：Spec 04/05 — `changedFiles` 硬编码空；`adapterConfig` 键不匹配

**根因**：
- `packages/sync/src/engine.ts:66-67`：`changedFiles: []`, `remoteFiles: []` 硬编码，从不调用 `scanLocal()` / `listRemote()` / `compareRemote()`
- `packages/sync/src/engine.ts:72`：ctx.options 设 `gitConfig`，但 `adapters/webdav.ts:78` / `s3.ts:102` / `local.ts:48` 读 `ctx.options.adapterConfig`（始终 undefined）
- 注：`adapters/git.ts:42` 读 `gitConfig` 且用 `git.status()` 自发现变更，所以 git 路径可工作

**修复方案**：
1. 统一配置键为 `adapterConfig`（3/4 适配器已用此名）。engine.ts 中将 `gitConfig` 同时设为 `adapterConfig`，或直接重命名。git.ts 兼容读取两个字段名
2. 在 `sync()` 方法中，调用适配器的能力扫描本地文件 + 远程列表，diff 后填充 `ctx.changedFiles` 和 `ctx.remoteFiles`
3. 新建 `packages/sync/src/state.ts`：提供 `scanLocal(projectPath, ignorePatterns): FileChange[]` 和 `compareRemote(local, remote): { toPush, toPull, conflicts }`
4. 新建 `packages/sync/src/adapters/adapter.ts`：抽象基类，定义 `scanLocal` 默认实现（遍历目录 + ignorePatterns 过滤）
5. 新建 `packages/sync/src/adapters/index.ts`：barrel 导出 + 适配器注册表

**待修改文件**：
- `packages/sync/src/engine.ts`（sync() 方法，~30-50 行改动）
- `packages/sync/src/adapters/webdav.ts` / `s3.ts` / `local.ts` / `git.ts`（确认读 adapterConfig）

**待创建文件**：
- `packages/sync/src/state.ts`
- `packages/sync/src/adapters/adapter.ts`
- `packages/sync/src/adapters/index.ts`

**验收标准**：
- 单元测试 `packages/sync/__tests__/engine.test.ts`：创建临时目录放入 2 个文件，调用 `sync()` 后 `result.pushed === 2`（当前为 0）
- `testConnection()` 对 webdav/s3/local 配置不再因 `adapterConfig` undefined 崩溃
- git 适配器回归通过（不破坏现有 git.status() 路径）

**风险**：git.ts 用 `git.status()` 自发现变更，不依赖 changedFiles。改动时勿破坏 git 路径。建议 `adapterConfig` 字段对 git 适配器无害（它忽略即可）。

---

### T2 — Keyring 恢复码协议重设计

**对应 BLOCKER**：Spec 09 — recovery code 密钥派生 bug（协议设计错误）

**根因**：
- `packages/sync/src/crypto/keyring.ts:21`：`setup()` 用 `deriveKey(password, salt)` 生成 masterKey
- `packages/sync/src/crypto/keyring.ts:46`：`unlockWithRecovery()` 用 `deriveKey(code, salt)` 生成 masterKey —— **两个不同输入产生不同密钥**，恢复码永远无法解密用密码加密的文件
- `recoveryCodeHash` 是实例字段（keyring.ts:14，内存态），`getKeyring()` 单例（:76-80）不持久化 salt，进程重启后状态丢失

**修复方案**（参考 core `server/auth.ts` 的 DEK 信封模式）：
1. **masterKey 改为随机生成**：`setup()` 中 `masterKey = crypto.randomBytes(32)`
2. **密码包裹 masterKey**：用 `deriveKey(password, salt)` 生成 wrapKey，AES-GCM 加密 masterKey → 存储 `wrappedMasterByPassword`
3. **恢复码包裹同一 masterKey**（关键修复）：用 `deriveKey(recoveryCode, salt)` 生成 rcWrapKey，加密**同一个** masterKey → 存储 `wrappedMasterByRecovery`
4. **持久化**：新建 DB 迁移 v10，`sync_keyring` 表 `{ id, salt, wrapped_master_by_password, wrapped_master_by_recovery, recovery_code_hash, version }`。`getKeyring()` 启动时从 DB 加载
5. **unlock(password)**：读 salt + wrappedMasterByPassword，派生 wrapKey，解出 masterKey
6. **unlockWithRecovery(code)**：读 salt + wrappedMasterByRecovery，验证 recoveryCodeHash，派生 rcWrapKey，解出 masterKey

**待修改文件**：
- `packages/sync/src/crypto/keyring.ts`（重写 setup/unlock/unlockWithRecovery，~80 行）
- `packages/core/src/db/migrations.ts`（新增 v10 迁移，sync_keyring 表）

**验收标准**：
- 测试：`setup('pass')` → `encryptFile(data)` → `lock()` → `unlockWithRecovery(recoveryCode, salt)` → `decryptFile()` 成功（当前必失败）
- 测试：错误恢复码返回 false 且不修改内部状态
- 测试：进程重启（重新 getKeyring()）后从 DB 恢复 salt + wrappedMaster

**风险**：协议级变更会破坏已有加密数据。但当前适配器上传明文（T9 未完成），无已加密数据需迁移。`setup()` 加 `version` 字段以支持未来迁移。

---

### T3 — 隧道安全修复

**对应 BLOCKER**：Spec 06 — 开放模式远程请求完全绕过认证；无进程退出 hook；session TTL 过长

**根因**：
- `packages/core/src/server/app.ts:398`：`if (!auth.isPasswordSet()) return next()` —— 开放模式下所有 API 无认证，隧道暴露后任何人可访问全部 API
- `packages/core/src/tunnel/manager.ts`：无 `process.on('beforeExit'/'SIGTERM')` 调用 `mgr.stop()`，cloudflared/ngrok 子进程变孤儿
- `packages/core/src/server/auth.ts:144`：`AUTH_SESSION_TTL_MS = 12h`（另有 `sessions.ts:12` 的 6h，可能是不同 session store）。隧道场景需 30min

**修复方案**：
1. **开放模式 + 隧道激活时强制认证**：auth 中间件增加判断 —— 若 `getTunnelManager().getStatus().status === 'running'` 且请求非 localhost，即使 `!isPasswordSet()` 也要求认证。或隧道启动时无密码则自动生成临时密码
2. **隧道专用 session**：`auth.ts` 新增 `createTunnelSession()` / `validateTunnelSessionToken()`，TTL = 30min（`30 * 60 * 1000`），与主 session store 分离
3. **进程退出 hook**：在 app 创建处注册：
   ```ts
   const mgr = getTunnelManager();
   process.on('beforeExit', () => mgr.stop());
   process.on('SIGTERM', () => { mgr.stop().then(() => process.exit(0)); });
   ```
4. **readonly 模式**：隧道以 readonly 策略启动时，对写操作 API（POST/PUT/DELETE 非 auth 类）返回 403

**待修改文件**：
- `packages/core/src/server/app.ts`（auth 中间件 ~392-405 行；增加隧道 session 逻辑）
- `packages/core/src/server/auth.ts`（新增隧道 session 函数，TTL 30min）
- `packages/core/src/tunnel/manager.ts`（确保 stop() 可供 exit hook 调用）

**验收标准**：
- 集成测试：开放模式 + 隧道 running → 无 token 的 API 请求返回 401（当前返回 200）
- 集成测试：隧道 session 30min 后过期
- 进程 SIGTERM 时 stop() 被调用（mock 验证）

**风险**：开放模式强制认证会破坏现有 localhost 工作流。必须**仅在隧道激活且请求非 localhost 时**强制。用 `getTunnelManager().getStatus().status === 'running'` + `req.ip !== '127.0.0.1'` 作为门控条件。

---

### T4 — AI 多 Provider 开关修复

**对应 BLOCKER**：Spec 07 — multi-provider switch 在 chat handler 中被绕过

**根因**：
- `packages/core/src/server/app.ts:3670-3675`：`getDecryptedAiConfig()` 只读 `ai.token` / `ai.base_url` / `ai.model`，从不读 `ai.provider`
- `packages/core/src/db/config.ts:7`：默认值 `'ai.provider': 'custom'` 存在但后端忽略
- `OllamaProvider`（`packages/ai/src/provider/ollama.ts`）有 `healthCheck()` / `listModels()` / `embed()` 但在 chat 路径中被旁路

**修复方案**：
1. 在 `getDecryptedAiConfig()` 中读取 `ai.provider`，返回值增加 `provider` 字段
2. 在 `createAIChatHandler` 中根据 provider 选择实现类：
   - `provider === 'ollama'` → 使用 `OllamaProvider`
   - `provider === 'custom'`（默认）→ 使用 `AiProvider`
3. 在 `packages/cli/src/bin/doc77.ts` 的 `start` 命令中注入 `OllamaProvider` 到 `createAIChatHandler` 的 deps
4. 更新 deps 类型签名：增加可选 `OllamaProvider`
5. 补充路由：`GET /api/ai/models`（列出当前 provider 可用模型）、`GET /api/ai/providers`（列出支持的 provider 列表）

**待修改文件**：
- `packages/core/src/server/app.ts`（`createAIChatHandler` 内 `getDecryptedAiConfig` ~3666-3701 行；provider 选择逻辑；新增 /models /providers 路由）
- `packages/cli/src/bin/doc77.ts`（start 命令注入 OllamaProvider）

**验收标准**：
- 扩展 `packages/core/__tests__/ai-chat-handler.test.ts`：设置 `ai.provider = 'ollama'`，注入 StubOllamaProvider，验证 OllamaProvider 被构造（providerConstructed > 0）
- 测试 `ai.provider = 'custom'` 时仍用 AiProvider（回归保护）
- `GET /api/ai/providers` 返回 `['custom', 'ollama']`

**风险**：OllamaProvider 构造签名与 AiProvider 略有不同（接受 `ollamaUrl`）。需在 handler 中根据 provider 构造合适的 config 对象。

---

### T5 — 渲染器派发修复（调用插件 loader）

**对应 BLOCKER**：Spec 10 — renderer dispatch 不调用 plugins；.csv 不在 EXTENSION_MAP

**根因**：
- `packages/core/src/renderers/index.ts:188`：`getRendererForFile()` 纯 EXTENSION_MAP 查找，从不调用 `getPluginLoader().findRenderer()`
- `packages/core/src/server/app.ts:1701/1757`：`getRendererForFile` + `switch(rendererType)` 也硬编码
- `.csv` 不在 EXTENSION_MAP → 走默认 text 渲染

**修复方案**：
1. 改造 `getRendererForFile()` 增加（可选 async）插件查询分支：
   ```ts
   const builtin = builtinGetRendererForFile(filename);
   if (builtin !== 'text') return builtin;
   const plugin = getPluginLoader().findRenderer(ext);
   return plugin ? `plugin:${plugin.name}` : 'text';
   ```
2. 在 app.ts 的渲染 switch 中增加 `plugin:` 分支：调用对应插件实例的 `render()` 方法
3. 将 `.csv` 加入 EXTENSION_MAP → `'table'`（或新增 csv renderer）
4. 保留同步版本 `getRendererForFileSync()` 供无法 await 的路径使用

**待修改文件**：
- `packages/core/src/renderers/index.ts`（getRendererForFile 改造 + EXTENSION_MAP 增加 .csv）
- `packages/core/src/server/app.ts`（~1701/1757 行渲染 switch 增加 plugin 分支）

**验收标准**：
- 测试：注册一个 mock renderer 插件（扩展名 `.xyz`），`getRendererForFile('a.xyz')` 返回 `plugin:mock`
- 测试：`.csv` 文件返回非 `'text'` 的渲染类型
- 现有 `renderers/*.test.ts` 回归通过

**风险**：getRendererForFile 改为 async 会波及调用链。需审计调用点，无法 await 的路径保留 sync 版本 + 后台预热插件 loader。

---

### T6 — Electron 文件关联 + 通知模块

**对应 BLOCKER**：Spec 08 — 无 fileAssociations；notifications.ts 未实现；tray 菜单/快捷键/open-file 队列

**根因**：
- `packages/electron/package.json`：无 `build` 字段 → electron-builder 不注册文件关联
- `packages/electron/src/main.ts:209`：`handleFileOpen` 在 `!mainWindow` 时直接 return，无待处理队列
- `packages/electron/src/main.ts:196`：仅注册 `Ctrl+Shift+D`
- `packages/electron/src/tray.ts`：菜单 `[open, separator, quit]`，仅 click 监听
- `packages/electron/src/` 无 `notifications.ts`

**修复方案**：
1. **package.json 增加 build.fileAssociations**：
   ```json
   "build": {
     "fileAssociations": [
       { "ext": ["md","mdx","markdown"], "name": "Markdown", "role": "Editor" },
       { "ext": ["txt"], "name": "Plain Text" },
       { "ext": ["pdf"], "name": "PDF" },
       { "ext": ["json","yaml","yml"], "name": "Data" }
     ]
   }
   ```
2. **open-file 待处理队列**：main.ts 增加 `pendingFiles: string[]`。`handleFileOpen` 在 `!mainWindow` 时 push 到队列；`mainWindow` ready 后 drain 队列
3. **tray 菜单增强**：增加"检查更新"、"设置"项；增加 `tray.on('double-click', onClick)`
4. **快捷键**：增加 `Ctrl+Shift+F`（搜索）、`Ctrl+Shift+S`（同步）、`Ctrl+,`（设置）
5. **新建 `notifications.ts`**：封装 Electron `Notification` API，提供 `showNotification({title, body, clickAction})`。订阅事件总线（审批/同步/冲突/分享）
6. **before-quit 增加隧道 stop**：`app.on('before-quit')` 中调用 `getTunnelManager().stop()`（与 T3 配合）

**待修改文件**：
- `packages/electron/package.json`（增加 build 字段）
- `packages/electron/src/main.ts`（pendingFiles 队列、快捷键、before-quit 隧道 stop）
- `packages/electron/src/tray.ts`（菜单增强、double-click）

**待创建文件**：
- `packages/electron/src/notifications.ts`

**验收标准**：
- `package.json` JSON 校验通过，`build.fileAssociations` 存在且含 md/txt/pdf
- main.ts 中 pendingFiles 队列逻辑测试（mock mainWindow 未就绪 → 调用 handleFileOpen → 队列长度 1 → ready 后 drain）
- notifications.ts 导出 showNotification 函数，订阅事件总线

**风险**：Electron 无测试基础设施。建议抽离纯逻辑（pendingFiles 队列、notification 构造）为可测函数。

---

### T7 — PWA Service Worker HTTP 限制文档化

**对应 BLOCKER**：Spec 01 — LAN-HTTP 下 SW 无法注册

**根因**：浏览器安全限制，Service Worker 仅在 HTTPS 或 localhost 下可注册。LAN IP（如 192.168.x.x）走 HTTP 时 `navigator.serviceWorker.register` 抛错，PWA 离线能力不可用。

**修复方案**（文档 + 引导，非代码修复）：
1. 在 PWA 注册代码中检测协议：若非 HTTPS 且非 localhost，`console.warn` 提示并跳过 SW 注册（避免重复报错）
2. UI 提示：设置页面增加说明 —— "离线模式（PWA）需要 HTTPS。请在本地使用 localhost，或通过隧道（Spec 06）访问。"
3. `preview.html:128` 的 editBtn 增加 `data-action="edit"` 属性，使 CSS `body.is-offline [data-action="edit"]` 规则命中（离线时编辑按钮灰显）

**待修改文件**：
- PWA 注册脚本（`packages/core/src/web/js/common.js` 中的 SW 注册处，增加协议检测）
- `packages/core/src/web/preview.html`（editBtn 增加 data-action="edit"）
- 设置面板 UI 文案

**验收标准**：
- HTTP + LAN IP 访问时，控制台无 SW 注册错误（graceful skip）
- 设置页面显示 HTTPS 要求说明
- 离线状态下编辑按钮灰显（CSS 规则命中）

**风险**：低。纯防御性改动。

---

## 四、Phase 1 — 集成层（依赖 Phase 0，互相可并行）

### T8 — 同步路由 + scheduler

**对应 BLOCKER**：Spec 04/05 — sync routes 未挂载；缺 routes/scheduler

**前提**：T1 完成（engine 能正常 sync）

**修复方案**：
1. 新建 `packages/sync/src/routes.ts`：导出 `registerSyncRoutes(app, deps)` 函数，路由：
   - `GET /api/sync/configs/:projectId` — 获取同步配置
   - `PUT /api/sync/configs/:projectId` — 保存配置
   - `POST /api/sync/test` — 测试连接
   - `POST /api/sync/run/:projectId` — 立即同步
   - `GET /api/sync/state/:projectId` — 获取同步状态
   - `GET /api/sync/log/:projectId` — 同步日志
   - `POST /api/sync/scheduler/:projectId/start` / `stop`
2. 新建 `packages/sync/src/scheduler.ts`：从 engine.ts 抽离 startScheduler/stopScheduler，增加持久化（重启后恢复调度）
3. 在 `app.ts` 中挂载：`registerSyncRoutes(app, { engine: createSyncEngine(), db })`
4. 从 `packages/sync/src/index.ts` 导出 registerSyncRoutes

**待创建文件**：
- `packages/sync/src/routes.ts`
- `packages/sync/src/scheduler.ts`

**待修改文件**：
- `packages/core/src/server/app.ts`（挂载 registerSyncRoutes）
- `packages/sync/src/index.ts`（导出新模块）

**验收标准**：
- 集成测试 `packages/sync/__tests__/sync-routes.test.ts`：createApp → PUT 配置 → POST test → POST run → GET state，全链路 200
- 路由挂载验证：`GET /api/sync/configs/1` 返回 200（当前 404）
- 遵循 "接线回归测试" 范式：遍历 spec 声明的路由断言已注册

---

### T9 — 适配器 E2EE 集成

**对应 BLOCKER**：Spec 09 — 适配器不加密，push 上传明文

**前提**：T1（adapterConfig 统一）+ T2（keyring 可用）

**修复方案**：
1. 在 4 个适配器的 `push()` 中：若 keyring 已 unlock，调用 `encryptFile(content, keyring.getKey())` 后上传加密格式
2. 在 `pull()` 中：检测响应是否为加密格式（有 `encryptedKey` / `ciphertext` 字段），若是则 `decryptFile()`
3. 向后兼容：若 keyring 未 setup（无加密），push/pull 走明文（当前行为）
4. 元数据标记：上传时标记加密（如 `.enc.json` 后缀或 metadata header）
5. **git 适配器特殊处理**：git 有自己的传输加密（SSH/HTTPS），应用层加密会破坏 git diff。建议 git 适配器跳过 E2EE 或仅在 commit message 中标记

**待修改文件**：
- `packages/sync/src/adapters/webdav.ts`（push/pull 增加 encrypt/decrypt 分支）
- `packages/sync/src/adapters/s3.ts`
- `packages/sync/src/adapters/local.ts`
- `packages/sync/src/adapters/git.ts`（评估后决定是否加密）

**验收标准**：
- 测试：keyring unlock → push 文件 → 远端存储的是加密格式（含 ciphertext，非明文）
- 测试：pull 加密文件 → decryptFile → 内容与原始一致
- 测试：keyring locked → push 走明文（不崩溃）

**风险**：加密文件格式需版本化（`version: 1`），未来算法升级需迁移。git 适配器不适合应用层加密。

---

### T10 — RAG 模块

**对应 BLOCKER**：Spec 07 — RAG 完全未实现

**前提**：T4（provider 抽象可用，OllamaProvider.embed() 可调用）

**修复方案**：
1. 新建 `packages/ai/src/rag/` 目录：
   - `index.ts` — 导出 RagEngine
   - `embedder.ts` — 调用 OllamaProvider.embed() 或兼容 OpenAI embeddings API
   - `vector-store.ts` — 向量存储（sql.js 内存或 SQLite + 余弦相似度，**不用 FTS5**）
   - `chunker.ts` — 文档分块（按段落/固定大小）
   - `retriever.ts` — 查询 top-k 相关块
2. RagEngine API：`indexDocument(doc)`, `query(question): Context[]`, `reset()`
3. 集成到 chat handler：若 RAG 启用，query 相关上下文注入 system message
4. 路由（新建 `packages/core/src/server/routes/ai-rag.ts`）：
   - `POST /api/ai/rag/index` — 索引文档
   - `POST /api/ai/rag/query` — 查询相关块
   - `DELETE /api/ai/rag/:projectId` — 清除索引
5. DB 迁移：`rag_chunks` 表 `{ id, project_id, file_path, chunk_index, content, embedding (BLOB), created_at }`

**待创建文件**：
- `packages/ai/src/rag/index.ts` / `embedder.ts` / `vector-store.ts` / `chunker.ts` / `retriever.ts`
- `packages/core/src/server/routes/ai-rag.ts`

**待修改文件**：
- `packages/core/src/db/migrations.ts`（rag_chunks 表，注意与 T2 的 v10 协调版本号——RAG 用 v10 或 v11 视情况）
- `packages/ai/src/index.ts`（导出 RagEngine）

**验收标准**：
- 测试：index 一段文档 → query 相关问题 → 返回 top-k 块
- 向量存储使用 sql.js（已在依赖中），不依赖 FTS5
- `POST /api/ai/rag/index` 返回 200 且索引条数正确

**风险**：sql.js 向量搜索性能有限（全量扫描余弦相似度），但本地单用户场景足够。embed() 仅 OllamaProvider 实现，custom provider 需回退到 OpenAI embeddings API 或禁用 RAG。DB 迁移版本需与 T2/T11 协调。

---

### T11 — 插件沙箱 + API 路由

**对应 BLOCKER**：Spec 10 — sandbox 未实现；插件 API 路由缺失

**前提**：T5（渲染器派发已修复，插件可被发现）

**修复方案**：
1. 新建 `packages/core/src/plugin/sandbox.ts`：
   - 使用 Node.js `vm` 模块隔离插件执行
   - 提供受限 API：`fs`（仅限项目目录）、`http`（白名单）、`log`
   - 超时/资源限制
2. 扩展插件 API 路由（新建 `packages/core/src/server/routes/plugin.ts`）：
   - `POST /api/plugins/install` — 从 URL/npm 安装插件
   - `DELETE /api/plugins/:name` — 卸载
   - `GET /api/plugins/:name/config-schema` — 配置 schema
   - `GET/PUT /api/plugins/:name/config` — 读写配置
3. loader.ts 增强：
   - `discover()` 持久化 enable/disable 状态到 DB（当前仅内存）
   - `install()` 增加 manifest 版本兼容检查（`engines.doc77`）
   - 修复 `discover()` fire-and-forget 竞态（返回 Promise）
4. DB 迁移 v11：`plugins` 表 `{ id, name, version, enabled, config_json, installed_at }`

**待创建文件**：
- `packages/core/src/plugin/sandbox.ts`
- `packages/core/src/server/routes/plugin.ts`

**待修改文件**：
- `packages/core/src/plugin/loader.ts`（持久化、install、版本检查）
- `packages/core/src/server/app.ts`（挂载 registerPluginRoutes）
- `packages/core/src/db/migrations.ts`（v11 plugins 表）

**验收标准**：
- 测试：安装一个 mock 插件 → 发现 → toggle → 持久化 → 重启后状态保留
- sandbox 测试：插件尝试访问 `fs` 限定目录外 → 抛错
- `POST /api/plugins/install` 返回 200 且插件出现在 list 中

**风险**：vm 模块不是真正的安全沙箱（有逃逸风险）。对本地工具可接受，但需文档说明。DB 迁移版本需与 T2/T10 协调。

---

### T12 — 隧道路由 + 前端

**对应 BLOCKER**：Spec 06 — /config + /devices 路由缺失；TunnelConfig 缺策略字段

**前提**：T3（安全修复完成）

**修复方案**：
1. 扩展 `TunnelConfig` 类型（`packages/core/src/tunnel/manager.ts`）：
   ```ts
   export interface TunnelConfig {
     // 现有字段...
     accessPolicy: 'open' | 'readonly' | 'password';
     password?: string;
     allowedDevices?: string[];
     sessionTtlMinutes: number; // 默认 30
   }
   ```
2. 新增路由：
   - `PUT /api/tunnel/config` — 保存隧道配置（持久化到 DB config 表）
   - `GET /api/tunnel/config` — 读取配置
   - `GET /api/tunnel/devices` — 列出已连接设备（从 session store 推断）
3. 新建 `packages/core/src/web/js/tunnel-panel.js`：配置 provider、token、accessPolicy、查看 URL、管理设备
4. 设备管理：隧道 session 绑定设备指纹（User-Agent + IP hash），`/devices` 列出活跃 session

**待修改文件**：
- `packages/core/src/tunnel/manager.ts`（TunnelConfig 扩展）
- `packages/core/src/server/app.ts`（增加 config/devices 路由）

**待创建文件**：
- `packages/core/src/web/js/tunnel-panel.js`

**验收标准**：
- `PUT /api/tunnel/config` 保存 → `GET` 返回一致
- `GET /api/tunnel/devices` 返回活跃 session 列表
- 前端面板可切换 accessPolicy 并保存

---

## 五、Phase 2 — 前端与高级功能（依赖 Phase 1，互相可并行）

### T13 — 同步 diff + conflict + ai-assist

**对应 BLOCKER**：Spec 04/05/09 — 缺 diff.ts, conflict.ts, merge/ai-assist.ts

**前提**：T8（路由可用）+ T10（AI 可用，ai-assist 需调用 AI）

**修复方案**：
1. 新建 `packages/sync/src/diff.ts`：
   - `computeDiff(localContent, remoteContent): DiffResult` — 基于 diff-lines 或类似库
   - `formatDiff(diff): string` — unified diff 格式
2. 新建 `packages/sync/src/conflict.ts`：
   - `detectConflicts(changes): ConflictEntry[]` — 识别双向修改
   - `resolveConflict(conflict, strategy: 'local'|'remote'|'merge'|'ask'): Resolution`
   - 集成现有 `merge/diff3.ts` 的 `threeWayMerge()`
3. 新建 `packages/sync/src/merge/ai-assist.ts`：
   - `aiResolveConflict(conflict, context): Promise<Resolution>` — 调用 AI provider 给出合并建议
   - 构造 prompt：本地版本 + 远程版本 + 上下文 → 请求合并结果
4. 冲突 API 路由：`GET /api/sync/conflicts/:projectId` 返回待解决冲突列表

**待创建文件**：
- `packages/sync/src/diff.ts`
- `packages/sync/src/conflict.ts`
- `packages/sync/src/merge/ai-assist.ts`

**验收标准**：
- 测试：两个文件有冲突 → threeWayMerge + aiResolveConflict 返回合并结果
- diff 测试：本地 "A\nB" 远程 "A\nC" → diff 标记 B/C 冲突

---

### T14 — 同步前端面板 + CLI 子命令

**对应 BLOCKER**：Spec 04/05 — CLI 无 sync 子命令；前端面板缺失

**前提**：T8（路由可用）

**修复方案**：
1. CLI 子命令（`packages/cli/src/bin/doc77.ts`）：
   - `case 'sync':` — 子命令：`sync add <project> --type webdav --config '...'`, `sync run <project>`, `sync list`, `sync remove <project>`, `sync status <project>`
2. 新建 `packages/core/src/web/js/sync-panel.js`：
   - 配置面板：选择适配器类型、填写配置、测试连接、保存
   - 状态面板：上次同步时间、状态、日志
   - 冲突面板（与 T13 配合）：展示冲突、选择解决策略
3. 新建 `packages/core/src/web/js/conflict-ui.js`：三栏对比 UI（base / local / remote / merged），支持手动编辑
4. 新建 `packages/core/src/web/js/encryption-setup.js`：keyring setup/unlock UI（设置密码、显示恢复码、unlock）

**待修改文件**：
- `packages/cli/src/bin/doc77.ts`（增加 case 'sync'）

**待创建文件**：
- `packages/core/src/web/js/sync-panel.js`
- `packages/core/src/web/js/conflict-ui.js`
- `packages/core/src/web/js/encryption-setup.js`

**验收标准**：
- `doc77 sync list` 输出项目同步配置
- `doc77 sync run <project>` 触发同步并输出结果
- 前端面板可保存配置并触发同步

---

### T15 — 插件 CLI + 前端 UI

**对应 BLOCKER**：Spec 10 — CLI 无 plugin 子命令；前端 UI 缺失

**前提**：T11（沙箱 + API 路由）

**修复方案**：
1. CLI 子命令：
   - `case 'plugin':` — `plugin list`, `plugin install <name|url>`, `plugin remove <name>`, `plugin enable <name>`, `plugin disable <name>`
2. 新建 `packages/core/src/web/js/plugin-manager.js`：
   - 插件列表（名称、版本、类型、启用开关）
   - 安装/卸载按钮
   - 配置编辑（基于 config-schema 动态表单）
3. 集成到设置页面：新增"插件"标签页

**待修改文件**：
- `packages/cli/src/bin/doc77.ts`（增加 case 'plugin'）

**待创建文件**：
- `packages/core/src/web/js/plugin-manager.js`

**验收标准**：
- `doc77 plugin list` 输出已安装插件
- `doc77 plugin install <url>` 安装并出现在 list 中
- 前端可 toggle 插件并持久化

---

## 六、全局风险与约束

1. **DB 迁移版本协调**：当前最新 v9。T2（keyring 持久化）需 v10，T10（RAG）需 v10 或 v11，T11（插件持久化）需 v11。**约定**：T2 = v10，T10 = v10（不同表不冲突）或 v11，T11 = v12。多个 agent 同时加迁移需协调——不同表可共用同一版本号。
2. **app.ts 是 3600+ 行大文件**：T3/T4/T5/T8/T11/T12 都改 app.ts。每个任务尽量将新路由放外部 `routes/*.ts` 文件，app.ts 仅增加一行 `registerXxxRoutes(app, deps)`。
3. **FTS5/sql.js 约束**：T10 RAG 不用 FTS5（FTS5 是关键词搜索，非向量）。用 sql.js 内存数据库存向量，余弦相似度全量扫描。
4. **恢复码协议变更**（T2）：会破坏现有加密数据。但当前适配器上传明文，无已加密数据，可安全重置。setup() 加 `version` 字段未来支持迁移。
5. **Electron 无测试**（T6）：建议抽离纯逻辑（pendingFiles 队列、notification 构造）为可测函数。
6. **vm 模块沙箱非真正安全**（T11）：有逃逸风险。本地工具可接受，需文档说明。不引入 native 依赖。
7. **session TTL 分离**（T3）：主 session 12h，隧道 session 30min。两套 store 独立，不混淆。
8. **"接线回归测试"**（预防复发）：建议新增一个测试，遍历 10 个 spec 声明的入口，断言 app.ts 已注册对应路由 + CLI 已注册命令 + 前端存在 fetch 调用。

---

## 七、关键文件索引

| 关注点 | 文件路径 |
|--------|---------|
| 同步引擎 | `packages/sync/src/engine.ts` |
| 适配器配置 bug | `packages/sync/src/adapters/webdav.ts:78`, `s3.ts:102`, `local.ts:48` |
| keyring bug | `packages/sync/src/crypto/keyring.ts:21,46` |
| crypto 原语 | `packages/sync/src/crypto/encrypt.ts` |
| 三方合并 | `packages/sync/src/merge/diff3.ts` |
| sync DB 表（已存在） | `packages/core/src/db/migrations.ts:333-374` |
| AI chat handler | `packages/core/src/server/app.ts:3624` |
| AI provider 基类 | `packages/ai/src/provider/index.ts` |
| OllamaProvider | `packages/ai/src/provider/ollama.ts` |
| config 默认值 | `packages/core/src/db/config.ts:7` |
| 渲染器派发 | `packages/core/src/renderers/index.ts:188` |
| 插件 loader | `packages/core/src/plugin/loader.ts` |
| 隧道管理器 | `packages/core/src/tunnel/manager.ts` |
| auth 中间件 | `packages/core/src/server/app.ts:392-405` |
| auth session TTL | `packages/core/src/server/auth.ts:144` |
| 隧道/插件路由 | `packages/core/src/server/app.ts:3077-3124` |
| CLI 入口 | `packages/cli/src/bin/doc77.ts:194` |
| Electron main | `packages/electron/src/main.ts:196,209,222` |
| Electron tray | `packages/electron/src/tray.ts` |
| Electron package.json | `packages/electron/package.json` |
| editor-core 派发 | `packages/core/src/web/js/editor-core.js:155-182` |
| preview.html editBtn | `packages/core/src/web/preview.html:128` |
| app.css 离线规则 | `packages/core/src/web/css/app.css:2956` |
| wiring 测试范例 | `packages/core/__tests__/ai-chat-handler.test.ts:77` |
| 集成测试范例 | `packages/core/__tests__/server.test.ts` |
| DEK 信封参考 | `packages/core/src/server/auth.ts`（setupPasswordWithDEK） |
| 迁移检测 FTS5 | `packages/core/src/db/migrations.ts:35-46,87-88` |

---

## 八、Agent 实施主提示词

> 以下提示词可直接复制交给 agent 执行。将 `{TASK_ID}` 替换为具体任务编号（如 T1），或将 `{PHASE}` 替换为阶段名（如 Phase 0）执行整批。

```
你是 Doc77 项目的实施 agent。项目根目录：D:\code\doc77（monorepo，pnpm + TypeScript + tsup + Vitest）。

## 你的任务

执行实施基线文档 docs/analysis/implementation-plan-2026-07-31.md 中的任务 {TASK_ID}。
请先完整阅读该任务章节，理解根因、修复方案、文件清单、验收标准和风险。

## 执行要求

1. **先读码再改码**：修改任何文件前，先用 Read 工具读取该文件当前内容，理解上下文。不要凭文档描述盲改。
2. **遵循现有模式**：
   - 新路由用外部 `registerXxxRoutes(app, deps)` 函数（参考 `packages/core/src/server/routes/ai-*.ts` + app.ts 挂载方式）
   - 集成测试用 `createApp() → http.createServer → fetch` 范式（参考 `packages/core/__tests__/server.test.ts`）
   - DB 迁移在 `migrations.ts` 中按版本号递增（当前最新 v9，约定 T2=v10，T10=v10/v11，T11=v11/v12）
3. **不重建已有 DB 表**：sync_configs/sync_state/sync_log 三表已存在（migrations.ts:333-374），核对字段后复用。
4. **不破坏 git 适配器**：git.ts 用 git.status() 自发现变更，不依赖 changedFiles。修改 engine 时确保 git 路径仍可用。
5. **写测试**：每个任务都要有对应的测试文件，至少覆盖验收标准中的场景。测试用 Vitest（*.test.ts）。
6. **自验证**：完成代码后运行 `pnpm --filter <package> build` 确认构建通过，运行 `pnpm test` 确认测试通过。
7. **不跳过类型检查**：虽然 tsup 不做完整类型检查，但 electron 包用 tsc 真实类型检查。新增代码要类型正确。

## 关键约束

- app.ts 已 3600+ 行，新路由必须放外部文件
- sql.js（WASM SQLite）不支持 FTS5，RAG 向量存储不用 FTS5
- vm 模块沙箱非真正安全，文档说明即可
- 恢复码协议是设计错误（非单纯 bug），修复需改用 masterKey 包裹模式（参考 core auth.ts 的 DEK 信封）
- 中文环境，代码注释和文档用中文

## 输出

完成后报告：
1. 修改/创建的文件清单
2. 测试结果（通过/失败）
3. 构建结果
4. 遗留问题或风险（如有）

## 参考文档

- 审查报告：docs/analysis/spec-review-2026-07-31.md（19 条 BLOCKER 详情）
- 本实施基线：docs/analysis/implementation-plan-2026-07-31.md（15 个任务设计）
- 安全审计：docs/analysis/security-audit-2026-07-28.md（2026-07-28 安全修复记录）
```

### 批量执行提示词（整阶段）

```
你是 Doc77 项目的实施 agent。项目根目录：D:\code\doc77。

执行 {PHASE} 的全部任务（{TASK_LIST}）。这些任务互相独立，可并行。

对每个任务：
1. 阅读实施基线文档 docs/analysis/implementation-plan-2026-07-31.md 对应章节
2. 读取相关源码确认当前状态
3. 按修复方案实施
4. 写测试并验证
5. 构建确认

注意：多任务可能都需修改 app.ts —— 每个任务的新路由放外部 routes/*.ts 文件，app.ts 仅增加一行挂载调用。如果发现 app.ts 冲突，以挂载调用顺序解决。

DB 迁移版本协调：{MIGRATION_ASSIGNMENTS}

完成后报告每个任务的：文件清单、测试结果、构建结果。
```

---

## 九、验收检查清单

全部 15 个任务完成后，执行以下整体验收：

- [ ] **接线回归测试**：新增测试遍历 10 个 spec 声明的入口，断言 app.ts 已注册全部路由 + CLI 已注册全部命令
- [ ] `doc77 sync list` / `doc77 sync run` 可用
- [ ] `doc77 plugin list` / `doc77 plugin install` 可用
- [ ] `GET /api/sync/configs/:id` 返回 200（当前 404）
- [ ] `GET /api/tunnel/config` 返回 200（当前 404）
- [ ] `GET /api/tunnel/devices` 返回 200（当前 404）
- [ ] `POST /api/ai/rag/index` 返回 200（当前 404）
- [ ] `GET /api/ai/providers` 返回 `['custom', 'ollama']`
- [ ] `POST /api/plugins/install` 返回 200（当前 404）
- [ ] 开放模式 + 隧道 running → 无 token 请求返回 401
- [ ] 恢复码解锁后能解密用密码加密的文件
- [ ] `.csv` 文件渲染为表格（非纯文本）
- [ ] Electron 双击 .md 文件用 Doc77 打开
- [ ] LAN-HTTP 访问时 SW 注册 graceful skip（无报错）
- [ ] `pnpm build` 全部包通过
- [ ] `pnpm test` 通过

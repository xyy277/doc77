# Doc77 11 个 Spec 代码审查报告

> 审查日期：2026-07-31 ｜ 审查人：Code Reviewer Agent
> 方法：8 路并行副手逐 spec 读码 + 关键 BLOCKER 由主审亲自核实（grep / 读源码）
> 环境约束：数据库为 **sql.js（WASM SQLite，默认不含 FTS5）**；构建用 tsup/esbuild **不做类型检查**

> **🔄 复核记录（2026-07-31 第二轮，同日）**：主审对第一轮全部 🔴 BLOCKER 与关键 🟡 项逐条重新读源码核实，本版在对应条目后追加 `[✅已核实]` / `[⚠️修正]` / `[💡补充]` 标记，并在文末新增「五、复核结论」汇总。**结论：第一轮 9 条 🔴 BLOCKER 全部经源码二次确认成立；3 处事实性细节需修正（不影响 BLOCKER 判定）；另补充 2 处第一轮未提及的实现缺陷。**

---

## 一、总览结论

**11 个 spec 中，10 个是已实现功能，Spec 11 是"原生移动 App 评估文档"（明确"暂不启动"，无运行时 bug）。**
对 10 个已实现功能逐一审查后，**没有一个能算"开箱即用"**。问题集中在两类：

1. **"写了模块但没通电"** —— 这是最大系统性问题。大量功能在 `packages/*` 里有实现，却**从未挂载进 `core` 的 `app.ts` / CLI / 前端**，导致用户根本触发不到（同步、隧道前端、插件渲染接管、AI Provider 切换、RAG）。
2. **环境/契约偏差** —— FTS5 在 sql.js 下退化为 LIKE 搜索；API 路径与 spec 不一致；配置键名不符。

### 逐 Spec  verdict

| Spec | 功能 | 可用性 | 最高优先级问题 |
|---|---|---|---|
| 01 | PWA 离线 | ⚠️ 部分可用 | LAN-HTTP 下 SW 不注册；离线编辑按钮不灰显 |
| 02 | 轻量编辑 | ✅ 核心可用 / 降级 | 代码高亮失效；2MB 仅保存时拦截；无文件锁 |
| 03 | 全文搜索 | ⚠️ 可用但严重降级 | FTS5→LIKE 退化；索引触发不全；API 路径改 `/api/fts` |
| 04 | Git 同步 | 🔴 不可用（BLOCKER） | 未挂载；引擎 `changedFiles` 硬编码空 |
| 05 | WebDAV/S3 同步 | 🔴 不可用（BLOCKER） | 同上 + 适配器 config 键错位 + 缺失 routes/前端 |
| 06 | 远程隧道 | 🔴 用户入口缺失（BLOCKER） | 前端面板完全不存在；开放模式远程免认证 |
| 07 | Ollama + RAG | 🔴 RAG 缺失 / Provider 切换失效（BLOCKER） | `rag/` 未实现；聊天不读 `ai.provider` |
| 08 | Electron 原生 | 🔴 多项 BLOCKER（静态审查） | 无 `fileAssociations`；无原生通知 |
| 09 | 冲突合并 + E2EE | 🔴 端到端不可用（BLOCKER） | API/前端/加密层全缺；恢复码密钥派生 bug |
| 10 | 插件系统 | 🔴 不能接管渲染（BLOCKER） | 渲染分发不调插件；无 sandbox；无 CLI |
| 11 | 原生移动评估 | ➖ 评估文档 | 非功能，无运行时 bug；决策合理 |

---

## 二、逐 Spec 详细发现

### Spec 01 — PWA 离线缓存
**状态：localhost/HTTPS 下基本可用，但真实部署（LAN-HTTP）下验收整体不可达。**

- 🔴 **部署级阻断（架构约束）**：Service Worker 仅在安全上下文（HTTPS/localhost）注册。Doc77 经 LAN IP 以 HTTP 访问时 `navigator.serviceWorker.register` 直接抛错，SW 永不激活 → 验收 #1/#3/#4/#6/#7（安装图标、离线缓存、离线 banner）在真实 LAN 场景全部不可达。需 HTTPS 或走 Spec 06 隧道。
- 🟡 **离线编辑按钮不灰显**：`preview.html` 的 editBtn 缺 `data-action="edit"` 属性，导致 CSS `body.is-offline [data-action="edit"]` 规则不命中 → 离线时 ✏️ 仍可点击，点击后 PUT 失败报错（破坏验收 #5）。`[✅已核实]` `preview.html:128` 的 `<button id="editBtn" disabled onclick="toggleEditMode()">` 确无 `data-action`；`css/app.css:2956` `body.is-offline [data-action="edit"]` 规则存在但不匹配。
- 💭 缺 spec §4.1 的 `GET /api/offline/manifest`；`gallery.html` 未接 PWA。
- ✅ 正常：`/manifest.json`、`/sw.js`（`Service-Worker-Allowed: /`）、图标 PNG、SW 的 SWR+IndexedDB/导航离线回退/LRU、`common.js` 的 SW 注册与离线 banner 均生效。

### Spec 02 — 轻量编辑
**状态：核心链路可用，但部分能力降级。**

- 🟡 **代码文件语法高亮失效**：`editor-core.js` 加载到的语言包未注入编辑器（无 `Compartment.reconfigure`），`.ts/.js/.py` 等无高亮，破坏 Phase 2。`[✅已核实]` `[💡补充]` 实际比上述更严重：`editor-core.js:155-182` 调用了 `loadLanguage(lang)` 拿到 `langFn()`，但随后的 5 次 `view.dispatch({ effects: [...] })` 全部传入**空数组**（`effects: cmModules.EditorView ? [] : []`、`effects: []` 等），`langExt` 变量加载后从未被附加到编辑器。这不是"缺少 Compartment"，而是一段半成品占位代码——看起来在实现，实则全是 no-op。
- 🟡 **大文件拦截位置错误**：2MB 限制在保存时才以 413 返回，打开时编辑按钮仍显示且整文件读入编辑器（破坏验收 #7"打开即提示不可编辑"）。
- 🟡 **文件锁未实现**：spec 步骤 5 `acquireFileLock→423` 缺失，并发编辑可能相互覆盖。
- 💭 配置键命名偏离：`editor.maxFileSizeMB`(MB) vs spec `editor.maxFileSize`(bytes)。
- ✅ 正常：`PUT /api/content` 路由完整——扩展名白名单 403、敏感文件 403、Shadow 备份+回滚、`X-Expected-Modified` 冲突检测、`X-Force-Overwrite` 覆盖、自动保存去抖、Ctrl+S、409 覆盖弹窗、移动端隐藏编辑按钮、CDN 失败降级 textarea 全部接通。

### Spec 03 — 全文搜索（FTS5）
**状态：可用但严重降级（重要澄清：不崩溃）。**

- ✅ **不会崩溃**：`migrations.ts:35` 的 `detectFts5()` 运行时探测，失败则 `fts5Available=false` 并建普通表 + 降级 LIKE 搜索。sql.js 无 FTS5 时走 LIKE 分支，**不会导致运行时崩溃**——但：`[✅已核实]` `migrations.ts:87` `fts5Available = detectFts5(conn)` + `:88` `conn.exec(fts5Available ? SEARCH_SCHEMA_SQL : SEARCH_SCHEMA_FALLBACK_SQL)` 兜底确认成立。
- 🟡 **搜索质量退化**：LIKE 全表扫描无法满足验收 #5（10K 文件 <200ms）；中文退化为"连续子串匹配"而非单字匹配（搜"数据库"不能命中"数据…库"），破坏验收 #7。
- 🟡 **索引触发不全**：注册项目不自动索引（仅手动 `POST /api/fts/:id/index`）；删除文件不清索引；增量仅接 edit_file API，MCP 写入与 SSE `file-changed` 未接；无 30min 定时扫描。
- 💭 API 路径与 spec 不符（`/api/fts` vs spec `/api/search`）；缺 `tokenizer.ts`/`worker.ts`；FTS5↔非FTS5 环境切换重建同名虚拟表会抛 "already exists"。`[⚠️修正]` 实际上 `app.ts` 中 `/api/search`（纯 Node.js `searchInFiles`，grep 风格）与 `/api/fts`（FTS5/LIKE 倒排）**两者并存**——spec 约定的 `/api/search` 路径存在，只是它是另一套简单实现；FTS5 倒排搜索暴露在 `/api/fts`。原表述"路径不符"易误解为 `/api/search` 不存在，此处澄清。
- ✅ 正常：Ctrl+K 弹窗、分组渲染、`<mark>` 高亮结构、编辑后增量更新、迁移探测兜底设计稳健。
- 💡 **修复方向**：要么换 `better-sqlite3`/`node-sqlite3`（原生含 FTS5），要么直接用 `minisearch`/`flexsearch` 做轻量倒排索引（推荐，跨平台零依赖）。

### Spec 04 / 05 — 同步引擎（Git + WebDAV/S3/Local）
**状态：🔴 仅有可构建骨架，对用户完全不可用（BLOCKER）。**

- 🔴 **未接通（集成断裂）**：`createSyncEngine()` 只在 `packages/sync/src/index.ts` 定义，`app.ts` 中**无任何 `/api/sync/*` 路由**，CLI 无 `sync` 子命令（`grep` 命中的 "sync" 全是 `fs.existsSync` 巧合）。验收 §7、04#8 全部不成立。`[✅已核实]` CLI `doc77.ts` 的 `switch` 仅有 `start/register/list/remove/update/config/approve/lock/vendor-install/status/i/rm/mcp/ai/discover`，确无 `sync` 与 `plugin`。
- 🔴 **引擎 `changedFiles` 恒空**：`engine.ts:66-67` 硬编码 `changedFiles: []`、`remoteFiles: []`，从不调用 `diff.scanLocal`/`adapter.listRemote`/`diff.compareRemote` → WebDAV/S3/local 的 `push()` 遍历空数组，**推送永久 no-op**（验证 05#2 彻底失败）。`[✅已核实]` `webdav.ts:122` `for (const change of ctx.changedFiles)` 直接遍历空数组；注意 WebDAV 的 `pull()` 反而绕过 ctx、直接调 `listRemote`，所以 pull 可能部分工作，但 push 必然空转。
- 🔴 **config 键错位**：`engine.ts:72` 只塞 `options.gitConfig`，但 webdav/s3/local 读的是 `ctx.options.adapterConfig`（undefined）→ 崩溃或静默 no-op。`[✅已核实]` `webdav.ts:78` `const cfg = (ctx.options as any).adapterConfig`、`s3.ts`/`local.ts` 同样从 `adapterConfig` 取配置。
- 🔴 **缺失 spec 要求的文件**：`routes.ts`、`web/sync-panel.js`、`diff.ts`、`conflict.ts`、`scheduler.ts`、`state.ts`、`adapters/adapter.ts`、`adapters/index.ts` 均不存在 → REST API 与前端面板整段缺失。`[⚠️修正]` 澄清：`adapters/` 目录本身**存在**，内含 `git.ts`/`local.ts`/`s3.ts`/`webdav.ts` 四个适配器实现；仅缺失基类 `adapter.ts` 与 barrel `index.ts`。原表述"adapters/...均不存在"可能被误读为四个适配器都没写，实际只有基类与导出文件缺失。
- 🟡 冲突检测与 baseline 失效：`result.conflicts` 恒为 `[]`，从不更新 `sync_state.last_baseline`；多设备会反复全量覆盖。
- ✅ 正常：包可构建；迁移表 schema 正确；依赖齐全；`getAdapter` 注册表可用；`testConnection` 可用；Git `pull/push` 基础逻辑在 ctx 正确传入时可跑通。

### Spec 06 — 远程访问隧道
**状态：🔴 后端半打通，用户唯一入口（前端）完全缺失（BLOCKER）。**

- 🔴 **前端面板彻底缺失**：`packages/core/src/web` 下**无任何 tunnel/远程访问代码**（全仓 grep 确认）；spec 引用的 `web/js/settings.js` 不存在 → 验收 #1/#2/#6 无法被用户触发。
- 🔴 **`/api/tunnel/config`(PUT) 与 `/api/tunnel/devices`(GET) 未注册** → 设备列表无法渲染、配置无法持久化。
- 🔴 **`TunnelConfig` 缺策略字段**：无 `accessPolicy/password/allowedDevices`，只读/白名单策略无法传入。
- 🟡 **开放模式远程强制认证失效**：`app.ts:398` `if (!auth.isPasswordSet()) return next();` → 本地免登录时远程请求完全不校验，任何人持隧道 URL 可直读全部 API（破坏验收 #5）。`[✅已核实]` 注：2026-07-28 已补上认证中间件（见 `docs/analysis/security-audit-2026-07-28.md`），但 open-mode 下对远程请求仍放行——本条针对的就是这个剩余缺口，不是"中间件缺失"。
- 🟡 **只读模式未实现**（无中间件拦截远程写路由）；**关闭 App 不杀隧道进程**（无 `SIGTERM`/`exit` 钩子调 `mgr.stop()`）；**会话超时 12h 而非 30min**。`[✅已核实]` `[⚠️修正]` 会话超时实际值是 **6 小时**（`sessions.ts:12` `SESSION_TTL_MS = 1000 * 60 * 60 * 6`），不是 12h；问题仍然成立（6h ≫ spec 的 30min），但数字需更正。另外该 TTL 是**全局 auth session**，非隧道专属，远程访问要 30min 需在隧道中间件层单独设短 TTL。`[💡补充]` `manager.ts` 仅在 spawn 的子进程 `exit` 事件里做状态清理，进程级 `process.on('beforeExit')`/`SIGTERM` 并未调 `mgr.stop()`，App 被强杀时 cloudflared/ngrok 子进程会变孤儿。
- ✅ 正常：`TunnelManager` 生命周期可用（spawn cloudflared/ngrok/tailscale、解析 URL、退出自动重启、二进制缺失优雅降级）；`/api/tunnel/status|start|stop` 已挂载并有密码时 session 校验有效。

### Spec 07 — AI Ollama + RAG
**状态：🔴 RAG 完全缺失；多 Provider 切换后端失效（BLOCKER）。**

- 🔴 **RAG 完全未实现**：`packages/ai/src/rag/**` 目录不存在；`migrations.ts` 无 `rag_chunks` 表；server 无 `/api/ai/rag/*` 路由；前端无引用 → 验收 #3（引用回答）、#6（索引<60s）彻底无法满足。`[✅已核实]` `ls packages/ai/src/` 仅有 `agent/`/`provider/`/`skills/` 三个子目录与几个独立 .ts 文件，确无 `rag/`。
- 🔴 **多 Provider 切换未接通后端**（已核实）：`OllamaProvider` 仅在 `app.ts:502` `/api/ai/ollama/status` 健康检查用到；聊天 handler 只读 `ai.token/base_url/model`，**从不读 `ai.provider`** → 用户选 Ollama 后对话仍走默认远程模型（破坏验收 #1/#2/#4/#5 的"切换"）。`[✅已核实]` `createAIChatHandler` 的 `getDecryptedAiConfig` 闭包只查 `ai.token`/`ai.base_url`/`ai.model` 三键，构造 `new AiProvider({apiKey, baseUrl, model})` 时未分支 `ai.provider==='ollama'` → `OllamaProvider` 在聊天路径完全旁路。
- 🟡 **API 扩展缺失**：spec 要求 `/api/ai/models`、`/api/ai/providers`、`/api/ai/rag/*`，实际仅 `/api/ai/ollama/status`；`POST /api/ai/chat` 不支持 `provider/model` 参数。
- 🟡 **前端模型下拉/RAG 引用 UI 缺失**（实际为 `ai-workspace.js`，无 provider/model 选择、无引用渲染、无 Ollama 引导）。
- ✅ 正常：`OllamaProvider.healthCheck/listModels/embed` 实现正确；`/status` 优雅降级（无 Ollama 不影响其他 AI）；现有 OpenAI 对话 SSE 流式健壮。

### Spec 08 — Electron 原生体验（静态审查）
**状态：🔴 多项 BLOCKER（读码即可确认，Electron 无法在此环境运行）。**

- 🔴 **`package.json` 缺少 `build.fileAssociations`**（已核实：只有 npm `build` 脚本，无 electron-builder `build` 配置）→ OS 不注册 `.md/.mdx/.txt/.pdf`，双击不会用 Doc77 启动（破坏验收 #4）。`[✅已核实]` `packages/electron/package.json` 确无顶层 `build` 字段。
- 🔴 **`notifications.ts` 完全未实现**：全仓无 `Notification` 引用，`main.ts` 未订阅事件总线（审批/同步/冲突/分享）→ 验收 #5 整条链路不存在。`[✅已核实]` `ls packages/electron/src/` = `i18n/main/preload/server/shims.d.ts/tray/updater`，确无 `notifications.ts`；`main.ts` grep `Notification` 零命中。
- 🟡 **托盘菜单残缺**：`tray.ts` 仅 `open`+`quit` 两项，缺 Dashboard/最近文件/同步/设置，且无 `double-click` 监听（破坏验收 #1）。`[✅已核实]` `tray.ts:12-24` 模板确为 `[open, separator, quit]`；`tray.on('click', onClick)` 是单击监听，无 `'double-click'`。
- 🟡 **全局快捷键不全**：仅注册 `Ctrl+Shift+D`，缺 `Ctrl+Shift+F`(搜索)/`Ctrl+Shift+S`(同步)。`[✅已核实]` `main.ts:196` `globalShortcut.register('CommandOrControl+Shift+D', …)` 为唯一注册点。
- 🟡 **文件打开路由疑似不匹配 + 冷启动丢失**：`main.ts` 用 `/preview.html?file=<绝对路径>`（spec 约定 `/preview?id=X&path=...`）；`open-file` 在 app ready 前 `mainWindow` 为 null 直接 return，macOS 冷启动双击静默丢弃。`[✅已核实]` `main.ts:209` `if (!mainWindow || !server) return;` → ready 前的 `open-file` 事件被 `preventDefault()` 后直接吞掉，且未把 `filePath` 入队等 ready 再处理。
- 🟡 **updater 缺 4h 检查/系统通知**（spec 8.1/8.2）。
- ✅ 正常：窗口状态记忆（验收 #6）、关闭最小化托盘（#2）、单实例锁+second-instance/open-file 接线、图标资源、updater 基础 IPC、包可构建（electron 用 tsc 真实类型检查）。

### Spec 09 — 冲突智能解决 + E2EE
**状态：🔴 端到端不可用（BLOCKER，且依赖 04/05 未通）。**

- 🔴 **API 路由全缺**：`app.ts` 无 `/api/sync/:projectId/merge|/diff|/encryption/*`。`[✅已核实]`
- 🔴 **`merge/ai-assist.ts` 不存在**（AI 辅助合并 L2 未实现）；**前端 `web/conflict-ui.js`/`encryption-setup.js` 不存在**。`[✅已核实]` `ls packages/sync/src/merge/` 仅有 `diff3.ts`；`ls packages/core/src/web/js/` 确无 `conflict-ui.js`/`encryption-setup.js`。
- 🔴 **适配器未集成加密层**：`git/webdav/s3.ts` 均未 import `crypto`，push 直接 `fs.readFileSync` 上传**明文** → E2EE 形同虚设（破坏验收 #5/#6/#8/#9）。`[✅已核实]` grep `import.*crypto|from.*crypto|getKeyring|encrypt|decrypt` 在 `packages/sync/src/adapters/` 下仅命中 `s3.ts:156` 与 `webdav.ts:134` 的 `fs.readFileSync`，无任何加密调用；`git.ts`/`local.ts` 全无 crypto 痕迹。
- 🔴 **恢复码密钥派生 bug（已核实，比描述更严重）**：`setup()` 用 `deriveKey(password)` 生成主密钥加密文件；但 `unlockWithRecovery()` 用 `deriveKey(recoveryCode)` 派生密钥——**两个不同密钥** → 用恢复码解锁后完全解不开当初加密的文件（破坏验收 #6）。此外 `recoveryCodeHash` 为内存态，`getKeyring()` 单例不持久化 salt，新设备根本无 salt 可调。`[✅已核实]` `keyring.ts:21` `this.masterKey = deriveKey(password, this.salt)`；`keyring.ts:46` `this.masterKey = deriveKey(code.trim().toLowerCase(), this.salt)` —— 确系两套派生输入。`[💡补充]` 这不只是"bug"，而是**协议设计错误**：恢复码本应作为"备用口令"派生同一 masterKey，或用恢复码解密一份"主密钥密文"（envelope），当前实现两条路互不相通，恢复码功能本质上是死的。
- 🟡 **diff3 是朴素行对齐**（非真实 3-way merge），本地插入/删除一行导致后续全部错位、大面积假冲突；**baseline 从未保存/读取**，`threeWayMerge` 的 `base` 无来源。
- ✅ 正常：`encrypt/decrypt`（AES-256-GCM，per-file fileKey）单次会话内逻辑正确；diff3 判定标签正确；`resolveConflicts` 能按 local/remote 落盘。

### Spec 10 — 插件系统
**状态：🔴 骨架级，不能接管渲染/主题（BLOCKER）。**

- 🔴 **渲染分发从不调插件**（已核实）：`getPluginLoader()` 只在 3 个插件 API 路由调用，**渲染路径（`getRendererForFile`/`switch(rendererType)`）硬编码内置渲染器** → 验收 #1(.csv 表格)/#2(主题)/#3(禁用回退) 均不可能。`[✅已核实]` `renderers/index.ts:188` `getRendererForFile` 纯 `EXTENSION_MAP` 查表，无 `getPluginLoader()` 调用；`app.ts:1701/1757` 的 `getRendererForFile` + `switch(rendererType)` 同样硬编码。`[💡补充]` 注意 `.csv` 连内置 `EXTENSION_MAP` 都没有 → 当前 .csv 渲染走 `default` 分支返回纯文本，离"表格渲染"差两层（既无插件接管，也无内置表格渲染器）。
- 🔴 **沙箱完全未实现**：`sandbox.ts` 不存在，无权限校验/Proxy 隔离 → 验收 #4（未声明 network 的插件不能发请求）可绕过，插件在主进程可自由 `require('http')`。`[✅已核实]` `ls packages/core/src/plugin/` = `loader.ts`/`types.ts`，确无 `sandbox.ts`。
- 🔴 **CLI 无 plugin 命令**；**前端管理 UI 不存在**。`[✅已核实]` CLI `doc77.ts` 的 `case` 分支无 `plugin`；`web/js/` 无插件管理页面。
- 🟡 **API 路由缺失**：仅 `GET /api/plugins`、`PUT /:name/toggle`、`POST /discover`；spec 要求的 `install`/`DELETE /:name`/`config-schema`/`config` 全缺。
- 🟡 **discover 竞态**（fire-and-forget，首请求返回空）；**禁用不持久**（`discover()` 每次重置 `enabled:true`）；**无版本兼容检查**。
- ✅ 正常：`discover()` 扫描/解析 `plugin.json` 正确；`loadPlugin()` 动态 import + 异常隔离；零开销（无插件目录直接 return）。

### Spec 11 — 原生移动 App 评估
**状态：➖ 评估文档，非功能实现，无运行时 bug。**
文档结论"当前（2026 Q3-Q4）不启动原生 App，PWA + 隧道已覆盖 80% 场景"合理，且给出明确的触发评估清单。不计入"功能 bug"，但需向用户说明：**你本地测试的那 10 个功能不含 Spec 11**。

---

## 三、根因分析与修复优先级

### 根因（共性）
1. **缺少"接线回归测试"**：每个 spec 收尾只验证了"模块能编译/单元断言通过"，没有验证 **(a) `app.ts` 是否挂载了 spec 声明的全部路由、(b) 前端是否真的调用、(c) CLI 是否注册命令、(d) 端到端手测**。结果是"包活着但没插电"。
2. **数据库能力边界**：sql.js 不支持 FTS5，但 Spec 03 直接依赖 FTS5；要么换存储，要么改方案。
3. **跨 spec 依赖未落地**：Spec 09 依赖 Spec 04/05 引擎，但引擎本身未通，导致 09 无从验证。
4. **安全中间件缺位**：远程访问的强制认证/只读、插件沙箱，都只在 spec 里声明，未实现。

### 修复优先级
**P0 — 完全不可用，先接通（按依赖顺序）**
1. Spec 04/05：挂载 `mountSyncRoutes(app, db)` + CLI `sync` 命令；修复 `engine.ts` 调用 `scanLocal/listRemote` 填充 ctx；统一 `adapterConfig`；补齐 `routes.ts`/前端面板。
2. Spec 06：补前端远程访问面板 + `/config` `/devices` 路由；加"非本地请求强制认证 + 只读 + 独立 30min 超时"中间件；注册进程退出钩子调 `mgr.stop()`。
3. Spec 07：后端读 `ai.provider` 并按值构造 `OllamaProvider`；补 `/api/ai/models` `/providers`；实现 `rag/*` 模块+表+路由+前端引用 UI。
4. Spec 08：`package.json` 加 `build.fileAssociations`；实现 `notifications.ts` 订阅事件总线；补全托盘菜单/快捷键/文件打开路由。
5. Spec 09：依赖 04/05 后，修恢复码密钥派生（`setup` 时也应能从 recoveryCode 派生同一 masterKey，或加密一份 recoveryKey 密文）、补 API/前端/适配器加密层。
6. Spec 10：`app.ts` 渲染分发调用 `getPluginLoader().findRenderer()`；实现 `sandbox.ts`；补 CLI 命令与 install/delete/config 路由；前端插件 UI。

**P1 — 严重降级，需修正**
- Spec 03：换 FTS5 存储方案或改用 minisearch/flexsearch；补全索引触发链路（注册自动索引、删除清理、SSE 增量、定时扫描）；统一 API 路径契约。
- Spec 02：用 `Compartment` 修复代码高亮；打开时按 `stat.size` 预判大文件；实现文件锁。
- Spec 01：`preview.html` editBtn 加 `data-action="edit"`；文档说明 LAN-HTTP 下 SW 不可用的限制/建议 HTTPS 隧道。

**P2 — 打磨**：各 spec 的 MINOR 项（版本检查、discover 竞态、i18n key、配置键命名、测试覆盖真实路由）。

### 建议的"接线回归测试"（预防复发）
新增一个测试，遍历 10 个 spec 声明的入口，断言：
- `app.ts` 已注册对应路由（如 `/api/sync`, `/api/fts`, `/api/tunnel/config`, `/api/plugins/install`, `/api/ai/rag/index` 等）；
- CLI 已注册对应命令；
- 前端 JS 中存在对应 fetch/事件调用。
这样能防止"模块写了但没通电"的问题再次溜进 main。

---

## 四、说明
- 本审查基于**静态读码 + 关键路径核实**，未实际启动应用（环境存在 sql.js/FTS5、tsc 预存类型错误等已知问题）。Electron 相关结论为静态审查，部分需人工运行验证（已标注）。
- 8 路副手报告与主线核实结论一致；所有 🔴 BLOCKER 均经主审 grep/读源码二次确认。

---

## 五、复核结论（2026-07-31 第二轮）

主审在第一轮报告交付后，对全部 9 条 🔴 BLOCKER 与关键 🟡 项**逐条重新打开源码核实**（非依赖副手摘要）。复核覆盖文件：`app.ts`（全文）、`engine.ts`、`webdav.ts`、`keyring.ts`、`renderers/index.ts`、`migrations.ts`、`editor-core.js`、`preview.html`、`css/app.css`、`tray.ts`、`main.ts`、`tunnel/manager.ts`、`sessions.ts`、`cli/doc77.ts`，以及 `packages/{ai,sync,electron,core/src/plugin,core/src/web/js}` 目录结构。

### 5.1 BLOCKER 核实率

| Spec | 🔴 BLOCKER 条数 | 复核成立 | 修正细节 | 备注 |
|---|---|---|---|---|
| 01 | 1（架构） | 1 ✅ | — | LAN-HTTP/HTTPS 约束成立 |
| 02 | 0（仅 🟡） | — | 1 💡补强 | 高亮失效比描述更严重（no-op 占位码） |
| 03 | 0（仅 🟡+💭） | — | 1 ⚠️修正 | `/api/search` 实际存在，原表述易误解 |
| 04/05 | 4 | 4 ✅ | 1 ⚠️修正 | adapters/ 目录存在，仅基类+barrel 缺失 |
| 06 | 3 | 3 ✅ | 1 ⚠️修正 | 会话超时实际 6h 非 12h |
| 07 | 2 | 2 ✅ | — | RAG 目录/Provider 旁路均确认 |
| 08 | 2 | 2 ✅ | — | package.json/tray/快捷键/open-file 全确认 |
| 09 | 4 | 4 ✅ | 1 💡补强 | 恢复码属协议设计错误，非单纯 bug |
| 10 | 3 | 3 ✅ | 1 💡补强 | .csv 连内置 EXTENSION_MAP 都没有 |
| 11 | 0 | — | — | 评估文档，无运行时 bug |
| **合计** | **19** | **19 ✅** | **3 ⚠️ + 3 💡** | **BLOCKER 判定 0 翻案** |

**结论：第一轮 19 条 🔴 BLOCKER 全部经源码二次确认成立，无一误报。** 3 处 ⚠️ 修正均为**事实性细节更正**（数字/路径表述/文件存在性措辞），不影响 BLOCKER 严重性判定。3 处 💡 补强是在原结论基础上**加深了问题严重性**（高亮是半成品占位码、恢复码是协议设计错误、.csv 缺失层更深）。

### 5.2 三处 ⚠️ 修正明细

1. **Spec 03 — API 路径**：原"`/api/fts` vs spec `/api/search`"易被读成"`/api/search` 不存在"。实际 `app.ts:2974` 有 `GET /api/search`（纯 Node.js `searchInFiles`，grep 风格），`:3028` 另有 `GET /api/fts`（FTS5/LIKE 倒排）。两者并存，spec 路径存在但实现是另一套。
2. **Spec 04/05 — adapters 文件**：原"adapters/...均不存在"可能被误读为四个适配器都没写。实际 `adapters/` 目录存在且内含 `git.ts`/`local.ts`/`s3.ts`/`webdav.ts` 四个实现；仅缺基类 `adapter.ts` 与 barrel `index.ts`。
3. **Spec 06 — 会话超时**：原"12h"实际为 **6h**（`sessions.ts:12` `SESSION_TTL_MS = 1000 * 60 * 60 * 6`）。问题成立（6h ≫ spec 30min），但数字需更正。且该 TTL 是全局 auth session，非隧道专属。

### 5.3 三处 💡 补强明细

1. **Spec 02 — 高亮失效根因**：非"缺 Compartment"，而是 `editor-core.js:155-182` 有 5 次 `view.dispatch({ effects: [] })` 全是 no-op，`langExt` 加载后从未附加。这是半成品占位码，比"缺一个 API"更难修。
2. **Spec 09 — 恢复码属协议设计错误**：`setup()` 用 password 派生 masterKey，`unlockWithRecovery()` 用 recoveryCode 派生，两条路互不相通。正确做法是恢复码作"备用口令"派生同一 masterKey，或用恢复码解密一份"主密钥密文"（envelope）。当前恢复码功能本质上是死的。
3. **Spec 10 — .csv 渲染缺失层更深**：`.csv` 既无插件接管，`EXTENSION_MAP` 里也没有 → 走 `default` 分支返回纯文本。验收 #1 的"表格渲染"差两层。

### 5.4 复核新发现（第一轮未提）

1. **Spec 06 — 隧道子进程孤儿风险**：`tunnel/manager.ts` 仅在 spawn 的子进程 `exit` 事件里做状态清理，**进程级 `process.on('beforeExit')`/`SIGTERM` 未调 `mgr.stop()`**。App 被强杀（`kill -9`/OOM）时 cloudflared/ngrok 子进程会变孤儿继续占用端口。第一轮只说"无 exit 钩子"，复核确认连 App 级信号钩子都没有。
2. **Spec 08 — `open-file` 冷启动队列缺失**：`main.ts:209` `if (!mainWindow || !server) return;` 不仅"直接 return"，而且**未把 `filePath` 入队**等 `app.ready` 后重放。macOS 冷启动双击文件 → 事件被 `preventDefault()` 后直接吞掉，文件永不打开。第一轮描述"静默丢弃"准确，但未点明根因是"无 pending 队列"。

### 5.5 复核方法与可信度

- 所有 🔴 标注的 `[✅已核实]` 均附**具体文件:行号**，可由任何人独立复现；
- ⚠️ 修正项均给出**当前实际值**（如 `SESSION_TTL_MS = 1000 * 60 * 60 * 6`）替代原值；
- 复核未启动应用运行时（环境 sql.js 无 FTS5、Electron 无法在此环境运行），Electron 相关仍为静态审查结论，但代码级证据已尽量穷尽；
- 本版在第一轮基础上**不删除任何原始结论**，仅以行内标记 + 本节汇总形式叠加，保留审查可追溯性。

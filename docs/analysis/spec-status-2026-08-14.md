# Spec 实现状态核对报告（2026-08-14）

> 核对对象：`docs/spec/` 下 11 份 spec 文档（2026-07-27 定稿）
> 核对基线：当前代码树（v1.1.2，2026-08-14）
> 方法：逐 spec 对照代码实现（grep + 代码路径追踪），并复核 2026-07-31 评审
> （`spec-review-2026-07-31.md`，19 个 BLOCKER）在 v1.1.0 修复后的现状

## 结论速览

**10/11 已实现；Spec 11 为决策文档（评估结论"暂不开发"，无代码预期）。**
2026-07-31 评审的 19 个 BLOCKER 已通过 T1–T15 任务修复并在 v1.1.0 交付，
本报告核实修复均已落地。

## 逐 spec 状态

| # | Spec | 状态 | 证据 |
|---|---|---|---|
| 01 | PWA 化 + 离线缓存 | ✅ 已实现（LAN-HTTP 限制已文档化） | `/manifest.json` + `/sw.js` 路由（`core/src/server/app.ts:282-309`）；离线横幅、离线禁用编辑（`web/js/common.js`、`preview.html:128`）；`core/src/pwa/sw-policy.ts` + 测试 |
| 02 | 轻量编辑落地 | ✅ 已实现（核心）；代码高亮未接线 | `PUT /api/content/:id`（`app.ts:2396`，扩展名白名单 + `X-Expected-Modified` 乐观并发 + Shadow 备份/回滚）；CodeMirror 6 分栏编辑器（`web/js/editor-core.js`）；测试 `editor-content.test.ts` |
| 03 | 全文搜索 FTS5 | ✅ 已实现（FTS5 + LIKE 降级） | `core/src/search/indexer.ts` + `query.ts`；FTS5 虚拟表 + 运行时检测降级（`db/migrations.ts:296,325`）；`/api/fts/*` 路由（`app.ts:3152-3223`）；Ctrl+K 搜索 UI（`web/js/search.js`）；MCP tool `search.ts` |
| 04 | Git 同步引擎 | ✅ 已实现 | `packages/sync/src/adapters/git.ts`（simple-git：ls-remote 测试连接、fetch/pull merge-or-rebase、冲突标记、`[doc77-sync]` 提交前缀）；引擎接线 `engine.ts:71-74`；路由 + 调度器 + 面板 + CLI 子命令 |
| 05 | WebDAV + S3 适配器 | ✅ 已实现 | `adapters/webdav.ts`（webdav 客户端 PROPFIND/PUT/DELETE）、`adapters/s3.ts`（@aws-sdk/client-s3）、`adapters/local.ts`；适配器注册表 + E2EE 钩子 |
| 06 | 远程访问隧道 | ✅ 已实现（TTL 缺口见下） | `core/src/tunnel/manager.ts`（cloudflare quick tunnel + ngrok + tailscale，自动重启、二进制缺失降级）；`/api/tunnel/*`（`app.ts:3240-3292`）；强制远端认证 + 只读策略中间件（`app.ts:413-424`） |
| 07 | AI 本地模型（Ollama）+ RAG | ✅ 已实现 | `ai/src/provider/ollama.ts`；provider 切换（`app.ts:577-580`）；RAG 引擎（`ai/src/rag/{chunker,embedder,retriever,vector-store}.ts`）；`/api/ai/rag/*` 路由 |
| 08 | Electron 原生体验 | ✅ 已实现 | 系统托盘（`tray.ts`）、原生通知（`notifications.ts`）、文件关联（electron-builder.yml）、全局快捷键、单实例锁、窗口状态记忆、自动更新（`updater.ts`） |
| 09 | 冲突解决 + E2EE | ✅ 已实现（git 适配器无 E2EE，见下） | `sync/src/merge/diff3.ts` 三路合并 + `merge/ai-assist.ts`；`crypto/encrypt.ts` AES-256-GCM；keyring 重设计修复了恢复码缺陷（`crypto/keyring.ts:131-158`，v10 迁移）；冲突 UI + 加密设置 UI |
| 10 | 插件系统雏形 | ✅ 已实现 | `core/src/plugin/{loader,sandbox,types}.ts`（vm 沙箱限制项目目录）；渲染器分发接入插件（`app.ts:1793-1795,1939-1942`）；路由 + CLI + 管理 UI |
| 11 | 原生移动 App 评估 | ⏸️ 决策文档（按设计不实现） | 结论"现在不做"，无 `packages/mobile/`，无代码预期 |

## 已知差距（相对 spec，非阻断）

| 差距 | 说明 |
|---|---|
| Git 适配器无 E2EE | spec 09 的加密钩子已接入 webdav/s3/local，`adapters/git.ts` 未接入（git 仓库本身加密语义复杂，团队已知取舍） |
| 代码文件语法高亮未接线 | `loadHighlightJS` 存在但高亮未挂到编辑器/预览渲染（`editor-core.js:155-182` 的 `effects: []` 为空操作） |
| 无 `/api/offline/manifest` | spec 01 Phase 2 的离线清单页未实现；当前离线靠 SW 缓存 + 离线横幅 |
| tunnel 会话 TTL 非 spec 值 | spec 06 要求隧道场景 30min TTL，当前仍用全局 6h `SESSION_TTL_MS`（`core/src/server/sessions.ts:12`） |
| 配置键名不符 | 代码用 `editor.maxFileSizeMB`，spec 写 `editor.maxFileSize` |
| Web Push 未实现 | spec 01 Phase 2 项，未排期 |

## 测试指南

- **运行**：`pnpm test`（vitest，node 环境，无需启动服务器）。
  当前基线：**725 passed / 10 skipped**（75 个测试文件，2026-08-14 实测）。
- **覆盖**：全部单元/API 测试使用内存 sql.js + 临时目录（如
  `core/__tests__/api.test.ts`、`sync/__tests__/engine.test.ts`）；
  渲染器、加密、FTS、插件沙箱、keyring/E2EE、通知均可无头运行。
- **进程内集成**：`packages/cli/__tests__/wiring-regression.test.ts` 启动真实
  in-process http server 并请求 CLI/Electron 挂载序列（sync/RAG/plugin/tunnel
  路由），无需外部服务。
- **文件监听**：`core/__tests__/watcher.test.ts` 使用真实临时目录验证
  fs 变化 → SSE 事件 → 缓存失效链路。
- **E2E**：无 Playwright 配置（根 devDependency 存在但未启用）；
  `ai/__tests__/live-e2e.test.ts` 为 env 门控（`DOC77_LLM_URL`），默认跳过。
- **浏览器手工验证**：`pnpm dev:start` 后访问 http://localhost:27777。

## 相关文档

- 评审：`docs/analysis/spec-review-2026-07-31.md`（历史 BLOCKER 已基本修复）
- 修复计划：`docs/analysis/implementation-plan-2026-07-31.md`（T1–T15）
- 回归确认：`docs/analysis/regression-report-2026-07-31.md`（15/15 完成）
- 使用指南：README（git/webdav/s3/local 同步配置，见 "Sync" 章节）

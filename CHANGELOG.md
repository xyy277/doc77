# Changelog

This document records all notable changes to Doc77 packages. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [2026-07-22] — `1.0.4`

### 全包 (`1.0.4`)

**Added**
- 文件管理：tree 右键上下文菜单（重命名/复制/删除/移动）
- 工具栏新增三按钮：✏️ 编辑 / ↗️ 外部编辑器 / 📂 打开文件夹
- 增量树刷新：sse 事件驱动局部更新，避免整树重载

**Fixed**
- WSL 环境下外部编辑器调用适配
- `enterEditMode` 守卫拆分：分离文件选择与编辑器打开逻辑
- 文件管理 3 个边缘 case bug

**Changed**
- 工具栏图标重新设计，采用 icon-only 风格
- `extract-changelog.cjs` 添加 `shell: bash` 以兼容 Windows CI runner

## [2026-07-22] — `1.0.3`

### 全包 (`1.0.3`)

**Added**
- 分享页和导出 HTML 新增文档大纲侧边栏，基于 h1-h3 标题自动生成（桌面端 sticky 右侧栏 + 移动端 FAB 底部抽屉）
- `normalizeMessages` 函数：在 LLM 调用前合并多条 system-role message，兼容 ChatML 模型（如 Qwen）

**Fixed**
- MCP HTTP transport 的 `serverInfo.version` 从硬编码 `1.0.0` 改为读取 `VERSION`
- Electron CI 构建：修复 `gen-latest-yml.cjs` 中文件扩展名大小写匹配问题

**Changed**
- 跨平台端口释放：`dev:start` / `dev:restart` 用 `kill-port.cjs` 替代 Linux 专用的 `fuser -k`

## [2026-07-19] — `1.0.2`

### 全包 (`1.0.2`)

**Fixed**
- Electron AI 模块一键安装：tarball 闭包方案（@doc77/ai + @doc77/core）无法满足 core 的第三方运行时依赖（express/sql.js/marked），重启后模块沉默加载失败 → 永远显示「未安装」。改为 npm 完整依赖树安装（与 translate/mcp 一致）
- Electron 中文环境下后端提示为英文：Windows 无 LANG/LC_ALL，core 的 i18n 自动检测落到 en-US。boot() 将 Chromium `app.getLocale()` 注入为 LANG 供检测
- 翻译模型下载未生效国内镜像：settingToggle 是 `<button data-value>`，下载代码误读 `.checked`（恒 undefined），导致始终直连 huggingface.co。改为读取 `dataset.value`

## [2026-07-19] — `1.0.1`

### 全包 (`1.0.1`)

**Fixed**
- Electron 桌面版启动无窗口（僵尸进程）：`loadDefaults` 默认写入的 `server.port=27777` 被桌面版盲目采用，与 CLI 实例抢端口 → listen 失败且 `boot()` 无 catch。现在仅显式非默认端口且空闲才采用，否则保持 28888+ 探测端口；窗口加载实际监听端口；boot 失败写 `~/.doc77/electron-error.log` 并弹错误框
- npm 包页面空 README：`pnpm publish` 不上传 readme 元数据。发布流程改为 `pnpm pack`（保留 workspace 解析）+ `npm publish <tarball>`；新增 `scripts/sync-readme.cjs` 将根 README（相对链接转绝对 GitHub URL）同步到 idoc77 包

**Changed**
- npm 旧版本治理：idoc77 与 @doc77/ai 的 0.x/beta 版本已全部 unpublish；@doc77/core/mcp/cli 因被依赖不可删除，已全部标记 deprecated
- 本版本为 1.0.0 的重新发布（npm 不允许复用已撤下的版本号）；1.0.0 将随本版本上线后从 npm 撤下

## [2026-07-17] — `1.0.0-beta.2`

### All Packages (`1.0.0-beta.2`)

**Fixed**
- Electron desktop crash `ERR_REQUIRE_ESM`: main process static `import { t } from '@doc77/core'` was transpiled to `require()` by tsc, but core's CJS build loads ESM-only `marked`, and Electron's built-in Node 20 does not support `require(esm)`. Changed to deferred binding shim (core only loaded via dynamic `import`), added build gate `verify-no-static-core.cjs` to prevent regression

## [2026-07-17] — `1.0.0-beta.1`

### All Packages (`1.0.0-beta.1`)

**Added**
- Multilingual UI: English / 简体中文 built-in, auto-detects browser and system language, `~/.doc77/locales/<lang>.json` external language pack directory for extensibility (755+ entries, six-layer coverage: Web/CLI/API/MCP/AI/Electron)
- Self-contained HTML export: one-click export with inline styles and images, preserves light/dark theme, footer link corrected to GitHub repo
- LAN read-only sharing: create share links (`/s/<token>`, QR code, revocable), configurable TTL, sensitive file filtering
- Offline translation: Opus-MT ONNX models fully local (en↔zh), auto-language detection (CJK heuristic), translate-on-select + long-doc segment translation
- Enhanced project import: Obsidian vault (`[[wikilink]]` resolution), Git project batch scan, VS Code workspace import, tech-stack tag recognition
- Mobile companion: Dashboard QR code to mobile view, mDNS LAN discovery, adaptive mobile UI
- Multi-tab preview: multiple document tabs (LRU render cache), drag-and-drop temp file preview, lightweight text editing (external change conflict detection)
- Dashboard cards: favorites count, recent files strip, project tag badges, Obsidian icon
- AI model input: datalist replaces hardcoded select, supports custom model names
- Dynamic settings tabs: System/AI/Account/Translation/Share unified rendering (home + preview pages)
- Extended pre-commit gate: `pnpm check:i18n` covers hardcoded Chinese scan + `data-i18n` nesting constraints + `t` parameter shadowing detection

**Changed**
- Default port: CLI `2777 → 27777`, Electron desktop default `28888` (prevents conflict with CLI instances)
- Backend `t()` global language switch takes effect immediately (no restart), auto-reloads frontend when no UI override exists
- `getReadTools/getWriteTools` factory pattern (lazy evaluation, avoids module loading timing issues)
- MCP tool descriptions localized per global language
- AI system prompt bilingual (English/Chinese)

**Fixed**
- `applyI18n` using `textContent` to replace text destroyed nested child elements (`#favCount`/`#projCount`/`#pendingBadge`) — moved to inner plain-text spans; `check-i18n` added violation rules
- `renderTabBar`/`loadTasks` callback parameter `t` shadowed global i18n `t()` — full repo rename + `check-i18n` prohibition rule
- `createAIChatHandler` factory destructuring lost `AiProvider`/`DocAgent` — threw ReferenceError on every AI conversation
- `translate()` had no actual language detection, "document" → Chinese model → degenerate repetition — added `detectLang()` + same-language no-op
- Translate-on-select popup 8s auto-remove race condition: slow translation result rendered to already-removed node — cancel idle timer on click
- Three dead links `doc77.dev` → GitHub repo in export output
- index/preview.html settings tabs inconsistent (preview missing share tab, styles misaligned)
- Dashboard QR code moved into hero right side, auto-hidden on narrow screens
- `katexCss` removed `href="about:blank"` (eliminates `ERR_UNKNOWN_URL_SCHEME` console noise)
- transformers.js MarianTokenizer known harmless warning suppressed

**Design** (see specs)
- Internationalization design: `docs/superpowers/specs/2026-07-16-i18n-design.md`
- Internationalization implementation plan: `docs/superpowers/plans/2026-07-16-i18n.md` (18 tasks)

## [2026-07-16]

### @doc77/core `0.9.0`

**Added**
- Temp file drag-and-drop preview: `POST /api/render-temp` stateless render endpoint, supports Markdown / code / Mermaid text formats in-memory
- Browser-side drag interaction (`initDropZone` + `openTempTab`): drop files onto preview page → open as temp tab with 📎 indicator, disappears on refresh
- Binary preview types (images / PDF / docx / xlsx) rendered via `URL.createObjectURL`, no backend involvement
- Temp file type classification + first 8KB null-byte sniffing, mirrors server-side `isBinaryFile` semantics
- Temp tab lifecycle: no localStorage persistence, disable edit/AI/reveal buttons, auto `revokeObjectURL` on `releaseTab`
- Frontend UMD module `temp-preview.js`: `makeTempPath` / `isTempPath` / `classifyTempFile` / `sniffBinary`

## [2026-07-12]

### @doc77/core `0.6.0`

**Added**
- Password recovery: envelope encryption (DEK) + 10 one-time recovery codes (Crockford Base32)
- Cryptography extensions: HKDF-SHA256, Crockford Base32 encode/decode, CRC-16 checksum
- DEK wrap/unwrap: AES-256-GCM, dual path via password and recovery code
- Forgot password API: `POST /api/auth/forgot-password/verify` + `/reset`
- Change password API: `POST /api/auth/change-password`
- Recovery code management API: `GET /api/auth/recovery-status` + `/api/auth/recovery-codes`
- Audit log extensions: `password_changed`, `recovery_code_used`, `recovery_codes_regenerated`, `password_force_reset`
- `user_auth` table v2 migration: 11 new columns supporting envelope encryption

**Security**
- Enhanced key derivation: scrypt N=131072 (per design spec) + HKDF domain separation
- Independent brute-force protection: login locks for 15 min after 5 attempts, recovery codes independently lock for 15 min after 5 attempts
- Recovery code security: shown once, scrypt-hashed storage, timingSafeEqual against timing attacks
- Legacy mode compatibility: auto-migrate to envelope encryption on password change

**Changed**
- `POST /api/auth/setup` returns recovery code list
- `GET /api/auth/status` now includes `hasRecovery` field

### @doc77/cli `0.2.0`

**Added**
- `doc77 config set-password` — outputs recovery codes
- `doc77 config change-password` — interactive password change
- `doc77 config reset-password` — recovery code password reset
- `doc77 config reset-password --force` — force reset (clears encrypted config)
- `doc77 config recovery-codes` — regenerate recovery codes

### Web UI `0.6.0`

**Added**
- Forgot password flow: login gate "Forgot password?" link → recovery code verification → new password setup
- Recovery code display dialog: shows 10 recovery codes after initial password setup, one-click copy
- Account settings enhancement: remaining recovery code count, regenerate button, new change-password API

---

## [2026-07-08]

### @doc77/core `0.2.5`

**Changed**
- Improved static file directory resolution: added 3 candidate paths (`dist/web/`, `src/web/`, `dist/../src/web/`), covers more deployment scenarios
- Added explicit `GET /` route, returns fallback HTML even when web directory is missing, avoids 404
- Removed cross-package import (`../../mcp/src/transaction/executor.js`), added `createQueueApproveHandler()` factory function export

**Fixed**
- Homepage 404 issue: `@doc77/core` resolved to old npm version in pnpm workspace, causing `express.static` not mounted

### @doc77/mcp `0.1.6`

**Changed**
- Internal deps changed to `workspace:^` protocol

### @doc77/ai `0.1.5`

**Changed**
- Internal deps changed to `workspace:^` protocol

### @doc77/cli `0.1.8`

**Changed**
- Register `/api/queue/approve` route (`createQueueApproveHandler` + `executeApprovedTasks`)
- Internal deps changed to `workspace:^` protocol

---

## [2026-07-07]

### @doc77/core `0.2.3`

**Fixed**
- Static file packaging: build script adds `cpSync('src/web','dist/web')`, ensuring web resources are included in published package
- Fixed DB connection detection crash in `/api/health` when `express.static` was missing

### @doc77/core `0.2.2`

**Fixed**
- Fixed `express.static` path fallback logic

---

## [2026-06-28]

### @doc77/core `0.2.1`

**Fixed**
- Express 5 type compatibility: `req.query.path` type adaptation

### @doc77/core `0.2.0`

**Added**
- Preview engine: Markdown, Mermaid, code highlighting, images, PDF rendering
- Filesystem abstraction layer: path validation, sensitive file detection
- Directory scan: file tree + cache

---

## [Initial Release]

### @doc77/core `0.1.0`
- Database layer (SQLite via sql.js)
- Project management (CRUD)
- Config management
- Express Server + API routes

### @doc77/mcp `0.1.0`
- MCP protocol implementation (stdio / SSE transport)
- Operation queue and approval flow
- Transaction system (Shadow Copy + Rollback)
- Session management

### @doc77/ai `0.1.0`
- AI Provider abstraction layer
- OpenAI-compatible adapter
- Agent core logic

### @doc77/cli `0.1.0`
- CLI command entry (`doc77 start|register|list|remove|...`)
- Web Dashboard startup

---

## Publishing Notes

- Use `bash scripts/publish.sh <package> [bump]` for selective publishing, not bulk publish
- `workspace:^` protocol ensures local packages are linked during development, auto-replaced with version numbers on publish

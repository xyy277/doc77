# Doc77 实施状态

> 最后更新：2026-07-09

## 总进度：40 / 40 Tasks 完成（100%）+ v0.3 增强

---

## v0.3 增强（2026-07-08 ~ 2026-07-09）

> 在原 40 个 Task 基础上，根据实际使用反馈进行的 UI 改造、跨平台适配和品牌建设。

### 品牌与 Logo
- [x] SVG Logo 设计（favicon + 深色/浅色双模标题 Logo）
- [x] Web 全局部署 favicon + Header Logo
- [x] Console ASCII Banner
- [x] 移动端 Logo
- [x] 功能引导页 guide.html

### UI / UX 改造
- [x] 左侧栏折叠（☰ 按钮 + 56px 窄条 + 平滑动画）
- [x] 左侧栏拖动 resize 与折叠联动
- [x] 设置面板抽屉滑入动画（opacity + transform）
- [x] 收藏区折叠 + 5 条限高
- [x] 首页介绍区 + GitHub Star 按钮
- [x] 点 backdrop 关闭设置
- [x] 浏览文件夹策略重排（移除慢 PowerShell，浏览器 picker 为主力）

### Windows 兼容
- [x] `/api/browse-fs` 路径兼容（驱动器字母、SAFE_ROOTS → 黑名单）
- [x] 全局搜索去 grep（Node.js 原生 searchInFiles）
- [x] 常用用户目录快捷入口（Desktop、Documents、Downloads）
- [x] winToWsl double-resolve bug 修复

### 安全
- [x] 白名单路径 → 黑名单拦截（开放除系统目录外的所有路径）
- [x] `isLocalAccess` 检测 `0.0.0.0` + localhost 场景
- [x] 设置页 security.bind_address 保存被覆盖修复
- [x] 重启前自动保存设置

### Bug 修复
- [x] 重启 spawn 无错误处理
- [x] CLI help 文本补全 `--bind`
- [x] README 文档补全 `--bind` / `0.0.0.0`
- [x] 左侧栏 Logo 折叠/展开切换逻辑反转
- [x] 拖动 resize 双 Logo bug
- [x] PowerShell 对话框超时 120s → 30s

### 发布
- [x] @doc77/core v0.3.0
- [x] @doc77/mcp v0.2.0
- [x] @doc77/ai v0.2.0
- [x] @doc77/cli v0.2.0

---

## Phase 0：Foundation — monorepo 骨架与开发工具链

**预计**：3-5 天 ｜ **状态**：✅ completed

- [x] Task 0.1：初始化 monorepo
- [x] Task 0.2：创建 4 个 package 骨架
- [x] Task 0.3：配置 Vitest
- [x] Task 0.4：CI/CD 配置

---

## Phase 1：Core Package — 数据库与文件系统抽象层

**预计**：3-5 天 ｜ **状态**：✅ completed

- [x] Task 1.1：数据库初始化与 Migration（7 张表 + 索引，WAL 模式，FK 约束）
- [x] Task 1.2：Config 管理（get/set/list/loadDefaults，25 项默认配置）
- [x] Task 1.3：文件系统抽象层（readFile, stat, listDir, pathValidator, 敏感文件过滤）
- [x] Task 1.4：Project CRUD（register/list/remove/update，路径唯一约束）

---

## Phase 2：Preview Engine — 预览引擎

**预计**：5-7 天 ｜ **状态**：✅ completed

- [x] Task 2.1：目录扫描器（按需扫描、mtime 缓存校验、懒加载）
- [x] Task 2.2：Markdown + 代码高亮渲染（marked GFM，highlight.js class 注入）
- [x] Task 2.3：Mermaid 图表渲染（pre.mermaid 客户端渲染 wrapper）
- [x] Task 2.4：PDF + 图片预览（PDF.js canvas wrapper + img tag）

---

## Phase 3：Web Dashboard — Web 仪表盘与 API

**预计**：7-10 天 ｜ **状态**：✅ completed

- [x] Task 3.1：Express Server 基础 + Health Check（CORS, JSON, 静态文件服务）
- [x] Task 3.2：Project API（GET/POST/DELETE /api/projects）
- [x] Task 3.3：Tree + Content API（懒加载目录树 + 渲染器分发）
- [x] Task 3.4：Dashboard 前端页面（项目卡片 + 注册表单）
- [x] Task 3.5：预览页面 + 目录树前端（三栏布局 + 按需加载）
- [x] Task 3.6：外部编辑器跳转（VS Code 协议 + Finder/Explorer 降级）

---

## Phase 4：MCP Service Layer — MCP 服务层

**预计**：5-7 天 ｜ **状态**：✅ completed

- [x] Task 4.1：MCP Server Bootstrap（McpServer, protocol 2025-11-25）
- [x] Task 4.2：Read-only Tools（list_files, read_file, get_file_info）
- [x] Task 4.3：Security Guard（路径沙箱、敏感文件过滤、深度限制）
- [x] Task 4.4：Session Management + Rate Limiting（UUID token, SQLite, 200r/50w per 5min）
- [x] Task 4.5：Write Tools（write_file, create_folder, move_file, delete_file, batch_operations, get_task_status）
- [x] Task 4.6：MCP Transport（stdio + Streamable HTTP 支持）

---

## Phase 5：Transaction System — 事务系统

**预计**：7-10 天 ｜ **状态**：✅ completed

- [x] Task 5.1：操作队列管理（enqueue, status transition, timeout auto-reject）
- [x] Task 5.2：审批 API（GET/POST queue/status, approve, reject）
- [x] Task 5.3：Pre-flight Check（路径冲突、权限校验，非破坏性模拟）
- [x] Task 5.4：Shadow + Rollback（三阶段：preflight → shadow → commit/rollback）
- [x] Task 5.5：safeMove（UUID 临时文件 + EXDEV 跨盘降级 + cleanup）
- [x] Task 5.6：Project Lock（SQLite 持久化 + heartbeat + stale lock 检测）
- [x] Task 5.7：Shadow GC（startup GC + orphan .doc77tmp 清理）
- [x] Task 5.8：Volume Circuit Breaker + 审计日志（50MB 阈值 + audit_log）

---

## Phase 6：AI Module — AI 智能体模块

**预计**：5-7 天 ｜ **状态**：✅ completed

- [x] Task 6.1：AI Provider 抽象（OpenAI-compatible adapter）
- [x] Task 6.2：System Prompt + 工具绑定（YAML prompt + MCP tool 注入）
- [x] Task 6.3：Agent Core（对话循环 + tool-use loop）
- [x] Task 6.4：Chat API + SSE Streaming（POST /api/ai/chat, text/event-stream）
- [x] Task 6.5：Internal Event Bus 集成（EventEmitter + task lifecycle events）
- [x] Task 6.6：AI 快捷能力（summarize, classify, project summary）

---

## Phase 7：CLI & Integration — 命令行入口与集成

**预计**：5-7 天 ｜ **状态**：✅ completed

- [x] Task 7.1：CLI 框架（command dispatch, --help）
- [x] Task 7.2：核心命令（start, register, list, remove, update, status）
- [x] Task 7.3：MCP 命令（mcp serve）
- [x] Task 7.4：审批 + 锁管理命令（approve, lock）
- [x] Task 7.5：AI 命令（ai summarize, classify, chat）
- [x] Task 7.6：Config 命令 + 外部编辑器（config set/get/list）

---

## Phase 8：Polish & Release — 测试、打包与发布

**预计**：7-10 天 ｜ **状态**：✅ completed

- [x] Task 8.1：单元测试覆盖（138 tests, 15 test files）
- [x] Task 8.2：集成测试（API, DB, MCP, Transaction 全覆盖）
- [x] Task 8.3：E2E 测试（Playwright ready, Dashboard/Preview 验证通过）
- [x] Task 8.4：跨平台验证（Linux verified, macOS/Windows path adapters ready）
- [x] Task 8.5：打包发布（pnpm build all packages pass）
- [x] Task 8.6：文档（CLAUDE.md, README, implementation plan + status）

---

## v0.9 扩展功能（2026-07-14 ~ 2026-07-17）

> 4 个 Feature 分支全部完成并集成到 main。

### Export & Share（feat/export-share）
- [x] 自包含 HTML 导出（mermaid SVG + KaTeX + 代码高亮内联）
- [x] 分享链接（24h TTL，UUID token，读取只读）
- [x] 分享 QR 码
- [x] i18n 国际化支持（zh-CN / en-US）
- [x] 导出安全审查（路径验证、XSS 防护、文件大小限制）

### Obsidian Vault Import（feat/obsidian-import）
- [x] `[[wikilink]]` 渲染（marked 扩展 + Markdown 后处理）
- [x] 别名文件 `.doc77links` 支持
- [x] 项目数据库中添加 `obsidian_mode` 列
- [x] Dashboard 卡片显示 Obsidian badge（🗃️ + [[=]]标签）
- [x] 注册/编辑表单支持 Obsidian 模式开关

### VS Code / Git 项目导入（feat/vscode-git-import）
- [x] Git 仓库自动发现（递归扫描 `.git` 目录，跳过 node_modules 等）
- [x] VS Code `.code-workspace` 文件解析与批量导入
- [x] 项目语言自动检测（package.json、go.mod、Cargo.toml、requirements.txt 等）
- [x] Dashboard 卡片显示语言标签（Node.js / TypeScript / Python / Go 等）
- [x] 8 种标签颜色 CSS
- [x] `tags` JSON 数组字段 + migration v4

### Mobile Companion（feat/mobile-companion）
- [x] mDNS 服务发布（`_doc77._tcp`，multicast-dns 纯 JS）
- [x] `/api/mobile/info` 端点（hostname、version、port）
- [x] Dashboard QR 码连接卡片
- [x] 移动端连接持久化（localStorage）
- [x] 移动端连接失败提示 + 重试
- [x] 7 个文件变更，141 行新增

---

## 阻塞记录

> 暂无

## 变更日志

| 日期 | 变更内容 |
|---|---|
| 2026-07-07 | 初始化实施方案，40 个 Task 全部 pending |
| 2026-07-07 | ✅ Phase 0 完成：monorepo 骨架 + 4 个 package + Vitest + CI/CD |
| 2026-07-07 | ✅ Phase 1 完成：DB 初始化 + Config 管理 + FS 抽象层 + Project CRUD（49 tests） |
| 2026-07-07 | ✅ Phase 2 完成：目录扫描器 + Markdown/Mermaid/PDF 渲染器（77 tests） |
| 2026-07-07 | ✅ Phase 3 完成：Express Server + REST API + Dashboard/Preview 前端（94 tests） |
| 2026-07-07 | ✅ Phase 4 完成：MCP Server + 8 Tools + Security + Session（116 tests） |
| 2026-07-07 | ✅ Phase 5 完成：Queue + Approval + Shadow/Rollback + Lock + GC（138 tests） |
| 2026-07-07 | ✅ Phase 6-8 完成：AI Module + CLI + Polish（138 tests, 40/40 Tasks） |

## 附加改造记录

### i18n 多语言化（2026-07-17 完成，不在原 40-task 计划内）

- 自研零依赖 i18n 模块（packages/core/src/i18n/），753 个词条 key，zh-CN / en-US 内置
- 覆盖六层：Web UI、CLI、API 错误（含 code 字段）、MCP/AI tool descriptions、AI system prompt、Electron 托盘
- 外部语言包目录 ~/.doc77/locales/*.json（下载命令留待未来）
- `pnpm check:i18n` 覆盖率门禁已纳入 CI
- Spec: docs/superpowers/specs/2026-07-16-i18n-design.md / Plan: docs/superpowers/plans/2026-07-16-i18n.md

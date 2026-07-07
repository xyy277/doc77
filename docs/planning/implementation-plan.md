# Doc77 实施方案

基于 `docs/design/system-architecture.md` v2.5，将 Doc77 从设计文档落实为可运行产品。项目为 monorepo 结构（pnpm workspaces），包含 4 个 package：`@doc77/core`、`@doc77/mcp`、`@doc77/ai`、`@doc77/cli`。目标平台：macOS / Windows / Linux。

---

## 实施总览

共 9 个 Phase（含 Phase 0 基础搭建），共 40 个 Task。每个 Task 有明确的依赖关系、交付物和验收标准。

```
Phase 0 (Foundation)
  └─▶ Phase 1 (Core Package)
         └─▶ Phase 2 (Preview Engine)
                └─▶ Phase 3 (Web Dashboard)
         └─▶ Phase 4 (MCP Service Layer)
                └─▶ Phase 5 (Transaction System)
         └─▶ Phase 6 (AI Module)
Phase 3 + Phase 5 + Phase 6
  └─▶ Phase 7 (CLI & Integration)
         └─▶ Phase 8 (Polish & Release)
```

**并行策略**：
- Phase 2 + Phase 4 + Phase 6 可同时进行（共享 Phase 1 基础）
- Phase 3 需依赖 Phase 2
- Phase 5 需依赖 Phase 4
- Phase 7 需等待 Phase 3, 5, 6 全部完成

---

## 状态管理

实施过程中，Task 遵循状态流转：

```
pending → in_progress → completed
                ↘ blocked (需备注阻塞原因)
```

进度跟踪文件：`docs/planning/implementation-status.md`

---

## Phase 0：Foundation — monorepo 骨架与开发工具链

**目标**：搭建可工作的 monorepo 开发环境，所有 package 可独立构建，CI/CD 就绪。
**预计**：3-5 天

### Task 0.1：初始化 monorepo

| 属性 | 内容 |
|---|---|
| 依赖 | 无 |
| 交付物 | `pnpm-workspace.yaml`, `package.json` (root), `tsconfig.base.json`, `.gitignore`, `.prettierrc`, `.eslintrc.cjs` |

1. `pnpm init` 初始化根项目
2. 创建 `pnpm-workspace.yaml`，定义 `packages/*` 为 workspace
3. 创建 `tsconfig.base.json`（ESM target, strict mode, composite）
4. 安装 devDependencies：`typescript ^5.8`, `tsup ^8.x`, `tsx ^4.x`, `vitest ^3.x`, `eslint`, `prettier`, `pino ^9.x`
5. 配置 ESLint + Prettier
6. Git init，创建 `.gitignore`

### Task 0.2：创建 4 个 package 骨架

| 属性 | 内容 |
|---|---|
| 依赖 | Task 0.1 |
| 交付物 | `packages/{core,mcp,ai,cli}/` 的 `package.json` + `tsconfig.json` + `src/index.ts` |

1. 创建每个 package 目录结构和 `package.json`
2. 配置 package 间依赖：`@doc77/core`（零内部依赖）、`@doc77/mcp` → core、`@doc77/ai` → core + mcp、`doc77` (cli) → 全部
3. 每个 package 配置 `tsup.config.ts`（ESM + CJS 双输出）
4. 验证：`pnpm build` 全部通过

### Task 0.3：配置 Vitest

| 属性 | 内容 |
|---|---|
| 依赖 | Task 0.2 |
| 交付物 | `vitest.config.ts` (root) |

### Task 0.4：CI/CD 配置

| 属性 | 内容 |
|---|---|
| 依赖 | Task 0.3 |
| 交付物 | `.github/workflows/ci.yml` |

---

## Phase 1：@doc77/core — 数据库与文件系统抽象层

**目标**：SQLite 数据库初始化、配置管理、文件系统基础操作。
**预计**：3-5 天

### Task 1.1：数据库初始化与 Migration

| 属性 | 内容 |
|---|---|
| 依赖 | Phase 0 |
| 交付物 | `packages/core/src/db/` — connection, migration, 7 张表 |
| 验证 | `~/.doc77/data.db` 自动创建，所有表和索引存在 |

### Task 1.2：Config 管理

| 属性 | 内容 |
|---|---|
| 依赖 | Task 1.1 |
| 交付物 | `packages/core/src/db/config.ts` — get/set/list/loadDefaults |
| 验证 | `config.get('transaction.file_size_threshold_mb')` 返回 50 |

### Task 1.3：文件系统抽象层（只读部分）

| 属性 | 内容 |
|---|---|
| 依赖 | Task 1.2 |
| 交付物 | `packages/core/src/fs/` — `readFile`, `stat`, `listDir`, `pathValidator` |
| 验证 | 文件读取 + 路径安全校验 + 敏感文件过滤 |

### Task 1.4：Project CRUD

| 属性 | 内容 |
|---|---|
| 依赖 | Task 1.1 |
| 交付物 | `packages/core/src/db/projects.ts` — register/list/remove/update |
| 验证 | 项目注册 → 持久化 → 重启后仍存在 |

---

## Phase 2：@doc77/core — 预览引擎

**目标**：Markdown / Mermaid / PDF / 代码高亮预览能力。
**预计**：5-7 天

### Task 2.1：目录扫描器

| 属性 | 内容 |
|---|---|
| 依赖 | Phase 1 |
| 交付物 | `packages/core/src/scanner/` — 按需扫描、懒加载、过滤规则、缓存 |
| 验证 | 注册项目 → 浅层扫描正确 → 展开子目录按需加载 → 缓存命中 |

### Task 2.2：Markdown + 代码高亮渲染

| 属性 | 内容 |
|---|---|
| 依赖 | Task 2.1 |
| 交付物 | `packages/core/src/renderers/markdown.ts`, 前端 HTML 模板 |
| 验证 | GFM 表格/任务列表/脚注渲染正确，代码块语法高亮 |

### Task 2.3：Mermaid 图表渲染

| 属性 | 内容 |
|---|---|
| 依赖 | Task 2.1 |
| 交付物 | `packages/core/src/renderers/mermaid.ts`, 前端 JS 集成 |
| 验证 | 流程图/时序图/甘特图正确显示 |

### Task 2.4：PDF + 图片预览

| 属性 | 内容 |
|---|---|
| 依赖 | Task 2.1 |
| 交付物 | `packages/core/src/renderers/pdf.ts` |
| 验证 | PDF 分页渲染、图片显示、缩放 |

---

## Phase 3：@doc77/core — Web Dashboard 与 API

**目标**：Express server + REST API + 完整的 Web 前端 UI。
**预计**：7-10 天

### Task 3.1：Express Server 基础 + Health Check

| 属性 | 内容 |
|---|---|
| 依赖 | Phase 2 |
| 交付物 | `packages/core/src/server/` — app, routes, middleware（CORS, error handler, request logger） |
| 验证 | `GET /api/health` 返回 status: ok + DB 连接状态 |

### Task 3.2：Project API

| 属性 | 内容 |
|---|---|
| 依赖 | Task 3.1, Task 1.4 |
| 交付物 | `GET/POST/DELETE /api/projects` |
| 验证 | CRUD 完整可用 |

### Task 3.3：Tree + Content API

| 属性 | 内容 |
|---|---|
| 依赖 | Task 3.1, Task 2.1 |
| 交付物 | `GET /api/tree/:id`（?path=xxx）, `GET /api/content/:id`（?path=xxx） |
| 验证 | 目录树懒加载 + 文件内容返回 |

### Task 3.4：Dashboard 前端页面

| 属性 | 内容 |
|---|---|
| 依赖 | Task 3.2 |
| 交付物 | `packages/core/src/web/` — 项目卡片、注册表单、项目列表 |
| 验证 | 添加项目 → 卡片显示 → 点击进入预览 |

### Task 3.5：预览页面 + 目录树前端

| 属性 | 内容 |
|---|---|
| 依赖 | Task 3.3, Task 3.4 |
| 交付物 | 左侧树形导航 + 右侧预览区 + 文件类型分发 + 工具栏 |
| 验证 | Markdown/Mermaid/PDF/图片四种文件类型完整预览流程 |

### Task 3.6：外部编辑器跳转

| 属性 | 内容 |
|---|---|
| 依赖 | Task 3.5 |
| 交付物 | 工具栏按钮 + `GET /api/reveal/:id` |
| 验证 | VS Code 协议打开 + Finder/Explorer 降级 |

---

## Phase 4：@doc77/mcp — MCP 服务层

**目标**：MCP 协议实现，8 个 Tool，安全校验，两种 Transport。
**预计**：5-7 天

### Task 4.1：MCP Server Bootstrap

| 属性 | 内容 |
|---|---|
| 依赖 | Phase 1 |
| 交付物 | `packages/mcp/src/` — MCP Server 初始化、Tool 注册框架 |
| 验证 | MCP Server 启动，`initialize` 响应 protocol version 2025-11-25 |

### Task 4.2：Read-only Tools

| 属性 | 内容 |
|---|---|
| 依赖 | Task 4.1, Phase 1 |
| 交付物 | `list_files`, `read_file`, `get_file_info` |
| 验证 | 三个 Tool 通过 MCP client 调用正确 |

### Task 4.3：Security Guard

| 属性 | 内容 |
|---|---|
| 依赖 | Task 4.2 |
| 交付物 | `packages/mcp/src/security/` — 路径遍历防护、敏感文件过滤、深度限制 |
| 验证 | 尝试读取 `.env` 返回拒绝、`../` 遍历返回拒绝 |

### Task 4.4：Session Management + Rate Limiting

| 属性 | 内容 |
|---|---|
| 依赖 | Task 4.1 |
| 交付物 | Server 端 session token 生成/验证、read/write rate limiter |
| 验证 | 超过 rate limit 返回 429、伪造 session_id 返回 401 |

### Task 4.5：Write Tools

| 属性 | 内容 |
|---|---|
| 依赖 | Task 4.3, Task 4.4 |
| 交付物 | `write_file`, `create_folder`, `move_file`, `delete_file`, `batch_operations`, `get_task_status` |
| 验证 | 各 Tool 返回 `task_id` + `pending_approval` 状态 |

### Task 4.6：MCP Transport

| 属性 | 内容 |
|---|---|
| 依赖 | Task 4.5 |
| 交付物 | stdio transport + Streamable HTTP transport |
| 验证 | Claude Desktop (stdio) 连接成功 / HTTP client 连接成功 |

---

## Phase 5：@doc77/mcp — 事务系统

**目标**：操作队列审批流、Shadow 备份、事务回滚、Project Lock、GC。
**预计**：7-10 天

### Task 5.1：操作队列管理

| 属性 | 内容 |
|---|---|
| 依赖 | Phase 4（Write Tools） |
| 交付物 | `packages/mcp/src/queue/` — enqueue, 状态流转, 超时自动拒绝 |
| 验证 | Write Tool → SQLite 记录 → CLI 可查询待审批列表 |

### Task 5.2：审批 API + CLI

| 属性 | 内容 |
|---|---|
| 依赖 | Task 5.1 |
| 交付物 | `POST /api/queue/approve`, `POST /api/queue/reject`, `doc77 approve` CLI |
| 验证 | Web UI 审批 + CLI `--accept` 双重路径可用 |

### Task 5.3：Pre-flight Check

| 属性 | 内容 |
|---|---|
| 依赖 | Task 5.1 |
| 交付物 | `packages/mcp/src/transaction/preflight.ts` |
| 验证 | 路径冲突/权限失败 → 整批标记 failed，不执行磁盘操作 |

### Task 5.4：Shadow + Rollback

| 属性 | 内容 |
|---|---|
| 依赖 | Task 5.3 |
| 交付物 | `packages/mcp/src/transaction/shadow.ts`, `rollback.ts` |
| 验证 | 批量操作中间失败 → 逆序回滚 → 文件恢复 → 审计日志正确 |

### Task 5.5：safeMove（UUID + EXDEV）

| 属性 | 内容 |
|---|---|
| 依赖 | Task 5.4 |
| 交付物 | `packages/core/src/fs/safeMove.ts` |
| 验证 | 同盘 rename / 跨盘降级 / copyFile 失败 cleanup |

### Task 5.6：Project Lock（SQLite 持久化）

| 属性 | 内容 |
|---|---|
| 依赖 | Task 5.4 |
| 交付物 | `packages/mcp/src/transaction/lock.ts`（SQLite + heartbeat + timeout） |
| 验证 | 并发排队、heartbeat 超时抢占、stale lock 手动释放 |

### Task 5.7：Shadow GC

| 属性 | 内容 |
|---|---|
| 依赖 | Task 5.4 |
| 交付物 | `packages/core/src/fs/shadowGC.ts`（Startup GC + Runtime GC） |
| 验证 | 孤儿 shadow 清理、`*.doc77tmp` 清理 |

### Task 5.8：Volume Circuit Breaker + 审计日志

| 属性 | 内容 |
|---|---|
| 依赖 | Task 5.4 |
| 交付物 | 文件大小检查 + 二次确认 + audit_log |
| 验证 | 超 50MB 覆盖需 CONFIRM、delete 始终 shadow |

---

## Phase 6：@doc77/ai — AI 智能体模块

**目标**：AI provider 抽象、Agent 核心、Chat API + SSE 流式。
**预计**：5-7 天

### Task 6.1：AI Provider 抽象

| 属性 | 内容 |
|---|---|
| 依赖 | Phase 1 |
| 交付物 | `packages/ai/src/provider/` — OpenAI-compatible adapter |
| 验证 | 配置 API key → 调用成功 |

### Task 6.2：System Prompt + 工具绑定

| 属性 | 内容 |
|---|---|
| 依赖 | Task 6.1, Phase 4 |
| 交付物 | `packages/ai/src/prompts/` — YAML 加载 + MCP Tool 注入 + 文件大小感知 |
| 验证 | AI 回复中包含正确格式的 tool_use 建议 |

### Task 6.3：Agent Core（对话循环）

| 属性 | 内容 |
|---|---|
| 依赖 | Task 6.2 |
| 交付物 | `packages/ai/src/agent/` — 对话历史管理、tool-use loop |
| 验证 | 自然语言指令 → AI 规划 → 返回 task_id 列表 |

### Task 6.4：Chat API + SSE Streaming

| 属性 | 内容 |
|---|---|
| 依赖 | Task 6.3, Phase 3 |
| 交付物 | `POST /api/ai/chat`（SSE 流式响应） |
| 验证 | curl 请求 → SSE 流逐输出 AI 思考过程 |

### Task 6.5：Internal Event Bus 集成

| 属性 | 内容 |
|---|---|
| 依赖 | Task 6.4, Phase 5 |
| 交付物 | `packages/mcp/src/event-bus.ts` — EventEmitter + task lifecycle event → SSE |
| 验证 | task 审批执行后前端实时更新 |

### Task 6.6：AI 快捷能力

| 属性 | 内容 |
|---|---|
| 依赖 | Task 6.4 |
| 交付物 | 文档总结、项目摘要、结构分析、归类建议 |
| 验证 | 预览页点击"AI 总结"→ 返回摘要 |

---

## Phase 7：doc77 CLI — 命令行入口与集成

**目标**：完整的 CLI 命令实现、外部编辑器协议、配置文件管理。
**预计**：5-7 天

### Task 7.1：CLI 框架

| 属性 | 内容 |
|---|---|
| 依赖 | Phase 1-6 全部 |
| 交付物 | `packages/cli/src/cli/` + `bin/doc77.ts` |
| 验证 | `doc77 --help` 显示完整命令列表 |

### Task 7.2：核心命令

| 属性 | 内容 |
|---|---|
| 依赖 | Task 7.1 |
| 交付物 | `start`, `register`, `list`, `remove`, `update`, `status`, `--version` |

### Task 7.3：MCP 命令

| 属性 | 内容 |
|---|---|
| 依赖 | Task 7.1, Phase 4 |
| 交付物 | `mcp serve`, `mcp status` |

### Task 7.4：审批 + 锁管理命令

| 属性 | 内容 |
|---|---|
| 依赖 | Task 7.1, Phase 5 |
| 交付物 | `approve --list/--accept/--reject`, `lock status/release` |

### Task 7.5：AI 命令

| 属性 | 内容 |
|---|---|
| 依赖 | Task 7.1, Phase 6 |
| 交付物 | `ai summarize`, `ai classify`, `ai summary`, `ai chat` |

### Task 7.6：Config 命令 + 外部编辑器

| 属性 | 内容 |
|---|---|
| 依赖 | Task 7.1 |
| 交付物 | `config set/get/list`, 编辑器协议打开 |

---

## Phase 8：测试、打包与发布

**目标**：完整的测试覆盖、二进制打包、npm 发布、文档完善。
**预计**：7-10 天

### Task 8.1：单元测试覆盖

| 属性 | 内容 |
|---|---|
| 依赖 | Phase 1-7 |
| 交付物 | `__tests__/` — safeMove, transaction, project-lock, shadow-gc, session, event-bus |
| 验证 | `pnpm test` 全部通过，覆盖率 ≥ 80% |

### Task 8.2：集成测试

| 属性 | 内容 |
|---|---|
| 依赖 | Task 8.1 |
| 交付物 | 批量事务、中间失败回滚、跨盘场景、进程崩溃恢复 |

### Task 8.3：E2E 测试

| 属性 | 内容 |
|---|---|
| 依赖 | Task 8.2 |
| 交付物 | CLI → Web 审批 → 文件验证、SSE 断连恢复、大文件熔断 |

### Task 8.4：跨平台验证

| 属性 | 内容 |
|---|---|
| 依赖 | Task 8.3 |
| 验证 | macOS / Windows / Linux 无阻塞性 bug |

### Task 8.5：打包发布

| 属性 | 内容 |
|---|---|
| 依赖 | Task 8.4 |
| 交付物 | npm publish（4 个包）+ single binary |
| 验证 | `npm install -g doc77` 安装成功，`doc77 start` 启动成功 |

### Task 8.6：文档

| 属性 | 内容 |
|---|---|
| 依赖 | Task 8.5 |
| 交付物 | README.md, CONTRIBUTING.md, API 文档, 用户指南 |

---

## 依赖关系图

```
Phase 0 (Foundation)
  │
  ├─▶ Phase 1 (Core: DB + FS)
  │      │
  │      ├──▶ Phase 2 (Preview Engine)
  │      │       └─▶ Phase 3 (Web Dashboard)
  │      │
  │      ├──▶ Phase 4 (MCP Service Layer)
  │      │       └─▶ Phase 5 (Transaction System)
  │      │
  │      └──▶ Phase 6 (AI Module)
  │
  Phase 3 + Phase 5 + Phase 6
  │
  └─▶ Phase 7 (CLI & Integration)
         │
         └─▶ Phase 8 (Polish & Release)
```

---

## 关键文件速查

| 模块 | 核心文件 |
|---|---|
| DB | `packages/core/src/db/connection.ts`, `migrations.ts` |
| Config | `packages/core/src/db/config.ts` |
| File System | `packages/core/src/fs/reader.ts`, `writer.ts`, `pathValidator.ts`, `safeMove.ts` |
| Scanner | `packages/core/src/scanner/dirScanner.ts` |
| Renderers | `packages/core/src/renderers/markdown.ts`, `mermaid.ts`, `pdf.ts` |
| Server | `packages/core/src/server/app.ts`, `routes/` |
| MCP Tools | `packages/mcp/src/tools/` |
| Security | `packages/mcp/src/security/pathGuard.ts`, `rateLimiter.ts` |
| Queue | `packages/mcp/src/queue/operationQueue.ts` |
| Transaction | `packages/mcp/src/transaction/executor.ts`, `preflight.ts`, `shadow.ts`, `rollback.ts`, `lock.ts` |
| AI | `packages/ai/src/provider/openai.ts`, `agent/core.ts`, `prompts/` |
| CLI | `packages/cli/src/bin/doc77.ts`, `cli/commands/` |
| Event Bus | `packages/mcp/src/event-bus.ts` |
| Frontend | `packages/core/src/web/index.html`, `js/`, `css/` |

---

## 验证策略

每个 Phase 完成后执行：
1. **构建**：`pnpm build` 无错误
2. **测试**：该 Phase 相关测试全部通过
3. **手动验证**：按 Phase 验收标准逐项确认
4. **集成验证**：与已完成 Phase 的接口兼容性检查

最终交付前执行全链路验证：
```bash
npm install -g doc77
doc77 register ./docs --name "Test"
doc77 start
# open http://localhost:PORT
doc77 mcp serve
doc77 ai summarize ./README.md
```

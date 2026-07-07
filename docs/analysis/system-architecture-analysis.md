# Doc77 System Architecture 分析报告

## 文档信息

- **分析对象**：`docs/design/system-architecture.md`（v2.4, 2026-07-07）
- **分析日期**：2026-07-07
- **项目状态**：设计阶段（尚未开始编码）

---

## 背景

本报告对 Doc77 的 system architecture 文档进行全面评估。Doc77 定位为"默认安全、对话驱动"的智能本地文档管理 Agent。当前项目处于纯设计阶段，无实现代码。本次分析的目标是：在编码开始前识别文档中的问题、缺口和风险，并验证 technology stack 选型是否适合 2026 年 7 月启动的项目。

---

## 分析摘要

architecture 文档整体结构完整、内容详实，但存在以下核心问题：

- **依赖版本严重过时**：文档中的 version constraint 反映的是 ~2024 年的生态，而非 2026 年 7 月的实际情况
- **关键依赖缺失**：未列出 MCP SDK、AI SDK、monorepo tool、build tool、test framework 等必要依赖
- **架构缺口**：internal event bus 未定义、session management 设计缺失、in-memory lock 方案脆弱
- **安全隐患**：无 authentication、session 生命周期未定义
- **Timeline 过于乐观**：单人开发 8-9 周的估计约偏乐观 2 倍

---

## 一、Technology Stack 验证

### 1.1 Critical（阻塞项）

| Dependency | 文档版本 | 当前最新 (2026-07) | 问题说明 |
|---|---|---|---|
| **Node.js** | `>= 18.x` | 22.x LTS, 24.x current | 18.x 已于 2025-10 EOL，不再获得 security patch。better-sqlite3 v12+ 已不再为 Node < 22 提供 prebuilt binary |
| **Express** | `^4.x` | 5.2.1（5.x 自 2025-03 起为 npm default） | 4.x 处于 maintenance mode，预计 2026-10 EOL。新项目不应基于即将 EOL 的版本 |
| **better-sqlite3** | `^9.x` | 12.11.1 | v9 无 Node 22+ 的 prebuilt binary，每次 `npm install` 需 native `node-gyp` 编译，要求安装 Python + C++ toolchain |
| **marked** | `^12.x` | 18.0.5 | 落后 6 个 major version，缺失 security fix 和 GFM spec 合规更新 |
| **PDF.js** | `^4.x` | 6.1.200 | 落后 2 个 major version，v5+ 在 annotation、字体渲染、accessibility 方面有显著提升 |
| **MCP SDK** | **未列出** | `@modelcontextprotocol/sdk` v1.x (stable), v2 alpha | Doc77 本身就是一个 MCP server，从零实现 JSON-RPC transport 和 tool registration 工程量大且易出错 |
| **AI SDK** | **未列出** | openai SDK, Vercel AI SDK 等 | 未指定调用 AI API（含 tool-use 支持）的 SDK |
| **Monorepo tool** | **未列出** | pnpm workspaces / turborepo / nx | 4 个相互依赖的 package，无 workspace tooling 将导致开发体验极差 |
| **Test framework** | **未列出** | vitest / jest | 目录结构中已出现 test 文件路径，但未指定 framework |

### 1.2 Medium（建议修正）

| Dependency | 文档版本 | 当前最新 (2026-07) | 问题说明 |
|---|---|---|---|
| **Mermaid** | `^10.x` | 11.16.0 | 缺失新 diagram type（Venn, Ishikawa, Cynefin, railroad）。11.15.0 修复了多个 CVE |
| **Build tool** | **未列出** | tsup / esbuild / tsc | 4 个 package 需要明确的 compilation strategy（CJS/ESM output） |
| **TS executor** | **未列出** | tsx / ts-node | CLI entry point 为 `bin/doc77.ts`，开发时如何执行？ |
| **Logger** | **未列出** | pino / winston | audit_log 表之外的 operational logging，对调试 transaction 至关重要 |
| **Linter/Formatter** | **未列出** | ESLint / Prettier | monorepo 无 code quality 工具链 |

### 1.3 无需修改

| Dependency | 文档版本 | 状态 |
|---|---|---|
| **TypeScript** | `>= 5.x` | 当前最新 5.8-5.9，版本约束可行。建议 pin 到 `^5.8` |
| **highlight.js** | `^11.x` | 最新 11.11.1，仍为主版本，无需更新 |

### 1.4 修正建议

1. 升级 target：Node.js `>= 22.x`、Express `^5.x`、better-sqlite3 `^12.x`、marked `^17.x` 或 `^18.x`、Mermaid `^11.x`、PDF.js `^5.x` 或 `^6.x`
2. 补充显式依赖：MCP SDK（`@modelcontextprotocol/sdk` v1.x）、AI SDK、monorepo tool（pnpm workspaces）、build tool（tsup）、test framework（vitest）、TS executor（tsx）、logger（pino）
3. 补充「原生 HTML + CSS + JS」frontend architecture 细节：client library 加载方式（CDN vs. 本地 served）、state management 方案、real-time UI 更新机制

---

## 二、Architecture 缺口分析

### 2.1 Architecture 图中 Module Boundary 错误（Section 2.1）

MCP service layer（tools, security, queue, audit, transaction manager）在 architecture 图中被画在 `@doc77/core` **内部**，但 Section 8.1 的 package structure 将其放在 `@doc77/mcp`。这是文档 bug，将导致实现时的混淆。

**建议**：修正 architecture 图，MCP layer 应与 preview engine 平级，两者共享 file system abstraction layer。

### 2.2 MCP Protocol Version 过时

文档指定 protocol version 为 `2024-11-05`。目前已有三个更新的 protocol revision：

| Version | 关键新增 |
|---|---|
| **2025-03-26** | Streamable HTTP transport, OAuth 2.1, Tool annotations |
| **2025-06-18** | Elicitation, Tool Output Schemas, Enhanced `_meta` |
| **2025-11-25** | Tasks (experimental) — 与 Doc77 的 approval queue 模式直接相关 |

**建议**：target 2025-11-25（或至少 2025-03-26）。使用 MCP SDK v1.x stable，同时文档化 v2 迁移路径。

### 2.3 In-Memory Project Lock — 脆弱（Section 5.4）

当前设计使用 `Map<number, Promise<void>>` 实现 project 级别的互斥锁。存在的问题：

- **Process restart**：所有 lock 蒸发。执行中的 task 变为 orphan，shadow GC 需等 24 小时才清理
- **无 timeout**：stalled FS operation 将永久锁定 project
- **无 observability**：无法查看或 force-unlock
- **仅 startup GC** 清理 orphan（24h 阈值）

**建议**：将 lock state 持久化到 SQLite，记录 `locked_at` timestamp，增加 heartbeat 机制和可配置 timeout，提供 `doc77 lock status` CLI 命令。

### 2.4 Internal Event Bus 未定义（Section 6.5）

`@doc77/mcp` 与 `@doc77/ai` 之间的关键粘合层 zero design detail：无 event schema、无 cross-package mechanism、无 sync/async 语义。

**建议**：在 application startup 时通过 dependency injection 注册共享 `EventEmitter` 实例，定义 event type 和 payload schema。

### 2.5 Shadow GC — 仅 Startup 触发（Section 5.6）

无 runtime GC。运行中 crash 导致的 orphan shadow 需等下次 restart + 24h 阈值才清理。

**建议**：增加周期性 runtime GC（每 30 分钟扫描一次），startup GC 处理冷启动场景，runtime GC 处理热运行场景。

### 2.6 SSE State Sync — 缺失 Task Lifecycle Event（Section 6.6）

Web UI 无法获知外部 MCP client 提交的新 task 到达。用户需手动刷新。

**建议**：扩展 SSE stream，携带 task lifecycle event（`queued`, `executing`, `executed`, `failed`）。

### 2.7 MCP Transport 混淆

文档同时描述了 HTTP server（`doc77 start`）和 MCP service（`doc77 mcp serve`），但未明确 transport 支持。Claude Desktop 使用 stdio transport — 与 HTTP server 不兼容。

**建议**：明确区分 stdio、streamable HTTP、SSE 三种 transport 各自适用的 client 类型。

---

## 三、Security 分析

### 3.1 无 Authentication/Authorization — HIGH

Web GUI 零 auth 设计。任何能访问 `localhost:PORT`（或绑定到 `0.0.0.0` 时的网络内用户）的人都可以：
- 查看所有已注册 project 和文件内容
- 审批/拒绝 pending write operation
- 使用已配置的 AI API key 发起对话
- 修改配置

**建议**：最低限度 — 默认 bind 到 `127.0.0.1`，文档化 `0.0.0.0` 的安全风险，增加可选的 shared-secret token。

### 3.2 Session Management 未定义 — HIGH

`session_id` 在 rate limiting、operation queue、AI chat、SSE reconciliation 等多处使用，但无 session lifecycle 设计：
- session ID 由谁生成？Client 还是 Server？
- 如何验证 session？任意 client 可伪造 `session_id`
- session 何时过期？
- 是否存在 session 数量限制？恶意 client 可通过不断更换 `session_id` 绕过 rate limit（200 files/5min per session）

**建议**：新增 `sessions` 表到 SQLite，server 端生成 session token，关联 rate limit counter，支持可配置的 idle timeout。

### 3.3 safeMove Temp File Collision — MEDIUM（Section 5.3）

`${dest}.doc77tmp` 使用静态临时文件名。在 project lock 被绕过时可能发生碰撞。

**建议**：使用 UUID：`${dest}.${uuid}.doc77tmp`，零成本消除碰撞风险。

### 3.4 Volume Circuit Breaker — 对 Delete 操作危险（Section 5.5）

超过 50MB 的文件 delete 操作跳过 shadow → 永久不可恢复删除。

**建议**：delete 操作始终 shadow（本质是 rename，成本低廉）；write/overwrite 保留 50MB 阈值但增加二次用户确认。

### 3.5 缺失 Write Rate Limiting

仅 read 有 rate limit（200/5min）。Auto mode 下 write 无限流。

**建议**：Auto mode 增加 per-session write limit（50 ops/5min）。Manual mode 因 user approval 本身即为节流，可不限制。

---

## 四、Timeline 评估

| Phase | 文档估计 | 实际估计 | 主要风险 |
|---|---|---|---|
| Phase 1: Skeleton + CLI | 1 周 | 1.5-2 周 | Monorepo setup, 4 packages, build pipeline |
| Phase 2: Preview engine | 1 周 | 1.5-2 周 | Mermaid v11, PDF.js v5/6 API 学习 |
| Phase 3: Web Dashboard | 1 周 | 2-3 周 | 原生 JS 实现完整 SPA |
| Phase 4: MCP service layer | 1 周 | 1-2 周 | MCP SDK 集成 |
| Phase 5: Approval + transactions | 1.5 周 | 3-4 周 | FS edge cases, cross-platform 测试 |
| Phase 6: AI module | 1 周 | 1.5-2 周 | Provider abstraction, tool-use loop, streaming |
| Phase 7: Editor + config + tests | 1 周 | 2-3 周 | Test infrastructure, 平台差异处理 |
| Phase 8: Packaging + release | 1 周 | 1-1.5 周 | npm publish + binary packaging |
| **合计** | **8-9 周** | **14-20 周** | |

**结论**：单人开发 8-9 周的估计偏乐观约 2 倍。2-3 人团队可在 10-12 周内交付。

---

## 五、优先级修正建议

### Priority 1 — Critical（编码前必须修正）

1. 升级版本约束：Node.js `>= 22.x`、Express `^5.x`、better-sqlite3 `^12.x`、marked `^17.x+`、Mermaid `^11.x`、PDF.js `^5.x+`
2. 补充缺失依赖：MCP SDK、AI SDK、monorepo tool、build tool、test framework、TS executor、logger
3. 设计并文档化 session management 系统（server 生成 token、SQLite `sessions` 表、过期机制）
4. 明确 internal event bus interface（`@doc77/mcp` ↔ `@doc77/ai`）

### Priority 2 — High（显著降低风险）

5. 修正 architecture diagram：MCP layer 作为独立 peer package
6. 增加 authentication 设计（localhost binding + 可选 shared-secret token）
7. 重构 project lock 为 SQLite 持久化 + heartbeat/timeout
8. 增加 runtime shadow GC（周期性 + startup）
9. safeMove 临时文件名使用 UUID
10. Delete 操作始终 shadow（不受 file size 限制）
11. Auto mode 增加 write rate limiting
12. 明确各 client 类型的 MCP transport 支持（stdio / HTTP / SSE）

### Priority 3 — Medium（质量提升）

13. MCP protocol 升级到 2025-11-25，利用 Tasks primitive
14. SSE stream 扩展 task lifecycle event
15. 明确 batch_operations 的 ordering、atomicity、idempotency 语义
16. 补充原生 JS frontend architecture 细节
17. 增加 health check endpoint、graceful shutdown 流程
18. 补充 cross-platform filesystem edge case 处理方案
19. Timeline 修正为 14-16 周（含 buffer）

---

## 六、验证清单

在更新 design document 后，需验证：

1. 所有 version constraint 对应到真实可安装的 npm package
2. MCP SDK v1.x API 与 Section 4.2 的 tool definition 兼容
3. Express 5.x API 差异已在 route handler 设计中考虑
4. Session management 设计覆盖文档中所有 `session_id` 使用点
5. Architecture diagram 与 Section 8.1 的 package structure 一致

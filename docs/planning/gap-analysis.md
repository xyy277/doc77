# Doc77 功能差距分析

> 对照 `docs/design/system-architecture.md` v2.5 + `docs/planning/implementation-plan.md` 逐项审计
> 日期: 2026-07-07

## 严重差距 (核心功能缺失)

### 1. 事务执行器 (executor.ts) — 完全缺失
**设计文档**: §5.2 三阶段事务流程 (Pre-flight → Shadow → Commit/Rollback)
**实际代码**: `packages/mcp/src/transaction/` 有 preflight.ts / shadow.ts / lock.ts 但 **没有 executor.ts**
**影响**: 审批通过后的任务永远不会被实际执行。Write Tools 只入队，不写盘。
**文件**: 需新建 `packages/mcp/src/transaction/executor.ts`

### 2. MCP Transport 未连接
**设计文档**: §4.5 stdio + Streamable HTTP 双 Transport
**实际代码**: CLI `mcp serve` 只打印帮助文字。`createMcpServer()` 创建了 McpServer 但从未 connect 到 Transport。
**影响**: MCP 工具无法被任何客户端调用。
**文件**: `packages/cli/src/bin/doc77.ts` (case 'mcp'), `packages/mcp/src/server.ts`

### 3. AI Chat 是假数据
**设计文档**: §6.3-6.4 Agent 对话循环 + SSE 流式 + OpenAI 调用
**实际代码**: `/api/ai/chat` 返回硬编码文本。AiProvider 类存在但未被 server 使用。
**影响**: AI 功能完全不可用。
**文件**: `packages/core/src/server/app.ts` (AI Chat 路由)

### 4. Write Tools 不写盘
**设计文档**: §4.2 写入工具需审批后实际执行文件变更
**实际代码**: write_file/create_folder/move_file/delete_file 都只调用 `enqueueOperation()` 写入 SQLite 队列，**从未实际操作文件**。
**影响**: MCP 写入功能不可用。需配合 Transaction Executor 完成。

### 5. CLI `mcp serve` 不工作
**设计文档**: §8.1 CLI 命令全集 - `doc77 mcp serve` 启动 MCP 服务
**实际代码**: `case 'mcp'` 只打印一行文字。
**影响**: 无法通过 CLI 启动 MCP 服务。

---

## 中度差距 (部分实现)

### 6. graceful shutdown 未实现
**设计文档**: §8.4 7 步 shutdown 流程 (SIGTERM → 等事务完成 → 清理 → 关 DB)
**实际代码**: `closeConnection()` 存在但无 SIGTERM handler。

### 7. Project Lock heartbeat 未实现
**设计文档**: §5.4 每 30s 更新 `heartbeat_at`
**实际代码**: `acquireProjectLock()` 插入 `heartbeat_at` 但不启动 `setInterval` 持续更新。

### 8. Auto 模式未实现
**设计文档**: §4.4 Auto 模式下写操作直接执行（delete 仍拦截）
**实际代码**: 无任何 auto/direct 执行逻辑。所有操作都走审批。

### 9. Runtime GC 未实现
**设计文档**: §5.6 周期性 GC（默认每 30 分钟）
**实际代码**: 只有一次性 `runShadowGC()`，无定时器触发。

### 10. Rate Limiting 未接入
**设计文档**: §4.4 每个 session 200r/50w per 5min
**实际代码**: `checkReadRateLimit()` / `checkWriteRateLimit()` 存在但**从未被 MCP Tools 或 API 调用**。

### 11. Config 深度限制未生效
**设计文档**: §4.4 `list_files` max depth 可配置，默认 ≤5
**实际代码**: `checkDepthLimit()` 存在但 `listFiles` tool 不调用它。

### 12. .doc77ignore 未实现
**设计文档**: §3.3 用户可自定义 .doc77ignore 文件
**实际代码**: 无。

### 13. 敏感文件过滤不完整
**设计文档**: `*.pem`, `*.p12`, `.git/*` 等
**实际代码**: `fs/index.ts` 的 `SENSITIVE_PATTERNS` 缺少 `.pem`, `.p12` 的目录内容过滤。

---

## 轻微差距 (UI/体验)

### 14. 审批流无超时自动拒绝
**设计文档**: §4.6 默认 30min 未审批自动拒绝
**实际代码**: `rejectExpiredTasks()` 存在但无调用方。

### 15. 审批 web UI 不展示 executing 状态
**设计文档**: §6.5 6 个 task lifecycle event
**实际代码**: EventBus 定义存在但未 emit 事件。前端只能看到 pending/approved/rejected。

### 16. AI prompt 可配置
**设计文档**: §6.4 System Prompt 通过 `~/.doc77/ai-prompts.yaml` 加载
**实际代码**: 硬编码在 `agent/index.ts` 中。

### 17. Dashboard 项目切换
**设计文档**: 3.5 节 - 点击项目卡片进入预览
**实际代码**: 已实现 ✓

---

## 总计

| 严重程度 | 数量 | 说明 |
|---------|------|------|
| 严重 | 5 | Transaction Executor、MCP Transport、AI Chat、Write 不写盘、CLI mcp serve |
| 中度 | 8 | Graceful shutdown、Heartbeat、Auto mode、Runtime GC、Rate limiting、Depth limit、.doc77ignore、敏感文件 |
| 轻微 | 3 | 审批超时、EventBus 未 emit、Prompt 硬编码 |
| **合计** | **16** | |

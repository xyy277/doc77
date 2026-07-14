# AI 模块深度评估报告

> 评估日期：2026-07-14
> 范围：`packages/ai`、`packages/mcp`、`packages/core` 中的 AI 相关链路
> 配套路线图：见本报告末尾「改进路线图」

---

## 结论摘要

Doc77 的**写安全基建**（shadow backup、三阶段 transaction、rollback、pre-flight check、审批队列、project lock、audit log）比市面上多数同类 agent 更完整。但当前最大的架构问题是：**AI 模块与 MCP 模块相互隔离** —— AI Agent 只能读文件，无法调用 MCP 的写能力。设计文档 `docs/design/system-architecture.md` 描述的"AI Agent ──内部 API──▶ MCP 服务层(读写)"愿景**从未落地**，而 `docs/planning/implementation-status.md` 却将相关 Task 标记为 completed。

一句话定位：**差异化优势 = 强写安全基建；当前瓶颈 = AI 未接通该基建。**

---

## 1. 当前能力清单

### 运行时核心（`packages/ai`）

| 能力             | 位置                | 说明                                                                                           |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `DocAgent`       | `agent/index.ts`    | ReAct 循环，支持流式 `chatStream` + 非流式 `chat`；`maxSteps` 默认 10（调用处设 5）            |
| `AiProvider`     | `provider/index.ts` | OpenAI-compatible，裸 `fetch` 实现，SSE 流式解析 + tool-call 累积                              |
| 只读工具 ×3      | `tools.ts`          | `list_files` / `read_file` / `get_file_info`（注释标注 "Write tools are deferred to Phase 5"） |
| prompt 生成器 ×3 | `agent/index.ts`    | `createSummarizePrompt` / `createClassifyPrompt` / `createProjectSummaryPrompt`                |

### 前端入口（`packages/core/src/web/js/preview.js`）

- AI Summary 按钮（`doAISummary`）、聊天面板"AI 助手"（`openAIChat`）
- 快捷动作：分析项目结构 / 总结当前文档 / 查找重复文件
- `context_file` 快速路径（2026-07-14 修复：总结当前打开文件时直接注入内容 + 禁用工具，避免乱翻目录）

### 多 provider 配置（`common.js`）

DeepSeek / OpenAI / Qwen / Kimi / Doubao / GLM，token 加密存储（PBKDF2 派生密钥）。

---

## 2. 可用性分级

| 分级        | 能力                                                                                                                                 | 证据                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| ✅ 真正可用 | 聊天 + 3 个读工具、总结当前文档（已修）、`/api/ai/test` 连接测试                                                                     | 走真实 LLM                    |
| ❌ 假实现   | `/api/ai/summarize` 返回硬编码"共 N 行 M 字符"，**不调用任何 LLM**                                                                   | `app.ts:1368`；且无任何调用方 |
| 💀 死代码   | `formatToolResult`、`createSummarizePrompt`、`createProjectSummaryPrompt` 从未被调用；`src/prompts/` 空目录；`openai` SDK 未使用依赖 | grep 全仓零引用               |
| 🔌 未接线   | MCP event bus 有 emit、AI 端无监听；MCP rate limit / `runShadowGC` / `checkFileSize` / `checkDepthLimit` 定义未接入                  | —                             |

---

## 3. 市面对标（2026）

| 工具                    | 组织能力           | 安全模型                | 与 Doc77 对比                        |
| ----------------------- | ------------------ | ----------------------- | ------------------------------------ |
| FilePilot AI            | plan-based dry-run | scoped dirs + audit log | 组织能力接通，Doc77 基建更强但未接通 |
| LocalFilesOrganizer-MCP | 按类型/日期/大小   | allowed/protected paths | 纯 MCP，无事务回滚                   |
| fs-mcp                  | 文件级操作         | sandbox + symlink 阻断  | 无审批队列                           |
| Claude Cowork           | 自主 agent         | Scoped Access + HITL    | 商业级自主，Doc77 偏本地私有         |

**共同趋势**：local-first + MCP 原生 + plan-based（dry-run 预览再执行）+ 写操作 opt-in + 审计日志。

**Doc77 的反差**：竞品普遍"能力弱但接通"，Doc77"基建强但没接通"。一旦打通 AI→MCP，Doc77 的安全性反而领先。

---

## 4. AI 与 MCP：核心缺陷

**两套完全隔离的系统**：

```
AI 链路:  /api/ai/chat → DocAgent → 自己的 READ_TOOLS + core 里硬编码 executeTool → @doc77/core FS 函数
MCP 链路: 外部 MCP client → createMcpServer → write 工具 → enqueue → 审批 → executor → 真正写文件
```

- **AI 只能读，永远无法写**：`executeTool` 的 `switch` 对未知工具直接 `return Error`，AI 没有入队写操作的通道；shadow/rollback/审批基建从 AI 聊天里完全够不到。
- **设计愿景未落地**：`system-architecture.md` 明确"AI 通过内部 API 调 MCP 读写""智能归类建议 + 批量操作规划"，实际未建。
- **两套 session 各行其是**：AI 用内存 `Map`（重启即丢、无限流）；MCP 用 SQLite session（有限流但从未被调用）。
- **前后端默认值不一致**：前端默认 DeepSeek，后端 fallback OpenAI。
- **MCP 写工具不做敏感文件检查**：`checkPathAccess` 只校验路径沙箱，`isSensitiveFile` 未接入写路径。
- **两处 write.ts 潜在运行时 bug**：`batchOperations` 引用未导入的 `enqueueOperation`；`getTaskStatus` 引用未导入的 `getConnection`（`tsup` 不做类型检查，编译通过但运行时 `ReferenceError`）。

---

## 5. 测试与代码审查

### 测试覆盖

| 模块           | 现状                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ai`  | 仅 3 用例（VERSION + 2 个 tool-gating）；`AiProvider.chat`/SSE 解析/error 路径/真实工具执行全无覆盖                                                            |
| `packages/mcp` | 较扎实：session、transaction、preflight、shadow/rollback、safeMove、audit、GC；但 `executeApprovedTasks` 完整三阶段无集成测试，`server.ts` 工具 handler 无测试 |

### 代码审查红旗

1. 假的 `/api/ai/summarize`（误导性 API）
2. 成片死代码 + 未用依赖（`openai`）
3. 读工具逻辑在 core 和 mcp 中**重复实现两份**
4. write.ts 两处未导入符号引用（运行时 bug）
5. 大量已存储但未消费的 config（`ai.auto_mode` / `ai.risk_level` / …）

---

## 改进路线图

分三阶段推进（详见 `docs/planning/` 或规划文件）：

- **Phase 1 — 止血与清理**：移除假 summarize、清死代码/未用依赖、统一 provider 默认值、补 MCP 写工具敏感文件检查 + 修 write.ts 运行时 bug、补 AI 模块测试。
- **Phase 2 — 接通 AI→MCP 写链路**（核心）：为 AI 新增 `WRITE_TOOLS`，经**现有审批队列**入队 `pending`，用户在 Queue 标签确认后走 shadow/rollback 事务执行；AI 只入队、不自动执行；三重安全防线（AI 层敏感检查 → MCP 路径沙箱 → MCP 敏感检查）+ `ai.risk_level` gating。
- **Phase 3 — 能力增强**：真实归类/整理 UI（接线 `createClassifyPrompt`）、AI 端监听 event bus 回执、统一 session 持久化 + rate limit、实时 tool_call 流式。

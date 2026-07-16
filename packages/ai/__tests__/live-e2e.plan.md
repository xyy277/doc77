# 实时 LLM 端到端测试设计（Qwen3.5 优化版）

## 设计原则

1. **全场景覆盖** — 基础对话、文件读取、工具调用、写提案审批、多轮对话、边界条件
2. **本地模型优化** — 慷慨 timeout、max_tokens=4096、耐心等待 reasoning 完成
3. **测试间隔离** — 每个 test 用独立 session_id（不依赖前序状态）
4. **env-gated** — 缺 DOC77_LLM_URL 自动 skip；URL 只通过环境变量传入
5. **每步日志** — 每场景输出耗时、token 数、finish_reason，方便分析

## 测试场景矩阵

| # | 场景名 | 类型 | 涉及流程 | 关键验证 |
|---|--------|------|----------|----------|
| 1 | 基础对话 | AI | chatStream → token → done | 有中文回复，无工具调用，无 error |
| 2 | 中文理解 + 多语言 | AI | 中文对话 | 正确理解和回答中文 |
| 3 | 文件总结（context_file） | AI | 内容注入 → noTools → 直接回答 | 无工具调用，回复包含 README |
| 4 | 读工具（list_files + read_file） | AI → ReAct | user → list_files → 返回 → read_file → 返回 → 摘要 | 调用了 list_files 和 read_file |
| 5 | 多轮对话（同一 session_id） | AI → 多轮 | 第一轮问项目 → 第二轮问细节 | 第二轮不重复初始化，记忆对话历史 |
| 6 | 移动文件（enqueue） | AI → MCP | move_file → pending | 写了 pending 任务，记录 task_id |
| 7 | 创建目录（enqueue） | AI → MCP | create_folder → pending | 任务已入队 |
| 8 | 安全边界 | AI → MCP | 试图操作 .env | 错误提示，队列无记录，文件仍在 |
| 9 | 批量操作 | AI → MCP | batch_operations 提案 | 至少入了 1 个任务 |
| 10 | 全写链路（approve → execute） | AI → MCP → 文件系统 | move_file → approve → executor → 落盘 | 文件真实移动 |

## 参数优化

```typescript
// 每个 test
const T = 600_000;       // 10 min timeout（考虑 ~1.8 tok/s + 推理 token）
const MAX_TOKENS = 4096; // 模型默认值，给 token 留余量
```

## 文件结构

```
packages/ai/__tests__/
  live-e2e.plan.md             (本文件 — 设计文档，不提交到 git)
  live-e2e.test.ts             (测试代码 — env-gated，团队可共享)
```

## 已知注意（避免重复踩坑）

1. 第二条 system message → 模型崩。测试中只传 1 条 system msg，或者将 context 拼入用户消息。
2. `content` 中文可能因 reasoning_model 策略为空。max_tokens 给足，并留出 `reasoning_content` 空闲 token。
3. scenario 4（tool call）循环耗时最长（~2-3 轮对话）。
4. scenario 10（approve → execute）不依赖 AI，直接调用 MCP executor，但依赖前序 scenario 6 的上下文。

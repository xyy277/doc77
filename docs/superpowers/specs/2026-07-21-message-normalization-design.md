# 消息规范化层设计

## 背景

doc77 Agent 在连接本地模型（如 `qwen3.5-9b-abliterated`）进行多轮对话时，`addContext()` 方法将 `[Context]` system 消息通过 `push()` 追加到 messages 数组末尾。当该方法在第二轮对话才被触发时（第 1 轮有 `context_file` 跳过了 context 注入），`[Context]` system 消息出现在 user/assistant 历史消息之后，违反 Qwen ChatML 模板的 "System message must be at the beginning" 规则，导致 400 错误。

## 数据链路分析

### 完整调用链

```
前端 POST /api/ai/chat
  → app.ts:createAIChatHandler
    → sessions.ts:getOrCreateSession()     [创建/恢复 DocAgent]
    → app.ts:3091 addContext()             [条件：[Context] system 消息 — 仅 hasContext===false 时]
    → agent.chatStream()
      → agent/index.ts:81 push user msg    [追加 user 消息到数组末尾]
      → provider/index.ts:124 chatStream() [POST messages 到 LLM — 无任何转换]
```

### Bug 触发时序

**第 1 轮** — `context_file` 有值（用户在编辑器中打开了文件），`addContext()` 被跳过：

```
messages: [system, user]
```

**第 2 轮** — 同一 session，`context_file` 为空（用户继续对话），`hasContext` 仍为 false：

1. `addContext()` 被调用 → `this.messages.push({ role:'system', content:'[Context]...' })` → 追加到末尾
2. `chatStream()` → `this.messages.push({ role:'user', ... })` → 继续追加

```
发送给 LLM: [system, user(T1), assistant(T1), system([Context]), user(T2)]
                                              ↑ Qwen ChatML: 400 错误
```

### 根因

`addContext()` 使用 `push()` 追加到数组末尾，缺少插入位置感知。当 context 注入延迟到有历史消息之后才发生时，system 消息出现在 user/assistant 消息之后。

## 设计决策

选择在 **AiProvider** 层添加消息规范化，而非在 DocAgent 层修复 `addContext()` 的插入位置：

1. Provider 是消息离开系统的最后边界，在此处规范化符合"出口检查"设计原则
2. DocAgent 保持业务语义不变，不影响工具循环、历史持久化等逻辑
3. 规范化是通用模型兼容性基础设施 — 不仅是 Qwen，其他模型也可能有类似限制
4. 未来可扩展为根据模型类型应用不同的规范化策略

## 架构

```
DocAgent.messages (业务层，不变)
  → AiProvider.chatStream(request)
    → normalizeMessages(request.messages)   ← 新增
    → fetch(LLM API, { body: normalized messages })
```

## 规范化规则

**唯一规则**：收集所有 `system` 角色消息 → 合并为一条 → 放在数组最前面。

```
输入:
  [0] system("You are a helpful assistant")
  [1] user("Hello")
  [2] assistant("Hi!")
  [3] system("[Context] Project info...")
  [4] user("Create a file")

输出:
  [0] system("You are a helpful assistant\n\n[Context] Project info...")
  [1] user("Hello")
  [2] assistant("Hi!")
  [3] user("Create a file")
```

- 仅 1 条 system 消息时不处理（最常见情况，零开销）
- tool 消息的 `tool_call_id` 关联不动
- user/assistant 交替顺序不动

## 实现

**文件**：`packages/ai/src/provider/index.ts`

新增独立函数 `normalizeMessages()`，在 `chat()` 和 `chatStream()` 中各加一行调用。

```typescript
function normalizeMessages(messages: AiMessage[]): AiMessage[] {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');

  if (systemMsgs.length <= 1) return messages;

  const mergedContent = systemMsgs.map(m => m.content).join('\n\n');
  return [
    { role: 'system' as const, content: mergedContent },
    ...nonSystemMsgs,
  ];
}
```

改动量：约 15 行新增 + 2 行修改。

## 测试

### 单元测试

在 `packages/ai/__tests__/` 中新增 `message-normalization.test.ts`：

| 场景 | 输入 | 预期输出 |
|---|---|---|
| 单 system | `[system, user]` | 不变 |
| 多 system 连续 | `[system(A), system(B), user]` | `[system(A\n\nB), user]` |
| 多 system 分离 | `[system(A), user, assistant, system(B), user]` | `[system(A\n\nB), user, assistant, user]` |
| 无 system | `[user, assistant]` | 不变 |
| 含 tool 消息 | `[system(A), user, assistant(tool_calls), tool(id:x), system(B)]` | `[system(A\n\nB), user, assistant, tool]` |

### 集成验证

在 `live-e2e.test.ts` 中添加多轮对话场景：第 1 轮带 `context_file`（跳过 addContext），第 2 轮不带（触发延迟 addContext），验证两轮都成功返回。

## 参考

- 测试文件 `packages/ai/__tests__/live-e2e.test.ts:15-16` 已标注此问题：
  > NO second system message (this model rejects multi-system-msg)
  > Context injected into user message, NOT via addContext()

# 消息规范化层 实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AiProvider 层添加 `normalizeMessages()` 函数，确保发送给 LLM 的 messages 数组中所有 system 消息被合并到最前面，解决多轮对话中延迟 context 注入导致的 Qwen ChatML 400 错误。

**Architecture:** 在 `AiProvider` 的 `chat()` 和 `chatStream()` 方法中，发送 HTTP 请求前对 `request.messages` 调用 `normalizeMessages()`。该函数收集所有 `role: 'system'` 的消息，合并为一条放在数组最前面，其余消息保持原顺序。

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- 仅修改 `packages/ai/src/provider/index.ts`，不碰 DocAgent 或 app.ts
- `normalizeMessages` 需 export 以便单元测试
- 改动量约 15 行新增 + 2 行修改
- 遵循现有代码风格：单引号、分号、2 空格缩进

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/ai/src/provider/index.ts` | Modify | 新增 `normalizeMessages()` 导出函数；在 `chat()` 和 `chatStream()` 中调用 |
| `packages/ai/__tests__/message-normalization.test.ts` | Create | 5 个场景的单元测试，覆盖设计文档中的所有用例 |
| `packages/ai/__tests__/live-e2e.test.ts` | Modify | 添加多轮对话 + 延迟 context 注入场景（可选，需真实 LLM 环境） |

---

### Task 1: 添加 `normalizeMessages()` 函数并集成到 AiProvider

**Files:**
- Modify: `packages/ai/src/provider/index.ts`

**Interfaces:**
- Produces: `export function normalizeMessages(messages: AiMessage[]): AiMessage[]`

- [ ] **Step 1: 在 `provider/index.ts` 顶部（import 之后、AiProviderConfig 之前）添加 `normalizeMessages` 导出函数**

```typescript
/**
 * Normalize messages before sending to the LLM API.
 *
 * Some local models (e.g. Qwen ChatML) require system messages to appear
 * only at the beginning of the conversation. This function merges all
 * system-role messages into a single message at index 0, then appends the
 * remaining non-system messages in their original order.
 *
 * When there is 0 or 1 system message the array is returned unchanged so
 * the common case incurs no allocation overhead.
 */
export function normalizeMessages(messages: AiMessage[]): AiMessage[] {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

  if (systemMsgs.length <= 1) return messages;

  const mergedContent = systemMsgs.map((m) => m.content).join('\n\n');
  return [
    { role: 'system' as const, content: mergedContent },
    ...nonSystemMsgs,
  ];
}
```

- [ ] **Step 2: 在 `chat()` 方法中调用 `normalizeMessages`**

找到 `chat()` 方法中 `body: JSON.stringify({...})` 的位置（第 76 行附近），在 `JSON.stringify` 之前添加一行：

```typescript
async chat(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const normalized = normalizeMessages(request.messages);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.model,
        messages: normalized,
        tools: request.tools,
        stream: false,
        max_tokens: request.max_tokens || 4096,
      }),
    });
    // ... 其余代码不变
```

- [ ] **Step 3: 在 `chatStream()` 方法中调用 `normalizeMessages`**

找到 `chatStream()` 方法中 `body: JSON.stringify({...})` 的位置（第 131 行附近），在 `JSON.stringify` 之前添加一行：

```typescript
async *chatStream(request: AiCompletionRequest): AsyncGenerator<StreamChunk> {
    const normalized = normalizeMessages(request.messages);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.model,
        messages: normalized,
        tools: request.tools,
        stream: true,
        max_tokens: request.max_tokens || 4096,
      }),
    });
    // ... 其余代码不变
```

- [ ] **Step 4: 确认 `normalizeMessages` 已从 `packages/ai/src/index.ts` 导出（如果该文件是 barrel export）**

检查 `packages/ai/src/index.ts` 是否 re-export 了 provider 的内容。如果不 re-export，跳过此步；如果 re-export，确保 `normalizeMessages` 在 exports 列表中。

- [ ] **Step 5: 运行现有测试确保无回归**

```bash
cd /home/zhouj/code/doc77 && pnpm --filter @doc77/ai test
```

预期：所有现有测试通过（provider.test.ts、agent/index.test.ts、tools.test.ts）。

- [ ] **Step 6: Commit**

```bash
git add packages/ai/src/provider/index.ts
git commit -m "feat(ai): add normalizeMessages to merge system messages before LLM call

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 2: 编写单元测试

**Files:**
- Create: `packages/ai/__tests__/message-normalization.test.ts`

**Interfaces:**
- Consumes: `normalizeMessages` from `../src/provider/index.js`
- Consumes: `AiMessage` type from `../src/provider/index.js`

- [ ] **Step 1: 创建测试文件 `packages/ai/__tests__/message-normalization.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeMessages, type AiMessage } from '../src/provider/index.js';

/** Shortcut: build an AiMessage with role + content only (no tool fields). */
function msg(role: AiMessage['role'], content: string): AiMessage {
  return { role, content };
}

describe('normalizeMessages', () => {
  it('returns the array unchanged when there is a single system message', () => {
    const messages = [
      msg('system', 'You are a helpful assistant.'),
      msg('user', 'Hello'),
    ];
    const result = normalizeMessages(messages);
    expect(result).toBe(messages); // same reference — zero-allocation path
    expect(result).toEqual(messages);
  });

  it('merges two consecutive system messages into one', () => {
    const messages = [
      msg('system', 'Prompt A'),
      msg('system', 'Prompt B'),
      msg('user', 'Hello'),
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: 'system',
      content: 'Prompt A\n\nPrompt B',
    });
    expect(result[1]).toEqual(msg('user', 'Hello'));
  });

  it('merges separated system messages and moves the merged one to the front', () => {
    const messages = [
      msg('system', 'Prompt A'),
      msg('user', 'First question'),
      msg('assistant', 'First answer'),
      msg('system', '[Context] Project info'),
      msg('user', 'Second question'),
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      role: 'system',
      content: 'Prompt A\n\n[Context] Project info',
    });
    expect(result[1]).toEqual(msg('user', 'First question'));
    expect(result[2]).toEqual(msg('assistant', 'First answer'));
    expect(result[3]).toEqual(msg('user', 'Second question'));
  });

  it('returns the array unchanged when there are no system messages', () => {
    const messages = [
      msg('user', 'Hello'),
      msg('assistant', 'Hi!'),
    ];
    const result = normalizeMessages(messages);
    expect(result).toBe(messages);
  });

  it('preserves tool messages and their tool_call_id', () => {
    const toolMsg: AiMessage = {
      role: 'tool',
      tool_call_id: 'call_abc123',
      content: 'file contents here',
    };
    const messages: AiMessage[] = [
      msg('system', 'System prompt'),
      msg('user', 'Read a file'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_abc123',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/x"}' },
          },
        ],
      },
      toolMsg,
      msg('system', '[Context] Extra info'),
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      role: 'system',
      content: 'System prompt\n\n[Context] Extra info',
    });
    // tool message preserved with its tool_call_id intact
    expect(result[2]).toEqual(toolMsg);
    expect(result[2].tool_call_id).toBe('call_abc123');
  });
});
```

- [ ] **Step 2: 运行单元测试验证**

```bash
cd /home/zhouj/code/doc77 && npx vitest run packages/ai/__tests__/message-normalization.test.ts
```

预期：5 个测试全部 PASS。

- [ ] **Step 3: 运行完整 AI 包测试套件确认无回归**

```bash
cd /home/zhouj/code/doc77 && pnpm --filter @doc77/ai test
```

预期：所有测试通过。

- [ ] **Step 4: Commit**

```bash
git add packages/ai/__tests__/message-normalization.test.ts
git commit -m "test(ai): add unit tests for normalizeMessages

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 3: 更新集成测试（可选，需要真实 LLM 环境）

**Files:**
- Modify: `packages/ai/__tests__/live-e2e.test.ts`

**说明：** 此 task 仅在已配置 `DOC77_LLM_URL` / `DOC77_LLM_MODEL` 环境变量时可执行。

- [ ] **Step 1: 在 `live-e2e.test.ts` 末尾添加延迟 context 注入的多轮场景测试**

```typescript
it('多轮对话 + 延迟 context 注入（第2轮才触发 addContext）', async () => {
  // Session without context_file so addContext is skipped on turn 1
  const sessionId = `ctx-${Date.now()}`;
  const handler = createAIChatHandler(...); // use the existing factory pattern from the file

  // Turn 1: send a message WITHOUT triggering addContext
  // (context_file is set, blocking addContext)
  const chunks1: any[] = [];
  for await (const chunk of handler({
    message: 'Hello, what can you do?',
    project_id: testProjectId,
    session_id: sessionId,
    context_file: 'README.md', // blocks addContext
  })) {
    chunks1.push(chunk);
  }
  const done1 = chunks1.find((c) => c.type === 'done');
  expect(done1).toBeDefined();

  // Turn 2: WITHOUT context_file — addContext will fire this time
  const chunks2: any[] = [];
  for await (const chunk of handler({
    message: 'Tell me about the project structure',
    project_id: testProjectId,
    session_id: sessionId,
    // no context_file → addContext fires, injecting [Context] at end of history
  })) {
    chunks2.push(chunk);
  }
  const done2 = chunks2.find((c) => c.type === 'done');
  expect(done2).toBeDefined();
  // No error chunk in turn 2 — normalization prevented the 400
  const errors = chunks2.filter((c) => c.type === 'error');
  expect(errors).toHaveLength(0);
}, 600_000);
```

- [ ] **Step 2: 运行集成测试（需要真实 LLM 环境）**

```bash
cd /home/zhouj/code/doc77 && \
  DOC77_LLM_URL=http://172.22.128.66:8081/v1 \
  DOC77_LLM_MODEL=qwen3.5-122b \
  npx vitest run packages/ai/__tests__/live-e2e.test.ts -t '延迟 context'
```

预期：两轮对话均成功，无 error chunk。

- [ ] **Step 3: Commit**

```bash
git add packages/ai/__tests__/live-e2e.test.ts
git commit -m "test(ai): add delayed context injection scenario to live e2e tests

Co-Authored-By: xyy277 <907507646@qq.com>"
```

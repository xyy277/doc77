# @doc77/ai

Doc77 AI 模块 — AI Provider 抽象、Agent 核心、对话 API。

## Installation

```bash
npm install @doc77/ai
```

## Modules

| 模块 | 说明 |
|---|---|
| **AiProvider** | OpenAI 兼容 API Provider 抽象层 |
| **DocAgent** | 文档管理 Agent，上下文注入 + 多步推理 |
| **Tools** | MCP Tool 定义（OpenAI Function Calling 格式） |
| **SSE Streaming** | Server-Sent Events 流式响应 |

## API

```typescript
import { AiProvider, DocAgent, READ_TOOLS } from '@doc77/ai';

// 创建 Provider
const provider = new AiProvider({
  apiKey: 'your-api-key',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
});

// 创建 Agent
const agent = new DocAgent({
  provider,
  model: 'gpt-4o',
  tools: READ_TOOLS,
  executeTool: async (name, args) => { /* ... */ },
  maxSteps: 5,
});

// 流式对话
for await (const chunk of agent.chatStream('分析项目结构')) {
  if (chunk.type === 'token') console.log(chunk.content);
}
```

## Configuration

通过 `doc77 config` 设置：

```bash
doc77 config set ai.token sk-xxx
doc77 config set ai.base_url https://api.deepseek.com
doc77 config set ai.model deepseek-v4-pro
doc77 config set ai.enabled true
```

---

Part of [Doc77](https://github.com/xyy277/doc77) — 本地文档预览与管理工具

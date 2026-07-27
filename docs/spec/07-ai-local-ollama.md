# AI 本地模型支持（Ollama） — 设计文档

> 日期: 2026-07-27 | 优先级: Q4-3 | 状态: 设计

## 一、背景与目标

Doc77 AI 模块当前仅支持 OpenAI-compatible 远程 API（需 API Key + 联网）。用户反馈：
- 希望完全离线使用 AI（隐私 + 无网络环境）
- 已有本地 GPU 设备，希望利用本地算力
- 不想为偶尔的文档总结付 API 费用

**目标**：
- 集成 Ollama 作为本地 AI Provider（零 API 费用、完全离线）
- 支持 RAG 文档问答（基于本地文档的检索增强生成）
- 多 Provider 切换（Ollama / OpenAI / 自定义）
- 保持现有 AI 功能不变（对话、总结、分类）

**非目标**：
- 不自研模型
- 不集成 llama.cpp 直接调用（通过 Ollama 间接支持）
- 不做模型训练/微调

## 二、架构设计

### 2.1 Provider 抽象（已有，需扩展）

```typescript
// 现有 AiProvider 接口扩展
interface AiProvider {
  readonly name: string;
  readonly type: 'openai' | 'ollama' | 'custom';

  /** 对话补全（流式） */
  chat(messages: Message[], options: ChatOptions): AsyncGenerator<ChatChunk>;

  /** 嵌入向量（RAG 用） */
  embed?(texts: string[]): Promise<number[][]>;

  /** 模型列表 */
  listModels(): Promise<ModelInfo[]>;

  /** 健康检查 */
  healthCheck(): Promise<boolean>;
}
```

### 2.2 Ollama Provider 实现

```typescript
class OllamaProvider implements AiProvider {
  readonly name = 'ollama';
  readonly type = 'ollama';
  private baseUrl: string;  // 默认 http://localhost:11434

  async *chat(messages: Message[], options: ChatOptions) {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: options.model || 'qwen2.5:7b',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        options: {
          temperature: options.temperature ?? 0.7,
          num_ctx: options.maxTokens ?? 4096,
        },
      }),
    });

    // 解析 NDJSON 流
    for await (const chunk of parseNDJSON(response.body)) {
      if (chunk.message?.content) {
        yield { type: 'text', content: chunk.message.content };
      }
      if (chunk.done) {
        yield { type: 'done', usage: { promptTokens: chunk.prompt_eval_count, completionTokens: chunk.eval_count } };
      }
    }
  }

  async embed(texts: string[]) {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model: this.embedModel, input: texts }),
    });
    const data = await response.json();
    return data.embeddings;
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    const data = await res.json();
    return data.models.map(m => ({
      id: m.name,
      name: m.name,
      size: m.size,
      parameterSize: m.details?.parameter_size,
    }));
  }

  async healthCheck() {
    try {
      const res = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch { return false; }
  }
}
```

### 2.3 推荐本地模型

| 用途 | 推荐模型 | 大小 | 说明 |
|------|---------|------|------|
| 对话/总结 | `qwen2.5:7b` | ~4.5GB | 中文优秀，性价比高 |
| 对话（低配） | `qwen2.5:3b` | ~2GB | 8GB 内存可跑 |
| 对话（高配） | `qwen2.5:14b` | ~9GB | 质量更高 |
| 嵌入 | `nomic-embed-text` | ~270MB | RAG 向量化 |
| 代码 | `codellama:7b` | ~4GB | 代码分析 |

## 三、RAG 文档问答

### 3.1 架构

```
用户提问: "项目部署流程是什么？"
  │
  ├─ 1. Embedding: 问题 → 向量
  │
  ├─ 2. 检索: 向量相似度搜索 → Top-K 相关文档片段
  │     (SQLite vec 扩展 或 内存余弦相似度)
  │
  ├─ 3. 构建 Prompt:
  │     System: "基于以下文档内容回答问题..."
  │     Context: [检索到的片段]
  │     User: "项目部署流程是什么？"
  │
  └─ 4. LLM 生成回答（引用来源文件）
```

### 3.2 向量索引

```sql
-- 文档片段表
CREATE TABLE IF NOT EXISTS rag_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,           -- 文本片段（~500 字）
  embedding TEXT,                  -- JSON 数组（向量）
  token_count INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id, file_path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_project ON rag_chunks(project_id);
```

### 3.3 分块策略

```
文件 → 按标题分块（Markdown h1/h2/h3 边界）
     → 每块 300-800 字（overlap 50 字）
     → 代码文件按函数/类分块
     → 纯文本按段落分块
```

### 3.4 检索策略

Phase 1（零依赖）：
- 向量存为 JSON 数组在 SQLite
- 检索时全量加载项目向量 → 内存余弦相似度计算
- 适合 < 1000 个 chunk 的项目

Phase 2（大规模）：
- 集成 `sqlite-vec` 扩展（向量搜索）
- 或 `hnswlib-node`（HNSW 近似最近邻）
- 适合 > 10000 chunk

## 四、配置

```typescript
interface AiConfig {
  provider: 'openai' | 'ollama' | 'custom';
  // OpenAI
  openaiApiKey?: string;
  openaiBaseUrl?: string;      // 默认 https://api.openai.com/v1
  openaiModel?: string;        // 默认 gpt-4o-mini
  // Ollama
  ollamaUrl?: string;          // 默认 http://localhost:11434
  ollamaModel?: string;        // 默认 qwen2.5:7b
  ollamaEmbedModel?: string;   // 默认 nomic-embed-text
  // 通用
  temperature: number;         // 默认 0.7
  maxTokens: number;           // 默认 4096
  systemPrompt?: string;       // 自定义系统提示
  ragEnabled: boolean;         // 是否启用 RAG
  ragTopK: number;             // 检索 Top-K，默认 5
}
```

## 五、前端 UI

### 5.1 AI 设置面板

```
┌─ AI 助手设置 ──────────────────────────────────────────┐
│                                                         │
│  Provider: (●) Ollama (本地)  ( ) OpenAI  ( ) 自定义   │
│                                                         │
│  ─── Ollama 配置 ───                                    │
│  地址:   [http://localhost:11434          ]             │
│  模型:   [qwen2.5:7b ▾]  (自动检测已安装模型)          │
│  状态:   ● 已连接 (v0.4.2)                             │
│                                                         │
│  ─── RAG 文档问答 ───                                   │
│  [✓] 启用 RAG（基于项目文档回答）                       │
│  嵌入模型: [nomic-embed-text ▾]                         │
│  索引状态: 已索引 342 个片段 (3 个项目)                 │
│  [重建索引]                                             │
│                                                         │
│  [测试对话]                                             │
└─────────────────────────────────────────────────────────┘
```

### 5.2 对话 UI 增强

- 模型选择下拉（对话输入框旁）
- RAG 回答时显示引用来源：`📄 来源: docs/deploy.md (第 3 段)`
- 本地模型标记：`🏠 本地模型` badge

## 六、API 变更

| 方法 | 路径 | 变更 |
|------|------|------|
| GET | `/api/ai/models` | 新增：返回可用模型列表 |
| GET | `/api/ai/providers` | 新增：返回已配置 Provider 状态 |
| POST | `/api/ai/chat` | 修改：支持 `provider` 和 `model` 参数 |
| POST | `/api/ai/rag/index` | 新增：触发 RAG 索引构建 |
| GET | `/api/ai/rag/status` | 新增：RAG 索引状态 |
| POST | `/api/ai/rag/query` | 新增：RAG 检索（调试用） |

## 七、Ollama 检测与引导

```typescript
async function detectOllama(): Promise<OllamaStatus> {
  // 1. 检查默认端口
  const healthy = await new OllamaProvider('http://localhost:11434').healthCheck();
  if (healthy) return { installed: true, running: true, models: await listModels() };

  // 2. 检查命令是否存在
  const hasCmd = await commandExists('ollama');
  if (hasCmd) return { installed: true, running: false };

  // 3. 未安装
  return { installed: false, installUrl: 'https://ollama.com/download' };
}
```

前端引导：
```
Ollama 未运行
  → "检测到 Ollama 已安装但未启动，是否启动？" [启动]
Ollama 未安装
  → "安装 Ollama 以使用本地 AI（免费、离线、隐私）" [查看安装指南]
无模型
  → "拉取推荐模型 qwen2.5:7b (4.5GB)？" [拉取] [选择其他]
```

## 八、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/ai/src/providers/ollama.ts` | 新增 | Ollama Provider |
| `packages/ai/src/providers/provider.ts` | 修改 | 扩展接口（embed, listModels） |
| `packages/ai/src/rag/chunker.ts` | 新增 | 文档分块 |
| `packages/ai/src/rag/indexer.ts` | 新增 | 向量索引构建 |
| `packages/ai/src/rag/retriever.ts` | 新增 | 相似度检索 |
| `packages/ai/src/rag/prompt.ts` | 新增 | RAG prompt 构建 |
| `packages/core/src/db/migrations.ts` | 修改 | rag_chunks 表 |
| `packages/core/src/server/app.ts` | 修改 | AI API 扩展 |
| `packages/core/src/web/js/ai-chat.js` | 修改 | 模型选择 + RAG 引用 UI |

## 九、验收标准

1. 安装 Ollama + qwen2.5:7b → Doc77 自动检测 → 对话正常
2. 完全断网 → AI 对话仍可用（本地模型）
3. 启用 RAG → 提问"部署流程" → 回答引用正确文档
4. 多 Provider：Ollama ↔ OpenAI 一键切换
5. 模型列表自动获取（显示已安装模型）
6. RAG 索引：1000 文件项目 < 60s 完成
7. 无 Ollama → 优雅降级（提示安装，不影响其他功能）

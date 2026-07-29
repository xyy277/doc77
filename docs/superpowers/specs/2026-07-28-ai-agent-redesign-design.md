# AI Agent 架构重设计文档

**日期**：2026-07-28
**状态**：设计完成，待评审

---

## 一、背景与现状分析

### 1.1 当前架构

Doc77 的 AI 功能由三个包协作实现：

```
packages/ai/           — AiProvider（模型连接）+ DocAgent（ReAct 循环）+ 工具定义
packages/core/         — 会话持久化（ai-sessions.ts）+ AI Chat Handler + SSE 路由
packages/mcp/          — 工具执行器 + 写操作审批队列
```

**当前数据流**：

```
前端 POST /api/ai/chat
  → createAIChatHandler
    → getDecryptedAiConfig（从 config 表读 token/base_url/model）
    → new AiProvider(config) + new DocAgent({ provider, tools, executeTool })
    → agent.chatStream(message)  ← 每次请求新建 agent，从 DB 加载历史 setHistory()
      → ReAct 循环（maxSteps=5）
        → provider.chatStream() → SSE tokens
        → 工具调用 → executeTool() → 写操作入审批队列
    → agent 完成后 saveAiSession(sessionId, projectId, messages)
  → SSE 响应流
```

### 1.2 核心文件

| 文件 | 职责 | 关键问题 |
|------|------|----------|
| [packages/ai/src/agent/index.ts](file:///d:/code/doc77/packages/ai/src/agent/index.ts) | DocAgent 类，ReAct 循环 | 内存 `messages[]`，无上下文管理，无中断/恢复 |
| [packages/ai/src/provider/index.ts](file:///d:/code/doc77/packages/ai/src/provider/index.ts) | OpenAI 兼容 API 客户端 | 无重试，无 token 计数，无错误恢复 |
| [packages/core/src/db/ai-sessions.ts](file:///d:/code/doc77/packages/core/src/db/ai-sessions.ts) | 会话持久化 | **整个对话存为单个 JSON blob**，无消息级查询 |
| [packages/core/src/server/app.ts](file:///d:/code/doc77/packages/core/src/server/app.ts) L3548+ | createAIChatHandler | 每次请求重建 agent，session 管理简陋 |
| [packages/ai/src/tools.ts](file:///d:/code/doc77/packages/ai/src/tools.ts) | 工具定义 | 硬编码 10 个工具，无 skill 扩展机制 |

### 1.3 用户痛点

| 痛点 | 根因 | 影响 |
|------|------|------|
| **不支持历史记录** | `ai_chat_sessions` 表存了 JSON blob，但前端没有历史列表 UI | 用户无法回顾过往对话 |
| **不支持多会话窗口** | 前端是单会话设计，无 tab 切换 | 无法并行处理多个文档任务 |
| **没有持久化** | 每次请求重建 agent，`setHistory` 只是塞回 JSON blob | 上下文丢失，工具调用记录不完整 |
| **对话规则乱** | 系统提示是静态 i18n 字符串，`addContext()` 追加第二个 system 消息（部分模型拒绝） | 模型行为不一致 |
| **无自定义能力** | 工具完全硬编码，无 skill / 规则系统 | 无法适配不同文档场景 |
| **无上下文管理** | 历史无限增长直到模型拒绝 | 长对话直接崩溃 |
| **无错误恢复** | 流式输出中断后状态不一致 | 需要重新开始对话 |

---

## 二、设计目标与原则

### 2.1 设计目标

1. **多会话管理** — 支持创建、切换、归档、搜索会话，每个会话独立上下文
2. **完整持久化** — 消息级存储，工具调用审计，会话恢复后上下文完整
3. **上下文管理** — 自动压缩长对话，支持 token 预算控制
4. **Skill 系统** — 用户可定义自定义技能（SKILL.md 机制），支持项目级规则
5. **MCP 增强** — 工具权限分级，human-in-the-loop 审批，多 server 编排
6. **对话分支** — 支持编辑消息重新发送、重新生成回复（树状消息结构）
7. **错误恢复** — 流式中断可恢复，工具失败可重试

### 2.2 设计原则

借鉴 Claude Code 的核心哲学：

1. **单线程主循环 + 扁平消息历史** — 避免多 agent swarm 的不可预测性
2. **渐进式披露** — Skill 只在相关时加载，避免上下文爆炸
3. **静态/动态提示分离** — 最大化 prompt caching 效益
4. **工具错误是结果而非异常** — 让 LLM 看到错误并自行决策
5. **检查点持久化** — 每轮迭代后自动持久化状态

---

## 三、架构总览

### 3.1 新架构分层

```
┌─────────────────────────────────────────────────────┐
│                    Frontend (Web UI)                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Chat Tab │ │ Session  │ │ Skill    │ │ Approval│ │
│  │ (多 Tab) │ │ Manager  │ │ Library  │ │  Queue  │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │
├───────┼────────────┼────────────┼────────────┼──────┤
│       │   REST API + SSE Stream  │            │      │
├───────┼────────────┼────────────┼────────────┼──────┤
│       ▼            ▼            ▼            ▼      │
│  ┌─────────────────────────────────────────────┐    │
│  │            AI Agent Runtime                 │    │
│  │  ┌───────────┐ ┌──────────┐ ┌───────────┐  │    │
│  │  │ AgentLoop │ │ Context  │ │  Skill    │  │    │
│  │  │ (Harness) │ │ Manager  │ │  Engine   │  │    │
│  │  └─────┬─────┘ └────┬─────┘ └─────┬─────┘  │    │
│  │        │            │              │        │    │
│  │  ┌─────▼────────────▼──────────────▼─────┐  │    │
│  │  │         Tool Router + Executor        │  │    │
│  │  └─────────────────┬────────────────────┘  │    │
│  └────────────────────┼───────────────────────┘    │
├───────────────────────┼────────────────────────────┤
│                       ▼                            │
│  ┌─────────────────────────────────────────────┐   │
│  │          Persistence Layer (SQLite)         │   │
│  │  sessions │ messages │ tool_logs │ skills   │   │
│  └─────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────┤
│                    MCP Layer                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐│
│  │  Doc FS  │ │ Search   │ │ Gallery  │ │ Custom ││
│  │  Server  │ │ Server   │ │ Server   │ │ Server ││
│  └──────────┘ └──────────┘ └──────────┘ └────────┘│
└─────────────────────────────────────────────────────┘
```

### 3.2 核心模块职责

| 模块 | 职责 | 对应现有代码 |
|------|------|-------------|
| **AgentLoop (Harness)** | 五层 ReAct 循环：上下文压缩 → 流式调用 → 工具执行 → 错误恢复 → 状态持久化 | 重写 DocAgent |
| **ContextManager** | 上下文窗口管理：token 计数、滑动窗口、LLM 压缩、工具结果微压缩 | 新增 |
| **SkillEngine** | Skill 发现、加载、激活：扫描 SKILL.md、渐进式披露、meta-tool 调用 | 新增 |
| **ToolRouter** | 工具路由：权限检查、只读/写分级、并发安全分类、human-in-the-loop | 扩展 executeTool |
| **SessionStore** | 会话 CRUD：树状消息、分支管理、全文搜索 | 重写 ai-sessions.ts |

---

## 四、数据库 Schema 重设计

### 4.1 新 Schema

当前 `ai_chat_sessions` 表将整个对话存为 JSON blob，无法查询、无法分支。重设计为消息级存储：

```sql
-- ============================================================
-- v8 迁移：AI 会话管理重设计
-- ============================================================

-- 会话表（替代旧的 ai_chat_sessions）
CREATE TABLE IF NOT EXISTS ai_sessions (
  id TEXT PRIMARY KEY,                    -- UUID
  project_id INTEGER,                     -- 关联项目（可空 = 全局对话）
  title TEXT DEFAULT '',                  -- 会话标题（首次对话后自动生成）
  status TEXT DEFAULT 'active',           -- active / archived / deleted
  parent_session_id TEXT,                 -- 分叉来源（压缩触发新会话时指向原会话）
  model TEXT,                             -- 使用的模型 ID
  system_prompt_hash TEXT,                -- 系统提示哈希（支持 prompt caching）
  current_leaf_id TEXT,                   -- 当前分支叶子消息 ID（树状对话核心）
  message_count INTEGER DEFAULT 0,        -- 消息计数（冗余，加速列表）
  tool_call_count INTEGER DEFAULT 0,      -- 工具调用总数
  input_tokens INTEGER DEFAULT 0,         -- 累计输入 token
  output_tokens INTEGER DEFAULT 0,        -- 累计输出 token
  pinned INTEGER DEFAULT 0,               -- 是否置顶
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_session_id) REFERENCES ai_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_project ON ai_sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_status ON ai_sessions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_pinned ON ai_sessions(pinned, updated_at DESC);

-- 消息表（树状结构，支持分支）
CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,                    -- UUID
  session_id TEXT NOT NULL,               -- 所属会话
  parent_id TEXT,                         -- 父消息 ID（NULL = 根消息）
  role TEXT NOT NULL,                     -- user / assistant / system / tool
  content TEXT NOT NULL,                  -- 消息文本内容
  raw_json TEXT,                          -- 完整原始 JSON（保留 tool_calls 等所有字段）
  tool_calls TEXT,                        -- JSON: 工具调用数组（assistant 消息）
  tool_call_id TEXT,                      -- 工具结果关联 ID（tool 角色消息）
  tool_name TEXT,                         -- 工具名称（tool 角色消息）
  reasoning TEXT,                         -- 推理过程（支持 thinking 模型）
  token_count INTEGER,                    -- 本条消息 token 数
  finish_reason TEXT,                     -- stop / tool_calls / length / error
  metadata TEXT DEFAULT '{}',             -- JSON: 模型 ID、附件、耗时等
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_messages_parent ON ai_messages(parent_id);

-- 工具调用审计表
CREATE TABLE IF NOT EXISTS ai_tool_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT,                        -- 触发工具的 assistant 消息 ID
  tool_name TEXT NOT NULL,
  input_json TEXT,                        -- 工具输入参数
  output_json TEXT,                       -- 工具输出结果
  elapsed_ms INTEGER,                     -- 执行耗时
  success INTEGER NOT NULL DEFAULT 1,     -- 1=成功 0=失败
  error_message TEXT,                     -- 失败时的错误信息
  approved_by TEXT,                       -- 审批人（写操作）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_logs_session ON ai_tool_logs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_logs_tool ON ai_tool_logs(tool_name);

-- Skill 注册表
CREATE TABLE IF NOT EXISTS ai_skills (
  id TEXT PRIMARY KEY,                    -- skill 名称（如 "pdf-form-filler"）
  source TEXT NOT NULL,                   -- builtin / project / user
  source_path TEXT,                       -- 文件系统路径（project/user skill）
  description TEXT NOT NULL,              -- 触发描述
  enabled INTEGER DEFAULT 1,             -- 是否启用
  globs TEXT,                             -- 适用文件模式（JSON 数组）
  always_apply INTEGER DEFAULT 0,        -- 是否总是注入 system prompt
  frontmatter_hash TEXT,                  -- YAML frontmatter 哈希（变更检测）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_skills_source ON ai_skills(source, enabled);

-- 上下文压缩记录表
CREATE TABLE IF NOT EXISTS ai_context_compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  strategy TEXT NOT NULL,                 -- snip / microcompact / autocompact
  before_tokens INTEGER,                  -- 压缩前 token 数
  after_tokens INTEGER,                   -- 压缩后 token 数
  compacted_message_ids TEXT,             -- JSON: 被压缩的消息 ID 列表
  summary TEXT,                           -- 压缩摘要（autocompact 时 LLM 生成）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
);

-- 消息全文搜索（FTS5，复用已有的检测+降级机制）
CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(
  content,
  content=ai_messages,
  content_rowid=rowid
);

-- FTS 同步触发器
CREATE TRIGGER IF NOT EXISTS ai_messages_fts_insert AFTER INSERT ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS ai_messages_fts_delete AFTER DELETE ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(ai_messages_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS ai_messages_fts_update AFTER UPDATE ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(ai_messages_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO ai_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

### 4.2 迁移策略

```typescript
// v8 迁移：保留旧表，新增新表，数据迁移脚本单独运行
export function migrateV8(db: DatabaseCompat): void {
  // 1. 创建新表（IF NOT EXISTS）
  db.exec(V8_SCHEMA_SQL);

  // 2. 迁移旧数据（ai_chat_sessions → ai_sessions + ai_messages）
  const oldSessions = db.prepare('SELECT * FROM ai_chat_sessions').all() as OldSession[];
  for (const old of oldSessions) {
    const messages = JSON.parse(old.messages) as AiMessage[];
    if (!messages || messages.length === 0) continue;

    // 创建新会话
    const sessionId = old.session_id;
    db.prepare(`INSERT OR IGNORE INTO ai_sessions (id, project_id, status, created_at, updated_at)
                VALUES (?, ?, 'archived', ?, ?)`)
      .run(sessionId, old.project_id, old.updated_at, old.updated_at);

    // 逐条插入消息（扁平结构，parent_id 串联）
    let parentId: string | null = null;
    for (const msg of messages) {
      const msgId = crypto.randomUUID();
      db.prepare(`INSERT INTO ai_messages (id, session_id, parent_id, role, content, raw_json, tool_calls, tool_call_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(msgId, sessionId, parentId, msg.role, msg.content || '',
             JSON.stringify(msg), msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
             msg.tool_call_id || null);
      parentId = msgId;
    }

    // 设置 current_leaf_id 为最后一条消息
    db.prepare('UPDATE ai_sessions SET current_leaf_id = ? WHERE id = ?').run(parentId, sessionId);
  }

  // 3. 不删除旧表（保留作为备份，后续手动清理）
}
```

---

## 五、会话管理设计

### 5.1 树状对话结构

借鉴 ChatGPT / Open WebUI 的树状消息模型：

```
消息树示例:

  user: "总结这个文档"
    │
    ├── assistant: "这是文档摘要..." (v1, 被编辑替代)
    │
    ├── assistant: "## 文档摘要\n..." (v2, 重新生成)
    │     │
    │     └── user: "翻译成英文"
    │           │
    │           └── assistant: "## Summary\n..." (当前分支)
    │
    └── user: "总结这个文档的核心要点" (编辑后重发)
          │
          └── assistant: "核心要点：..." (另一分支)
```

**数据模型**：

```typescript
interface MessageNode {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoning?: string;
  tokenCount?: number;
  finishReason?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  // 运行时计算（不存数据库）
  childrenIds?: string[];
}
```

**分支操作**：

| 操作 | 实现方式 |
|------|----------|
| 编辑用户消息 | 新建同 parent 的 sibling 消息，更新 `current_leaf_id` |
| 重新生成回复 | 新建同 parent 的 sibling assistant 消息，更新 `current_leaf_id` |
| 切换分支 | 更新 `session.current_leaf_id` 到目标分支叶子 |
| 获取当前路径 | 从 `current_leaf_id` 向上遍历到根，反转 |

### 5.2 会话生命周期

```
创建 → active → (归档) → archived → (删除) → deleted
  ↑                    │
  └─── 恢复 ──────────┘
```

**自动标题生成**：首次用户消息后，用轻量模型或简单规则生成标题（截取前 30 字符 + 省略号）。

**自动归档**：超过 30 天未更新的 active 会话自动转为 archived（可配置）。

### 5.3 会话恢复

```typescript
async function resumeSession(sessionId: string): Promise<DocAgent> {
  const session = getSession(sessionId);
  if (!session) throw new Error('Session not found');

  // 从 current_leaf_id 向上遍历，重建消息历史
  const messages = getMessagePath(sessionId, session.currentLeafId);

  // 重建 agent
  const agent = new DocAgent({ provider, tools, ... });
  agent.setHistory(messages);

  // 加载 skill 上下文
  const skills = getEnabledSkills(session.projectId);
  agent.loadSkills(skills);

  return agent;
}
```

---

## 六、Agent 循环重设计（Agent Harness）

### 6.1 五层架构

借鉴 Claude Code 的 Agent Harness Pattern，重写 DocAgent：

```
Layer 1: 上下文管理（API 调用前）
  ├── Tool Result Budget — 限制单条工具结果大小
  ├── Snip Compact — 移除陈旧中间历史
  ├── Microcompact — 压缩冗长工具输出
  └── Auto-Compact — LLM 驱动完整摘要（达 70% 上下文时触发）

Layer 2: 流式执行（API 调用中）
  ├── provider.chatStream() — SSE token 流
  ├── StreamingToolExecutor — 工具到达即执行（不等完整响应）
  └── 实时转向队列 — 允许用户中途注入指令

Layer 3: 恢复路径（API 调用后）
  ├── 模型不可用 → 降级备用模型
  ├── 工具错误 → 记录并继续（错误是结果，非异常）
  └── 系统错误 → 安全退出 + 状态持久化

Layer 4: 终止条件
  ├── 无 tool_use → 自然终止
  ├── 达到 maxSteps / token budget
  └── 用户中断信号

Layer 5: 状态持久化（每轮迭代后）
  ├── 消息写入 ai_messages 表
  ├── 工具调用写入 ai_tool_logs 表
  └── 会话元数据更新（token 计数、updated_at）
```

### 6.2 核心循环实现

```typescript
export class AgentLoop {
  private contextManager: ContextManager;
  private skillEngine: SkillEngine;
  private toolRouter: ToolRouter;
  private sessionStore: SessionStore;
  private interruptQueue: AsyncQueue<UserInterrupt>;  // 实时转向

  async *run(sessionId: string, userMessage: string): AsyncGenerator<AgentEvent> {
    const session = await this.sessionStore.get(sessionId);
    let messages = await this.sessionStore.getMessagePath(sessionId, session.currentLeafId);

    // 添加用户消息
    const userMsg = createMessage('user', userMessage);
    await this.sessionStore.appendMessage(sessionId, userMsg, session.currentLeafId);
    messages = [...messages, userMsg];

    let step = 0;
    while (step < session.maxSteps) {
      step++;

      // ── Layer 1: 上下文压缩 ──
      messages = await this.contextManager.compact(messages, {
        maxTokens: session.contextWindow,
        threshold: 0.7,
        onCompact: (summary, compactedIds) => {
          yield { type: 'context_compacted', summary, compactedCount: compactedIds.length };
        },
      });

      // ── 注入 Skill 上下文 ──
      const systemPrompt = this.skillEngine.buildSystemPrompt(session, messages);
      const apiMessages = [{ role: 'system', content: systemPrompt }, ...messages.filter(m => m.role !== 'system')];

      // ── Layer 2: 流式调用 + 工具执行 ──
      const toolExecutor = new StreamingToolExecutor(this.toolRouter, session);
      let assistantContent = '';
      const toolCalls: ToolCall[] = [];

      for await (const chunk of this.provider.chatStream({
        model: session.model,
        messages: apiMessages,
        tools: this.toolRouter.getToolDefinitions(session),
        stream: true,
      })) {
        if (chunk.type === 'token') {
          assistantContent += chunk.content;
          yield { type: 'token', content: chunk.content };
        } else if (chunk.type === 'tool_call') {
          toolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments });
          yield { type: 'tool_call', name: chunk.name, arguments: chunk.arguments };
          // 工具到达即执行（不等完整响应）
          toolExecutor.enqueue({ id: chunk.id, name: chunk.name, argsStr: chunk.arguments });
        } else if (chunk.type === 'done') {
          yield { type: 'done', usage: chunk.usage };
        } else if (chunk.type === 'error') {
          // ── Layer 3: 错误恢复 ──
          yield { type: 'error', message: chunk.message };
          // 持久化当前状态
          await this.sessionStore.update(sessionId, { status: 'error' });
          return;
        }

        // 检查实时转向队列
        if (this.interruptQueue.peek()) {
          const interrupt = this.interruptQueue.dequeue();
          if (interrupt.type === 'cancel') break;
          if (interrupt.type === 'inject') {
            messages.push({ role: 'user', content: interrupt.message });
          }
        }
      }

      // 持久化 assistant 消息
      const assistantMsg = createMessage('assistant', assistantContent, { toolCalls });
      await this.sessionStore.appendMessage(sessionId, assistantMsg, userMsg.id);

      // ── 无工具调用 → 自然终止 ──
      if (toolCalls.length === 0) {
        yield { type: 'complete', finishReason: 'stop' };
        return;
      }

      // ── 等待工具执行完成 ──
      for await (const result of toolExecutor.results()) {
        await this.sessionStore.appendMessage(sessionId, {
          role: 'tool',
          content: result.output,
          toolCallId: result.toolCallId,
          toolName: result.toolName,
        }, assistantMsg.id);
        yield { type: 'tool_result', toolName: result.toolName, output: result.output, success: result.success };
      }

      messages = await this.sessionStore.getMessagePath(sessionId, assistantMsg.id);
    }

    yield { type: 'complete', finishReason: 'max_steps' };
  }
}
```

### 6.3 上下文管理策略

```typescript
export class ContextManager {
  /**
   * 四层压缩管线（借鉴 Claude Code）
   */
  async compact(messages: AiMessage[], opts: CompactOpts): Promise<AiMessage[]> {
    let result = messages;

    // Layer 1: Tool Result Budget — 限制单条工具结果
    result = this.applyToolResultBudget(result, MAX_TOOL_RESULT_TOKENS);

    // Layer 2: Snip Compact — 移除超过 N 轮的中间历史
    result = this.snipCompact(result, { keepLastN: 10 });

    // Layer 3: Microcompact — 压缩超长工具输出
    result = await this.microcompact(result, opts);

    // Layer 4: Auto-Compact — 达到阈值时 LLM 摘要
    const tokenCount = this.estimateTokens(result);
    if (tokenCount > opts.maxTokens * opts.threshold) {
      result = await this.autoCompact(result, opts);
    }

    return result;
  }

  /**
   * 工具结果预算：截断超长工具输出
   */
  private applyToolResultBudget(messages: AiMessage[], maxTokens: number): AiMessage[] {
    return messages.map(msg => {
      if (msg.role === 'tool' && this.estimateTokens(msg.content) > maxTokens) {
        return {
          ...msg,
          content: msg.content.slice(0, maxTokens * 4) +
            `\n\n[... truncated by context manager, original ${msg.content.length} chars]`,
        };
      }
      return msg;
    });
  }

  /**
   * LLM 驱动的自动压缩
   */
  private async autoCompact(messages: AiMessage[], opts: CompactOpts): Promise<AiMessage[]> {
    const systemMsg = messages.find(m => m.role === 'system');
    const recentMsgs = messages.slice(-opts.keepLastN || 10);
    const oldMsgs = messages.slice(0, -opts.keepLastN || 10);

    // 调用 LLM 生成摘要
    const summary = await this.provider.chat({
      model: 'compact-model',  // 使用轻量模型
      messages: [{
        role: 'user',
        content: `请将以下对话历史压缩为简洁摘要，保留：
1. 已做决策
2. 已建立的文件操作承诺
3. 已确认的事实
4. 未解决的问题

对话历史：
${JSON.stringify(oldMsgs.map(m => ({ role: m.role, content: m.content.slice(0, 500) })))}`,
      }],
    });

    const summaryMsg: AiMessage = {
      role: 'system',
      content: `[对话摘要]\n${summary.message.content}`,
    };

    opts.onCompact?.(summary.message.content, oldMsgs.map(m => m.id));

    return [systemMsg, summaryMsg, ...recentMsgs].filter(Boolean) as AiMessage[];
  }
}
```

---

## 七、Skill 系统设计

### 7.1 Skill 目录结构

借鉴 Claude Code 的 SKILL.md 机制 + Cursor Rules 的项目规则：

```
项目根目录/
├── .doc77/
│   └── skills/                    -- 项目级 skill
│       ├── pdf-form-filler/
│       │   ├── SKILL.md           -- 必需：指令 + YAML frontmatter
│       │   └── scripts/
│       │       └── fill_form.py
│       └── doc-translation/
│           └── SKILL.md
├── .doc77/
│   └── rules/                     -- 项目规则（类似 .cursor/rules）
│       ├── coding-style.mdc       -- 编码风格规则
│       └── doc-conventions.mdc    -- 文档规范规则
└── ...

用户全局目录 (~/.doc77/skills/)     -- 全局 skill，跨项目可用
└── markdown-linter/
    └── SKILL.md
```

### 7.2 SKILL.md 格式

```yaml
---
name: pdf-form-filler
description: >-
  PDF 表单填写与处理工具。当需要从 PDF 提取文本和表格、
  创建新 PDF、合并/拆分文档、处理表单时使用。
  适用于文档工作流和批量操作。不适用于简单 PDF 查看。
globs:                           # 可选：适用文件模式
  - "docs/**/*.pdf"
  - "contracts/**/*.pdf"
always_apply: false              # 可选：是否总是注入（默认 false）
allowed_tools:                   # 可选：限制可调用的工具
  - read_file
  - write_file
  - list_files
---

# PDF 表单处理

## 快速开始
使用 pdfplumber 从 PDF 提取文本...

## 高级表单填写
参见 [FORMS.md](FORMS.md) 获取详细指令。
```

### 7.3 Skill Engine 实现

```typescript
export class SkillEngine {
  private skills: Map<string, Skill> = new Map();

  /**
   * 启动时扫描所有 skill 目录，预加载 frontmatter（渐进式披露第一层）
   */
  async scanSkills(projectPath: string): Promise<void> {
    const skillDirs = [
      path.join(projectPath, '.doc77', 'skills'),   // 项目级
      path.join(os.homedir(), '.doc77', 'skills'),   // 全局级
      path.join(__dirname, 'builtin', 'skills'),     // 内置
    ];

    for (const dir of skillDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        const raw = fs.readFileSync(skillFile, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);

        this.skills.set(frontmatter.name, {
          name: frontmatter.name,
          description: frontmatter.description,
          globs: frontmatter.globs || [],
          alwaysApply: frontmatter.always_apply || false,
          allowedTools: frontmatter.allowed_tools,
          body,                              // 正文（第二层，按需加载）
          dir: path.join(dir, entry.name),   // 附加资源（第三层）
          source: this.classifySource(dir, projectPath),
        });
      }
    }

    // 同步到数据库
    await this.syncToDatabase();
  }

  /**
   * 构建系统提示（静态/动态分离）
   */
  buildSystemPrompt(session: Session, messages: AiMessage[]): string {
    const parts: string[] = [t('ai.systemPrompt')];  // 基础系统提示

    // always_apply skill → 直接注入
    for (const skill of this.skills.values()) {
      if (skill.alwaysApply) {
        parts.push(`\n## Skill: ${skill.name}\n${skill.body}`);
      }
    }

    // 项目规则（.doc77/rules/*.mdc）
    const rules = this.loadProjectRules(session.projectId);
    for (const rule of rules) {
      parts.push(`\n## Project Rule: ${rule.name}\n${rule.body}`);
    }

    // 可用 skill 清单（渐进式披露第一层：仅 name + description）
    const availableSkills = [...this.skills.values()]
      .filter(s => !s.alwaysApply)
      .map(s => `- ${s.name}: ${s.description}`)
      .join('\n');
    if (availableSkills) {
      parts.push(`\n## 可用技能\n以下技能可通过 Skill 工具调用：\n${availableSkills}`);
    }

    return parts.join('\n');
  }

  /**
   * Meta-tool：Skill 调用入口（渐进式披露第二层）
   */
  async invokeSkill(skillName: string, context: SkillContext): Promise<string> {
    const skill = this.skills.get(skillName);
    if (!skill) return `Error: Skill "${skillName}" not found`;

    // 加载完整 SKILL.md 正文 + 附加文件
    const fullBody = await this.loadFullSkill(skill);

    // 权限检查
    if (skill.allowedTools && context.toolName) {
      if (!skill.allowedTools.includes(context.toolName)) {
        return `Error: Skill "${skillName}" does not allow tool "${context.toolName}"`;
      }
    }

    return `[Skill: ${skillName}]\n${fullBody}`;
  }
}
```

### 7.4 内置 Skill 示例

```yaml
# builtin/skills/doc-summarize/SKILL.md
---
name: doc-summarize
description: >-
  文档智能摘要。当需要总结文档核心内容、提取关键信息、
  生成文档大纲时使用。适用于长文档阅读和理解场景。
  支持 Markdown、纯文本、代码文档。
always_apply: false
---

# 文档摘要技能

## 摘要原则
1. 保留核心论点和关键数据
2. 移除冗余示例和过渡语句
3. 按原文结构组织摘要
4. 中文文档用中文摘要，英文文档用英文摘要

## 摘要格式
### 核心要点
- 要点 1
- 要点 2

### 详细摘要
（按章节组织的摘要）

### 关键数据
- 数据点 1: 值
- 数据点 2: 值
```

---

## 八、MCP 集成增强

### 8.1 工具权限分级

```typescript
export type ToolPermission = 'read' | 'write' | 'destructive';

export interface ToolAnnotation {
  name: string;
  permission: ToolPermission;
  concurrencySafe: boolean;  // 是否可并发执行
  requiresApproval: boolean; // 是否需要 human-in-the-loop
}

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotation> = {
  // 只读工具 — 自动执行，可并发
  list_files:        { name: 'list_files',        permission: 'read',       concurrencySafe: true,  requiresApproval: false },
  read_file:         { name: 'read_file',         permission: 'read',       concurrencySafe: true,  requiresApproval: false },
  get_file_info:     { name: 'get_file_info',     permission: 'read',       concurrencySafe: true,  requiresApproval: false },
  list_projects:     { name: 'list_projects',     permission: 'read',       concurrencySafe: true,  requiresApproval: false },
  search_files:      { name: 'search_files',      permission: 'read',       concurrencySafe: true,  requiresApproval: false },

  // 写工具 — 需审批，串行执行
  write_file:        { name: 'write_file',        permission: 'write',      concurrencySafe: false, requiresApproval: true },
  move_file:         { name: 'move_file',         permission: 'write',      concurrencySafe: false, requiresApproval: true },
  create_folder:     { name: 'create_folder',     permission: 'write',      concurrencySafe: false, requiresApproval: true },

  // 破坏性工具 — 强制审批 + 二次确认
  delete_file:       { name: 'delete_file',       permission: 'destructive',concurrencySafe: false, requiresApproval: true },
  batch_operations:  { name: 'batch_operations',  permission: 'write',      concurrencySafe: false, requiresApproval: true },
};
```

### 8.2 Tool Router 实现

```typescript
export class ToolRouter {
  /**
   * 路由工具调用，根据权限决定执行策略
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    session: Session,
  ): Promise<ToolResult> {
    const annotation = TOOL_ANNOTATIONS[toolName];
    if (!annotation) {
      return { success: false, output: `Error: Unknown tool "${toolName}"` };
    }

    // 敏感文件检查
    if (args.file_path && isSensitiveFile(args.file_path)) {
      return { success: false, output: `Error: Access denied — "${args.file_path}" is sensitive` };
    }

    // 写操作 → 入审批队列（现有机制保留）
    if (annotation.permission === 'write' || annotation.permission === 'destructive') {
      return await this.enqueueWriteTask(toolName, args, session);
    }

    // 只读操作 → 直接执行
    return await this.executeReadTool(toolName, args, session);
  }

  /**
   * 批量执行工具（只读并发，写串行）
   */
  async executeBatch(
    calls: Array<{ name: string; args: Record<string, unknown> }>,
    session: Session,
  ): Promise<ToolResult[]> {
    const readCalls = calls.filter(c => TOOL_ANNOTATIONS[c.name]?.concurrencySafe);
    const writeCalls = calls.filter(c => !TOOL_ANNOTATIONS[c.name]?.concurrencySafe);

    // 只读工具并发执行
    const readResults = await Promise.all(
      readCalls.map(c => this.execute(c.name, c.args, session)),
    );

    // 写工具串行执行
    const writeResults: ToolResult[] = [];
    for (const call of writeCalls) {
      writeResults.push(await this.execute(call.name, call.args, session));
    }

    return [...readResults, ...writeResults];
  }
}
```

---

## 九、API 设计

### 9.1 会话管理 API

```
POST   /api/ai/sessions                    创建会话
GET    /api/ai/sessions                    列出会话（支持 ?project_id=&status=&q= 过滤）
GET    /api/ai/sessions/:id                获取会话详情
PATCH  /api/ai/sessions/:id                更新会话（标题、置顶、状态）
DELETE /api/ai/sessions/:id                删除会话（软删除）
POST   /api/ai/sessions/:id/branch         从指定消息分叉新会话
GET    /api/ai/sessions/:id/messages       获取消息树
GET    /api/ai/sessions/:id/messages/path  获取当前分支消息路径
POST   /api/ai/sessions/:id/messages/:msgId/regenerate  重新生成回复
```

### 9.2 对话 API（SSE）

```
POST   /api/ai/chat                        发送消息（SSE 流式响应）
  Body: { session_id, message, project_id?, context_file? }
  Events:
    - session    { session_id }            会话 ID（新会话时返回）
    - token      { text }                  文本 token
    - tool_call  { name, arguments }       工具调用
    - tool_result { name, output, success } 工具结果
    - context_compacted { summary, count } 上下文压缩通知
    - skill_activated { name }             Skill 激活
    - done       { finish_reason, usage }  完成
    - error      { message }               错误

POST   /api/ai/chat/interrupt              中断当前对话
  Body: { session_id, type: 'cancel' | 'inject', message? }
```

### 9.3 Skill 管理 API

```
GET    /api/ai/skills                      列出所有 skill
GET    /api/ai/skills/:id                  获取 skill 详情
POST   /api/ai/skills/:id/enable           启用 skill
POST   /api/ai/skills/:id/disable          禁用 skill
POST   /api/ai/skills/reload               重新扫描 skill 目录
```

### 9.4 搜索 API

```
GET    /api/ai/search?q=keyword            全文搜索会话消息
  Response: { results: [{ session_id, message_id, snippet, highlight }] }
```

---

## 十、前端设计

### 10.1 多会话 Tab 界面

```
┌──────────────────────────────────────────────────────────┐
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                    │
│ │ 通信1 │ │ 通信2 │ │ 通信3 │ │  +   │  ← 会话 Tab 栏   │
│ └──────┘ └──────┘ └──────┘ └──────┘                    │
├──────────────────────────────────────────────────────────┤
│  ┌─侧边栏─┐  ┌─────────── 对话区域 ──────────────────┐ │
│  │        │  │  user: 总结这个文档                    │ │
│  │ 历史   │  │  assistant: ## 文档摘要 ...            │ │
│  │ 会话   │  │    └─ [重新生成] [编辑]                │ │
│  │ 列表   │  │  user: 翻译成英文                      │ │
│  │        │  │  assistant: ## Summary ...             │ │
│  │ ─────  │  │                                         │ │
│  │ 技能   │  │  ┌─────────────────────────────────┐  │ │
│  │ 库     │  │  │ 输入消息...           [发送]     │  │ │
│  │        │  │  └─────────────────────────────────┘  │ │
│  │ ─────  │  └─────────────────────────────────────────┘ │
│  │ 审批   │                                              │
│  │ 队列   │                                              │
│  └────────┘                                              │
└──────────────────────────────────────────────────────────┘
```

### 10.2 消息分支 UI

```
assistant: ## 文档摘要... (2/3)  ← [‹] [2/3] [›]
  ┌─ [重新生成] [编辑消息] ─┐
```

- `[‹]` / `[›]` 切换分支
- `2/3` 当前是第 2 个变体，共 3 个
- `[重新生成]` 创建新分支
- `[编辑消息]` 编辑用户消息并创建新分支

### 10.3 Skill 库 UI

```
┌─ 技能库 ─────────────────────────────────┐
│                                          │
│ 🔍 [搜索技能...]                         │
│                                          │
│ ── 内置技能 ──                           │
│ ☑ doc-summarize      文档智能摘要        │
│ ☑ doc-translation    文档翻译            │
│ ☐ doc-lint           文档规范检查        │
│                                          │
│ ── 项目技能 (.doc77/skills) ──           │
│ ☑ pdf-form-filler    PDF 表单填写        │
│ ☐ custom-workflow    自定义工作流        │
│                                          │
│ ── 全局技能 (~/.doc77/skills) ──         │
│ ☑ markdown-linter    Markdown 规范检查   │
│                                          │
│ ── 项目规则 (.doc77/rules) ──            │
│ 📄 coding-style.mdc  编码风格规则        │
│ 📄 doc-conventions.mdc 文档规范规则      │
│                                          │
│ [重新扫描]  [创建技能]                   │
└──────────────────────────────────────────┘
```

---

## 十一、实施路线图

### Phase 1：数据库与持久化（1-2 天）

- [ ] v8 迁移：创建 `ai_sessions` / `ai_messages` / `ai_tool_logs` / `ai_skills` / `ai_context_compactions` 表
- [ ] 实现 `SessionStore` 类（CRUD + 消息树遍历 + 分支操作）
- [ ] 旧数据迁移脚本（`ai_chat_sessions` JSON blob → 消息级存储）
- [ ] FTS5 全文搜索（复用已有的检测+降级机制）

### Phase 2：会话管理 API（1 天）

- [ ] 会话 CRUD API（`/api/ai/sessions`）
- [ ] 消息树 API（`/api/ai/sessions/:id/messages`）
- [ ] 分支操作 API（`/branch`、`/regenerate`）
- [ ] 会话搜索 API（`/api/ai/search`）

### Phase 3：Agent 循环重写（2-3 天）

- [ ] `AgentLoop` 类（五层 Harness 架构）
- [ ] `ContextManager` 类（四层压缩管线）
- [ ] `StreamingToolExecutor`（工具到达即执行）
- [ ] 实时转向队列（中断 + 注入）
- [ ] 状态持久化（每轮迭代后写入 DB）

### Phase 4：Skill 系统（2 天）

- [ ] `SkillEngine` 类（扫描、加载、激活）
- [ ] SKILL.md 解析器（YAML frontmatter + body）
- [ ] 项目规则加载（`.doc77/rules/*.mdc`）
- [ ] Meta-tool `Skill` 注册与调用
- [ ] Skill 管理 API

### Phase 5：前端 UI（2-3 天）

- [ ] 多会话 Tab 界面
- [ ] 侧边栏历史会话列表
- [ ] 消息分支 UI（`[‹] 2/3 [›]` + 重新生成 + 编辑）
- [ ] Skill 库管理界面
- [ ] 对话中断/注入 UI

### Phase 6：MCP 增强（1 天）

- [ ] `ToolRouter` 类（权限分级 + 并发安全）
- [ ] 工具注解系统
- [ ] 批量工具执行（只读并发，写串行）

### Phase 7：测试与文档（1 天）

- [ ] 更新 live-e2e 测试用例（覆盖多会话、分支、Skill）
- [ ] 单元测试（SessionStore、ContextManager、SkillEngine）
- [ ] 用户文档更新
- [ ] 记忆更新

**预估总工期**：10-13 天

---

## 十二、参考资源

### 调研来源

- **Claude Code v1.0.33** 逆向工程分析 — Agent Loop、上下文管理、工具执行、Skill 系统
- **Anthropic 官方 Agent Skills 文档** + agentskills.io 开放标准 — SKILL.md 机制
- **Cursor Cloud Agents** — Temporal 工作流编排、规则系统（.cursor/rules/*.mdc）
- **MCP 官方规范 2025-06-18** + Best Practices 指南 — 工具注解、权限分级
- **LangGraph** interrupt/resume 模式 — Human-in-the-loop 审批
- **AgentScope 1.0** — ReAct 治理框架、消息抽象
- **ChatGPT / Open WebUI** — 树状对话数据结构实践

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 消息存储 | 消息级 SQLite 表（非 JSON blob） | 支持查询、分支、FTS 搜索 |
| 对话结构 | 树状（parentId + currentLeafId） | 支持编辑重发、重新生成 |
| 上下文管理 | 四层压缩管线 | 渐进式处理，避免突然崩溃 |
| Skill 机制 | SKILL.md + 渐进式披露 | 业界标准，支持社区生态 |
| 工具权限 | 三级（read/write/destructive） | 安全与效率平衡 |
| Agent 循环 | 五层 Harness | 生产级可靠性 |
| 持久化 | 每轮迭代后自动写入 | 中断可恢复 |

# Doc77 完整设计方案

## 文档版本：v2.5  
## 更新日期：2026-07-07  
## 修订说明：  
- **Technology Stack 全面升级**：Node.js >= 22.x, Express ^5.x, better-sqlite3 ^12.x, marked ^17.x, Mermaid ^11.x, PDF.js ^5.x
- **补充缺失依赖**：MCP SDK, AI SDK, monorepo tool (pnpm workspaces), build tool (tsup), test framework (vitest), TS executor (tsx), logger (pino)
- **Architecture 图修正**：MCP Service Layer 独立为 peer package，与 Preview Engine 平级
- **MCP Protocol 升级**：2024-11-05 → 2025-11-25，利用 Tasks primitive 实现 approval queue
- **新增 Session Management 设计**：server 端生成 token，SQLite 持久化，rate limiting 绑定已验证 session
- **重构 Project Lock**：SQLite 持久化 + heartbeat + 可配置 timeout + CLI 可观测
- **安全增强**：localhost binding、可选 shared-secret token、write rate limiting、safeMove UUID 临时文件
- **Shadow GC 增强**：新增 runtime 周期性 GC，delete 操作始终 shadow
- **补充 Internal Event Bus 接口定义**、MCP Transport 兼容说明、Batch Operation 语义
- **完善前端架构细节**：client library 加载策略、state management 方案  


## 一、项目概述

### 1.1 项目定义

> **Doc77 是一个“默认安全、对话驱动”的智能本地文档管理 Agent。**
>
> 它**只读时**是轻量级多项目预览器；**写入时**是受你控制的智能管家。通过 MCP 连接 AI 大脑，通过用户确认守卫本地文件安全。

### 1.2 核心定位

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Doc77 核心定位                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   📋 定位一：多项目文档陈列馆（只读）                                   │
│   ─────────────────────────────────────────────                         │
│   • 注册本地项目目录，Dashboard 统一管理                               │
│   • Markdown/PDF/图片 原生预览                                         │
│   • 开会时快速对齐文档                                                 │
│                                                                         │
│   🔧 定位二：本地文件操作桥梁（读写）                                   │
│   ─────────────────────────────────────────────                         │
│   • 通过 MCP 协议暴露文件操作工具集                                    │
│   • AI 可读取、分析、规划文件变更                                      │
│   • 所有写操作需用户审批（默认）或审计（Auto 模式）                    │
│                                                                         │
│   🤖 定位三：对话驱动的智能管理 Agent（决策辅助）                      │
│   ─────────────────────────────────────────────                         │
│   • 自然语言对话驱动文档管理                                           │
│   • AI 分析目录结构，生成归类/移动/删除建议                           │
│   • 操作队列可视化，用户逐条审批执行                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.3 设计哲学（五原则）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Doc77 设计哲学（五原则）                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ① 文档留在原地  → 绝不复制/上传用户文件，只读路径                     │
│  ② 预览 ≠ 编辑   → 编辑交给专业工具，预览交给 doc77                   │
│  ③ 注册即管理    → 一次注册，永久记住，点开即用                       │
│  ④ 轻量优先      → 单进程、SQLite、零配置、开箱即用                   │
│  ⑤ 对话驱动      → 自然语言交互，AI 辅助，用户决策                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```


## 二、系统整体架构

### 2.1 三层架构图（细化模块共享关系）

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           用户交互层                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐                 │
│  │   Terminal CLI   │  │   Web GUI        │  │   第三方 MCP     │                 │
│  │   (技术用户)     │  │   (所有用户)     │  │   客户端         │                 │
│  │                  │  │                  │  │   (Claude等)     │                 │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘                 │
└───────────┼────────────────────┼────────────────────┼─────────────────────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                    @doc77/core（核心引擎）+ @doc77/mcp（MCP 服务层）                 │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                         预览引擎 (Preview Engine)                             │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │  │  Markdown   │  │   Mermaid   │  │   PDF.js    │  │  Highlight  │       │  │
│  │  │  渲染器     │  │  图表渲染   │  │  预览器     │  │  代码高亮   │       │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │           MCP 服务层 (读写桥梁 + 安全 + 队列 + 审计 + 事务回滚)               │  │
│  │                           — @doc77/mcp                                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │  │  工具注册   │  │  权限拦截   │  │  操作队列   │  │  审计日志   │       │  │
│  │  │  中心       │  │  安全守卫   │  │  审批流     │  │  记录器     │       │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐    │  │
│  │  │      事务管理器 (Pre-flight · Shadow · Rollback · Runtime GC)      │    │  │
│  │  └────────────────────────────────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                   文件系统抽象层 (共享读写，含 safeMove)                     │  │
│  │  • 目录扫描器（按需/懒加载） • 文件读取器 • 文件写入器 • 路径安全校验器      │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │               Internal Event Bus (共享 EventEmitter，跨包事件通信)             │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────┘
            │                                    │
            ▼                                    ▼
┌─────────────────────────────┐  ┌──────────────────────────────────────────────────┐
│        数据存储层            │  │              外部依赖                            │
│  ┌───────────────────────┐  │  │  ┌─────────────┐  ┌────────────────────────┐  │
│  │  SQLite 数据库        │  │  │  │ 本地文件系统 │  │  AI API (用户自配Key)  │  │
│  │  ~/.doc77/data.db     │  │  │  │ (只读/写入)  │  │  OpenAI / 国内兼容     │  │
│  └───────────────────────┘  │  │  └─────────────┘  └────────────────────────┘  │
│  • projects 表              │  │                                               │
│  • config 表                │  │  ┌─────────────┐  ┌────────────────────────┐  │
│  • filetree_cache 表        │  │  │ 外部编辑器   │  │  MCP 客户端           │  │
│  • audit_log 表             │  │  │ (协议跳转)   │  │  (Claude Desktop等)   │  │
│  • operation_queue 表       │  │  └─────────────┘  └────────────────────────┘  │
│  • sessions 表              │  │                                               │
│  • project_locks 表         │  └──────────────────────────────────────────────────┘
└─────────────────────────────┘  └──────────────────────────────────────────────────┘
```

### 2.2 核心模块关系与内部调用

```
预览引擎 ──(调用)──▶ 文件系统抽象层
MCP 只读工具 ──(调用)──▶ 文件系统抽象层
MCP 写入工具 ──(入队)──▶ 操作队列 ──(审批后调用)──▶ 事务管理器 ──▶ 文件系统抽象层
AI Agent ──(内部API)──▶ MCP 服务层 (读写)
MCP 服务层 ──(EventBus)──▶ AI 模块 (任务结果通知)
AI 模块 ──(EventBus)──▶ Web UI (SSE 推送任务生命周期事件)
Web 对话区 ──(REST)──▶ Express 服务 (/api/ai/chat) ──(内部API)──▶ @doc77/ai
外部 MCP 客户端 ──(stdio / Streamable HTTP)──▶ MCP 协议适配器 ──(内部API)──▶ MCP 服务层
```


## 三、模块一：预览引擎（@doc77/core）

### 3.1 模块职责

> **预览引擎是 doc77 的只读核心，负责将本地文档转化为 Web 可预览的内容。**

#### 前端架构说明

虽然前端使用原生 HTML + CSS + JS（零构建），但依赖以下 browser-side library：
- **marked, Mermaid, PDF.js, highlight.js** 通过 CDN（jsDelivr / unpkg）或 Express static middleware 加载
- 前端状态管理采用自定义 event-driven 模式：所有 UI 组件通过 `CustomEvent` 通信
- SSE 连接接收 task lifecycle event（`queued`, `executing`, `executed`, `failed`），实时更新 approval queue UI
- 降级方案：SSE 断开后，前端通过 `GET /api/queue/status?session_id=xxx` 轮询对账

| 能力 | 说明 |
| :--- | :--- |
| **项目注册与管理** | 通过 CLI/Web 注册本地目录，SQLite 持久化 |
| **目录扫描** | 按需/懒加载扫描项目目录，生成树形结构 |
| **Markdown 渲染** | 完美支持 GFM，含表格/任务列表/脚注 |
| **图表渲染** | Mermaid 流程图/时序图/甘特图 |
| **代码高亮** | highlight.js 支持主流编程语言 |
| **PDF 预览** | PDF.js 渲染，支持页码跳转 |
| **图片预览** | JPG/PNG/SVG 原生渲染 |
| **文件操作** | 自定义协议跳转外部编辑器 / 在文件夹中显示 |
| **AI 对话快捷入口** | 预览页提供“🤖 对此文件对话”按钮，跳转至对话工作区并预填上下文 |

### 3.2 技术栈

| 组件 | 技术选型 | 说明 |
| :--- | :--- | :--- |
| 运行时 | Node.js >= 22.x | LTS 支持至 2027-10，使用原生 fetch 和 File API |
| 语言 | TypeScript ^5.8 | 类型安全 |
| 数据库 | better-sqlite3 ^12.x | 嵌入式 SQLite，含 Node 22+ prebuilt binary |
| Web 框架 | Express ^5.x | HTTP 服务 |
| MCP SDK | @modelcontextprotocol/sdk ^1.x | MCP 协议实现，后续可迁移至 v2 |
| AI SDK | openai ^5.x（或兼容 SDK） | AI API 调用，含 tool-use 支持 |
| 构建工具 | tsup ^8.x | TypeScript 编译打包 |
| TS 执行器 | tsx ^4.x | 开发时直接运行 TypeScript |
| 测试框架 | vitest ^3.x | 单元测试 / 集成测试 |
| 日志 | pino ^9.x | 结构化 operational logging |
| Markdown | marked ^17.x | 浏览器端渲染 |
| 图表 | Mermaid ^11.x | 浏览器端渲染 |
| PDF | PDF.js ^5.x | 浏览器端渲染 |
| 代码高亮 | highlight.js ^11.x | 浏览器端渲染 |
| 前端 | 原生 HTML + CSS + JS | client library 通过 CDN 或 Express static 加载 |

### 3.3 目录扫描策略（按需/懒加载）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     目录扫描策略（按需/懒加载）                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  原则：                                                                 │
│  1. 默认不扫描任何目录，只展示已注册的项目列表                          │
│  2. 扫描由用户主动触发（注册时 / 点击文件夹时 / 手动刷新）             │
│  3. 扫描范围由用户指定（注册时选定目录）                                │
│  4. 扫描结果缓存，避免重复扫描                                          │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 场景 A: 注册项目时浅层扫描                                      │    │
│  │ doc77 register ./my-project                                    │    │
│  │   → 只读取根目录的直接子项（不递归）                           │    │
│  │   → 展示项目卡片，显示文档数量                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 场景 B: 点击文件夹时按需加载（核心交互）                        │    │
│  │ 用户点击 ▸ 技术文档 文件夹                                      │    │
│  │   → 只读取 "技术文档" 目录下的直接子项                         │    │
│  │   → 不递归读取子文件夹内容                                      │    │
│  │   → 点击子文件夹时继续加载                                      │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 场景 C: 手动刷新（用户主动触发）                                │    │
│  │ 用户点击 "🔄 刷新" 按钮                                         │    │
│  │   → 清空该项目缓存                                              │    │
│  │   → 重新从根目录按需加载                                        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  忽略规则（默认）：                                                     │
│  .git, node_modules, .DS_Store, Thumbs.db, __pycache__, .idea, .vscode │
│  用户可自定义 .doc77ignore 文件                                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.4 外部编辑器跳转设计

在 `~/.doc77/config.json` 中增加 editor 配置：
```json
{
  "editor": {
    "default": "vscode",
    "commands": {
      "vscode": "vscode://file/{path}",
      "sublime": "subl://open?url=file://{path}",
      "typora": "typora://open/{path}",
      "finder": "file://{path}"
    }
  }
}
```

- 统一路径编码 `encodeURIComponent`，解决特殊字符问题。
- 系统检测：Windows 优先 `vscode://file/{path}`，macOS 可同时支持 `vscode://` 和 `finder`。
- 降级方案：若协议无法打开，执行“在文件管理器中显示”（`open -R` / `explorer /select,`）。

预览区右上角工具栏：
- `📝 在编辑器中打开` → 构造协议 URL 尝试打开，失败则提示用户。
- `📂 在文件夹中显示` → 调用后端 API `/api/reveal/:id?path=...`，后端执行系统命令打开并选中文件。

### 3.5 API 接口

| 方法 | 路径 | 功能 |
| :--- | :--- | :--- |
| GET | `/api/projects` | 获取所有已注册项目 |
| POST | `/api/projects` | 注册新项目 |
| DELETE | `/api/projects/:id` | 移除项目 |
| GET | `/api/tree/:id` | 获取目录树（支持 ?path=xxx 按需加载） |
| GET | `/api/content/:id` | 获取文件内容（支持 ?path=xxx） |
| GET | `/api/status` | 获取服务状态 |
| GET | `/api/reveal/:id` | 在系统文件管理器中打开文件位置（?path=xxx） |
| GET | `/api/health` | 健康检查端点（返回 DB 状态, active locks, session 数） |
| GET | `/api/queue/status` | 查询任务队列状态（?session_id=xxx） |


## 四、模块二：MCP 服务层（含操作队列审批流）

### 4.1 模块职责

> **MCP 服务层是 doc77 的读写控制中枢，包含工具注册、安全校验、操作队列审批流、事务回滚和审计日志。所有外部写入请求均通过此层进入审批/执行流程。**

| 能力 | 说明 |
| :--- | :--- |
| **工具注册** | 暴露 8 个标准 MCP 工具（读/写/改/删） |
| **权限拦截** | 校验路径是否在已注册项目范围内 |
| **安全守卫** | 拦截写操作，送入操作队列等待审批 |
| **操作队列审批流** | 管理待执行的操作指令，提供 CLI/Web 审批入口 |
| **事务回滚** | 轻量级文件事务，确保批量操作失败时自动回滚 |
| **审计日志** | 记录所有写操作，支持回溯 |

### 4.2 MCP 工具定义（符合 MCP 协议规范）

服务器名称：`doc77`，协议版本：`2025-11-25`（支持 Tasks primitive，向后兼容 2024-11-05 客户端）

#### 只读工具（无需审批）

| 工具名 | 描述 | 参数 Schema |
| :--- | :--- | :--- |
| `list_files` | 列出项目指定路径下的文件和文件夹 | `project_id` (integer), `path` (string), `depth` (integer, 可选, 默认1) |
| `read_file` | 读取指定文件内容（仅限已注册项目内，排除敏感文件） | `project_id` (integer), `file_path` (string) |
| `get_file_info` | 获取文件元数据（大小、修改时间） | `project_id` (integer), `file_path` (string) |

> **`list_files` 强制返回每个文件节点的 `size` 字段（字节），示例：**
> ```json
> {
>   "name": "大型视频.mp4",
>   "type": "file",
>   "size": 104857600,
>   "modified": "2026-07-07T10:00:00Z"
> }
> ```

#### 写入工具（需审批 / 自动模式直接执行）

| 工具名 | 描述 | 参数 Schema | 审批行为 |
| :--- | :--- | :--- | :--- |
| `write_file` | 创建或覆盖文件内容 | `project_id`, `file_path`, `content` | 手动：入队审批；自动：直接执行（删除仍可能拦截） |
| `create_folder` | 创建新文件夹 | `project_id`, `folder_path` | 同上 |
| `move_file` | 移动/重命名文件 | `project_id`, `source`, `target` | 同上 |
| `delete_file` | 删除文件/空文件夹 | `project_id`, `file_path` | 手动：强制审批；自动：仍强制审批（除非额外开启） |
| `batch_operations` | 批量执行多个操作 | `project_id`, `operations[]` (每个元素含 `type` 和对应参数) | 整体送入队列，可按项审批 |

**Batch Operations 语义**：
- **Ordering（顺序执行）**：`operations[]` 中的操作按数组顺序依次执行。Operation N+1 可以依赖 Operation N 的结果（例如先 `create_folder`，再 `move_file` 到该文件夹）。
- **Atomicity（原子回滚）**：若任一操作失败，已执行的操作逆序回滚（参见 5.2 三阶段事务流程）。
- **Idempotency（幂等性）**：系统不做自动去重。若相同的 batch 被提交两次，将生成两个独立的 task_id。由 AI 负责避免重复提交。
| `get_task_status` | 查询之前提交的写入任务状态 | `task_id` (string) | 无限制，AI 可主动查询结果 |

**返回值统一结构：**
```json
{
  "task_id": "task_20260707_001",
  "status": "pending_approval",  // pending_approval | executed | rejected | failed | failed_and_rolled_back
  "message": "...",
  "details": {}
}
```
即使 Auto 模式直接执行，也返回 `status: "executed"` 的任务对象，保证客户端接口一致性。

### 4.3 内部 API 设计（供 AI 模块与预览引擎调用）

| 内部函数 | 用途 | 说明 |
| :--- | :--- | :--- |
| `scanDirectory(projectId, path)` | 目录扫描 | 文件系统抽象层提供 |
| `readFileContent(projectId, filePath)` | 读取文件 | 同上 |
| `enqueueOperation(projectId, sessionId, op)` | 入队写操作 | MCP 服务层提供 |
| `executeBatchWithRollback(taskIds)` | 执行批量任务（含事务） | 事务管理器提供 |
| `getTaskResult(taskId)` | 查询任务结果 | MCP 服务层提供 |

**@doc77/ai 包直接调用内部 API，不通过 JSON-RPC。**

### 4.4 安全校验增强

- **Authentication（Web GUI）**：默认 bind 到 `127.0.0.1`（仅本机访问）。可选配置 `security.shared_secret`，启用后 Web GUI 需在请求头携带 `Authorization: Bearer <shared_secret>`。
- **Session Validation**：所有需要 `session_id` 的 API 校验 session token 有效性（参见 7.2 Session Management 设计），防止伪造 `session_id` 绕过 rate limit。
- 路径遍历防护：使用 `path.resolve` + `fs.realpath` 双重校验，拒绝指向项目外部的符号链接。
- 敏感文件过滤：内置黑名单 `.env`, `*.key`, `*.pem`, `.git/*` 等，不可通过 MCP 读取或操作。
- 目录深度限制：`list_files` 最大 depth 可配置，默认 ≤5。
- **Read Rate Limiting**：每个已验证 session 每 5 分钟内最多读取 200 个文件（可配置）。
- **Write Rate Limiting**：Auto 模式下每个已验证 session 每 5 分钟内最多执行 50 个写操作（可配置）。Manual 模式无需额外限制，user approval 本身即为节流。

### 4.5 MCP Transport 支持

Doc77 支持两种 MCP transport，适配不同 client 类型：

| Transport | 端口 | 适用 Client | 说明 |
| :--- | :--- | :--- | :--- |
| **stdio** | 无（stdin/stdout） | Claude Desktop, VS Code Copilot | Client 以子进程方式启动 doc77，通过标准输入输出通信 |
| **Streamable HTTP** | 可配置（默认 8899） | 远程 MCP client, 自定义集成 | 基于 HTTP POST + SSE 的双向通信（MCP 2025-03-26+） |

启动命令：
```bash
doc77 mcp serve              # 仅 stdio transport（默认）
doc77 mcp serve --http       # 同时启用 stdio + Streamable HTTP
doc77 mcp serve --port 8899  # 指定 HTTP 端口
```

### 4.6 操作队列审批流

#### 完整流程

```
AI调用写工具 → 安全校验 → 生成操作任务，入队(SQLite) → 
  [手动模式] 前端/CLI展示待审批清单 → 用户逐条/批量审批 → 
  [审批通过] 事务管理器执行文件变更 → 记录审计日志 → 通知结果
  [自动模式] 根据配置直接执行并记录，删除操作仍拦截审批
```

#### 审批死锁解决（Headless 审批）
- CLI 命令：
  ```bash
  doc77 approve --list                  # 列出所有待审批任务
  doc77 approve --accept <task_id>      # 批准指定任务
  doc77 approve --accept --all          # 批准全部
  doc77 approve --reject <task_id>      # 拒绝
  ```
- Web 服务未启动时，CLI 是唯一审批入口；Web 启动后，两者共享任务池。
- 超时自动拒绝：默认 30 分钟未审批的任务自动拒绝（可配置）。

### 4.7 审计日志（不变）

审计日志表记录所有写操作，字段包括：`project_id`, `operation_type`, `operation_data`, `source` (ai/user/auto), `approved_by`, `status`, `error_message`, `created_at`, `executed_at`。


## 五、模块三：轻量级文件事务与状态回滚

### 5.1 设计目标
确保批量文件操作（如 AI 整理项目）在部分失败时能完整回滚，不留残留。同时应对 Node.js 真实文件系统限制：跨盘移动、进程崩溃残留等问题。

核心原则：**前置校验拦截大部分环境错误 + 低成本影子备份 + 逆序回滚**。

### 5.2 三阶段事务流程

#### 阶段一：Pre-flight Check（飞行前检查）
在开始任何磁盘写入前，对批量操作列表进行非破坏性模拟检查：
- 路径冲突检测
- 权限试探（Windows 下尝试只读打开文件句柄）
- 文件占用检查
若任何一项失败，整批直接标记失败，不执行任何磁盘操作，错误反馈给前端和 AI。

#### 阶段二：Shadow Copy（影子备份）
对通过检查的批量操作，逐条执行并记录 Undo 信息。备份位置统一在全局目录 `~/.doc77/shadow/{task_id}/`。

| 操作类型 | 备份动作 | Undo 日志 |
| :--- | :--- | :--- |
| `create_folder` | 无 | 记录路径，回滚时 `rmdir` |
| `move_file` | 无 | 记录源和目标，回滚时逆向 `move` |
| `delete_file` | 移动原文件到 shadow 目录 | 记录原始路径，回滚时移回 |
| `write_file`（覆盖） | 若原文件存在，移入 shadow | 记录原始路径，回滚时移回覆盖 |
| `write_file`（新建） | 无 | 回滚时删除新文件 |

#### 阶段三：Commit 或 Rollback
执行器逐条执行操作。若某步失败，立即停止，逆序执行已成功步骤的 Undo 操作，从 shadow 恢复文件。全部完成后清理 shadow 目录。审计日志记录最终状态：`executed` 或 `failed_and_rolled_back`。

### 5.3 跨盘移动的原子性处理（safeMove）

**问题**：`fs.rename` 在不同逻辑卷之间会抛出 `EXDEV: cross-device link not permitted`。

**方案**：封装 `safeMove(src, dest)`，当捕获 `EXDEV` 时，使用“**写临时文件 + 同盘原子重命名**”策略，确保目标路径永不出现半成品文件。

```typescript
// safeMove 最终实现（UUID 临时文件避免碰撞）
async function safeMove(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      const uniqueId = crypto.randomUUID();
      const tempDest = `${dest}.${uniqueId}.doc77tmp`;
      try {
        await fs.promises.copyFile(src, tempDest); // 复制到临时文件
        await fs.promises.rename(tempDest, dest);   // 同盘原子重命名
        await fs.promises.unlink(src);               // 删除源文件
      } catch (innerErr) {
        // 清理可能残留的临时文件，然后抛出原始错误
        try { await fs.promises.unlink(tempDest); } catch (_) {}
        throw innerErr;
      }
    } else {
      throw err;
    }
  }
}
```

**收益**：
- 即使 `copyFile` 中途崩溃，只剩一个 `.doc77tmp` 临时文件，不会有损坏的正式文件。
- 同盘 `rename` 是原子操作，目标文件要么不存在，要么完全正确。
- 结合 Shadow GC，残留的 `.doc77tmp` 也会在下次启动时被清理。

### 5.4 项目级读写锁（SQLite 持久化 + Heartbeat）

**问题**：同一项目可能同时有多个被批准的写入任务，并行执行会导致文件互相覆盖。

**方案**：将 project-level lock 持久化到 SQLite `project_locks` 表，配合 heartbeat 机制和可配置 timeout。

- **加锁**：事务执行前，检查 `project_locks` 表中是否已有该 `project_id` 的活跃锁（`heartbeat_at` 在 timeout 窗口内）。若无，插入锁记录；若有，任务排队等待。
- **Heartbeat**：执行期间每 30 秒更新 `heartbeat_at`，证明进程仍在活跃执行。
- **超时释放**：若 `heartbeat_at` 超过配置的 lock_timeout（默认 10 分钟）未更新，判定为 stale lock，新任务可抢占并清理 orphan shadow。
- **解锁**：事务完成（成功或失败）后删除锁记录。

**可观测性**：提供 CLI 命令 `doc77 lock status` 查看当前所有活跃锁，`doc77 lock release <project_id>` 手动释放 stale lock。

**实现伪代码**：
```typescript
async function acquireProjectLock(db: Database, projectId: number, taskIds: number[]): Promise<void> {
  const timeout = getConfig('concurrency.lock_timeout_minutes', 10);
  const heartbeatInterval = getConfig('concurrency.lock_heartbeat_seconds', 30);
  
  // 循环等待直到获取锁
  while (true) {
    const existing = db.prepare(
      `SELECT * FROM project_locks WHERE project_id = ? 
       AND datetime(heartbeat_at, '+' || ? || ' minutes') > datetime('now')`
    ).get(projectId, timeout);
    
    if (!existing) {
      // 清理可能存在的 stale lock
      db.prepare('DELETE FROM project_locks WHERE project_id = ?').run(projectId);
      // 插入新锁
      db.prepare(
        'INSERT INTO project_locks (project_id, locked_at, locked_by, heartbeat_at) VALUES (?, datetime("now"), ?, datetime("now"))'
      ).run(projectId, taskIds.join(','));
      
      // 启动 heartbeat 定时器
      const heartbeatTimer = setInterval(() => {
        db.prepare('UPDATE project_locks SET heartbeat_at = datetime("now") WHERE project_id = ?').run(projectId);
      }, heartbeatInterval * 1000);
      
      try {
        await executeBatchWithRollback(taskIds);
      } finally {
        clearInterval(heartbeatTimer);
        db.prepare('DELETE FROM project_locks WHERE project_id = ?').run(projectId);
      }
      return;
    }
    
    // 等待 1 秒后重试
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

### 5.5 体积熔断保护
- 单文件阈值：50MB（可配置）。
- **Delete 操作始终 Shadow**：无论文件大小，delete 的 shadow 本质是 rename，成本极低，始终保护。
- **Write/Overwrite 操作**：若涉及超大文件的 `write`（覆盖），该操作**剥离出事务**，弹窗警告用户并要求二次确认（输入 'CONFIRM'）后直接执行，不参与回滚。其余小文件继续受事务保护。

### 5.6 Shadow 垃圾回收（GC）机制
**问题**：进程崩溃可能残留 orphan shadow 文件夹和临时文件。

**机制（Startup GC + Runtime GC）**：

**Startup GC**（进程启动时执行）：
- 扫描 shadow 根目录。
- 检查每个子文件夹对应的 `task_id`：
  - 若 `operation_queue` 中无此 task_id，或状态为 `pending` 但文件夹最后修改时间超过 24 小时 → 判定为孤儿，直接删除。
- 同时清理所有 `*.doc77tmp` 临时文件。
- 正常执行完成后立即清理对应 shadow 目录。

**Runtime GC**（周期性执行，默认每 30 分钟）：
- 扫描 shadow 根目录。
- 检查 `operation_queue` 中状态为 `executed` 或 `failed_and_rolled_back` 的 task → 其 shadow 目录应已清理，若残留则删除。
- 检查超时的 `pending` task（创建超过 1 小时且状态未变）→ 标记为 rejected，清理其 shadow。
- 清理所有超过 1 小时的 `*.doc77tmp` 临时文件。


## 六、AI 智能体模块（@doc77/ai）

### 6.1 模块职责
> 负责对话理解、文档分析与操作规划，通过内部 API 与 MCP 层交互，同时提供 REST 端点供 Web 对话区调用。

### 6.2 AI 能力矩阵

| 能力 | 触发方式 | 依赖 |
| :--- | :--- | :--- |
| **📄 文档总结** | 预览时点击 "✨ AI 总结" | AI API Key |
| **📋 项目摘要生成** | Dashboard 点击 "AI 生成摘要" | AI API Key |
| **🧹 智能归类建议** | 对话输入 "帮我整理这个项目" | AI API Key + MCP 工具 |
| **📂 批量操作规划** | 对话输入 "将所有 .md 文件移到 docs 文件夹" | AI API Key + MCP 工具 |
| **🔍 文档内容分析** | 对话输入 "这个项目的 README 写了什么" | AI API Key + MCP 工具 |
| **📊 项目结构分析** | 对话输入 "分析当前项目的目录结构" | AI API Key + MCP 工具 |

### 6.3 Web 对话区通信

前端对话区通过 `POST /api/ai/chat` 发送消息：
```json
{
  "session_id": "20260707_001",
  "project_id": 1,
  "message": "帮我整理技术文档文件夹",
  "context": {               // 从预览页跳转时携带
    "current_file": "技术文档/API设计.md"
  }
}
```

后端处理：
1. 调用 `@doc77/ai` 模块初始化 Agent（带 System Prompt）。
2. Agent 根据消息决定调用 MCP 工具（内部 API）。
3. 流式返回 AI 思考过程与最终回复（SSE）。
4. 若生成操作任务，将 task_id 列表附在响应中，前端自动展示操作清单。

### 6.4 System Prompt 设计

```yaml
# ~/.doc77/ai-prompts.yaml
system_prompt: |
  你是 Doc77 AI 助手，一个专业的本地文档管理智能体。
  
  你的职责：
  1. 帮助用户管理本地项目文档（归类、重命名、整理、总结）
  2. 分析目录结构，提出优化建议
  3. 生成具体的文件操作指令（通过 MCP 工具）
  
  操作原则：
  1. 所有写操作（移动/重命名/删除/创建）必须通过 MCP 工具调用
  2. 你的任务是"规划"和"建议"，最终执行权在用户手中
  3. 生成操作建议时，需说明每个操作的意图和理由
  4. 删除操作必须标注为 "高危操作"
  
  文件大小感知规则：
  - list_files 结果中包含每个文件的 size（字节）
  - 若某个文件大小超过 file_size_threshold_mb（默认 50MB），避免对其生成 write_file 或 delete_file 建议。若确需操作，必须在建议中警告用户该操作有风险且无法自动回滚。
  - 当用户要求整理超大文件时，应主动建议用户手动处理。
```

### 6.5 操作结果通知
- 审批执行后，MCP 服务层通过内部事件总线通知 AI 模块。
- AI 模块将执行结果追加到对话历史，前端通过 SSE 更新显示。

### 6.6 前端状态同步（SSE 断开与对账）
操作队列执行器完全独立于 Web Request，即使客户端 SSE 断开，事务也会完整执行并写入 SQLite。前端重连后通过 `GET /api/queue/status?session_id=xxx` 获取最新任务列表，并通过轮询展示执行进度（若仍在执行中）。

### 6.7 Internal Event Bus 接口定义

`@doc77/mcp` 与 `@doc77/ai` 之间通过共享 `EventEmitter` 实例通信，在 application startup 时通过 dependency injection 注册。

**Event Schema**：

| Event Name | 发送方 | 接收方 | Payload | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `task:queued` | @doc77/mcp | @doc77/ai, Web UI (via SSE) | `{ task_id, project_id, session_id, operation_type }` | 新 task 入队 |
| `task:executing` | @doc77/mcp | @doc77/ai, Web UI (via SSE) | `{ task_id, project_id }` | task 开始执行 |
| `task:executed` | @doc77/mcp | @doc77/ai, Web UI (via SSE) | `{ task_id, project_id, result }` | task 执行成功 |
| `task:failed` | @doc77/mcp | @doc77/ai, Web UI (via SSE) | `{ task_id, project_id, error_message, rolled_back }` | task 执行失败（含回滚状态） |
| `task:approved` | 审批系统 | @doc77/mcp, Web UI (via SSE) | `{ task_id, approved_by }` | task 被审批通过 |
| `task:rejected` | 审批系统 | @doc77/mcp, Web UI (via SSE) | `{ task_id, rejected_by }` | task 被拒绝 |

**实现**：
```typescript
// app.ts — application bootstrap
import { EventEmitter } from 'events';
const eventBus = new EventEmitter();

// 注入到各模块
const mcpService = new McpServiceLayer({ eventBus, db });
const aiModule = new AiModule({ eventBus, db });
const webServer = new ExpressServer({ eventBus, db, mcpService, aiModule });
```

**SSE 推送**：`ExpressServer` 监听所有 eventBus 事件，将 task lifecycle event 通过 SSE 推送到前端，实现实时 UI 更新。


## 七、数据模型

### 7.1 数据库完整 Schema

```sql
-- 项目表
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_opened DATETIME
);

-- 配置表
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- 文件树缓存表
CREATE TABLE IF NOT EXISTS filetree_cache (
    project_id INTEGER NOT NULL,
    node_path TEXT NOT NULL,
    tree_json TEXT NOT NULL,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    mtime_map TEXT,             -- JSON 记录各文件最后修改时间，用于增量校验
    PRIMARY KEY (project_id, node_path),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 操作队列表
CREATE TABLE IF NOT EXISTS operation_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    operation_type TEXT NOT NULL,      -- write_file / move_file / delete_file / create_folder / batch
    operation_data JSON NOT NULL,
    status TEXT DEFAULT 'pending',     -- pending / approved / rejected / executed / failed / failed_and_rolled_back
    user_comment TEXT,
    undo_log JSON,                     -- 回滚所需信息（原始路径、shadow 路径等）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    executed_at DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 审计日志表
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    operation_type TEXT NOT NULL,
    operation_data JSON NOT NULL,
    source TEXT NOT NULL,              -- ai / user / auto
    approved_by TEXT,
    status TEXT NOT NULL,              -- executed / rejected / failed / failed_and_rolled_back
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    executed_at DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 会话表（session management）
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,                  -- server 端生成的 UUID token
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    read_count INTEGER DEFAULT 0,        -- 当前 5 分钟窗口内的读取次数
    read_window_start DATETIME,           -- 读取计数窗口起始时间
    write_count INTEGER DEFAULT 0,        -- Auto 模式下当前 5 分钟窗口的写入次数
    write_window_start DATETIME,          -- 写入计数窗口起始时间
    expired_at DATETIME                   -- 过期时间（可配置 idle timeout，默认 2 小时）
);

-- 项目锁表（project-level lock，持久化到 SQLite）
CREATE TABLE IF NOT EXISTS project_locks (
    project_id INTEGER PRIMARY KEY,
    locked_at DATETIME NOT NULL,
    locked_by TEXT NOT NULL,              -- task_id 列表（逗号分隔）
    heartbeat_at DATETIME,                -- 最后心跳时间
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_queue_project_id ON operation_queue(project_id);
CREATE INDEX IF NOT EXISTS idx_queue_status ON operation_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_session ON operation_queue(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_project_id ON audit_log(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);
```

### 7.2 Session Management 设计

**session_id** 在 rate limiting、operation queue、AI chat、SSE reconciliation 等多处使用。为保证安全性，session 由 server 端统一管理：

- **Session 生成**：首次连接时 server 生成 UUID token，通过 response header 或 API 返回给 client
- **Session 验证**：所有需要 `session_id` 的 API 均校验 token 是否存在于 `sessions` 表且未过期
- **Session 过期**：可配置 idle timeout（默认 2 小时），`last_active_at` 超时后自动失效
- **Rate Limiting 绑定**：`read_count` 和 `write_count` 关联到已验证 session，client 无法通过更换 `session_id` 绕过限制
- **清理机制**：定期清理过期 session（每小时执行一次）

### 7.3 配置表默认值

```json
{
  "ai.enabled": false,
  "ai.auto_mode": false,
  "ai.risk_level": "medium",
  "ai.confirm_delete": true,
  "ai.batch_size": 5,
  "ai.require_approval_types": ["delete_file"],
  "ai.max_depth": 5,
  "ai.read_limit_per_session": 200,
  "editor.default": "vscode",
  "security.follow_symlinks": false,
  "transaction.shadow_dir": "~/.doc77/shadow",
  "transaction.file_size_threshold_mb": 50,
  "transaction.rollback_enabled": true,
  "transaction.shadow_gc_enabled": true,
  "transaction.shadow_orphan_age_hours": 24,
  "concurrency.enable_project_lock": true,
  "concurrency.lock_timeout_minutes": 10,
  "concurrency.lock_heartbeat_seconds": 30,
  "security.bind_address": "127.0.0.1",
  "security.shared_secret": "",
  "session.idle_timeout_minutes": 120,
  "session.cleanup_interval_minutes": 60,
  "rate.write_limit_per_session": 50,
  "rate.write_window_minutes": 5,
  "transport.mcp_stdio_enabled": true,
  "transport.mcp_http_enabled": true,
  "transport.mcp_http_port": 8899
}
```

### 7.4 缓存失效策略
`filetree_cache` 的 `mtime_map` 字段存储每个子文件的最后修改时间（JSON）。仅在用户展开子文件夹或手动刷新时，对当前层级文件进行 `fs.stat` 比较，若变化则更新对应节点缓存。全量刷新按钮保留，但提示耗时可能较长。


## 八、项目结构与关键代码

### 8.1 目录结构

```
doc77/
├── pnpm-workspace.yaml               # monorepo workspace 配置
├── package.json                       # 根 package.json (workspace scripts)
├── tsconfig.base.json                 # 共享 TypeScript 配置
├── .eslintrc.cjs                      # ESLint 配置
├── .prettierrc                        # Prettier 配置
├── vitest.config.ts                   # Vitest 配置
├── packages/
│   ├── core/                          # @doc77/core 预览引擎与文件抽象层
│   │   ├── src/
│   │   │   ├── renderers/             # 前端渲染器 (markdown, mermaid, etc.)
│   │   │   ├── scanner/               # 目录扫描器
│   │   │   ├── fs/                    # 文件系统抽象层
│   │   │   │   ├── safeMove.ts        # 原子化跨盘移动
│   │   │   │   ├── shadowGC.ts        # Shadow 垃圾回收
│   │   │   │   └── ...
│   │   │   ├── db/                    # 数据库操作
│   │   │   ├── server/                # Express 服务与 API 路由
│   │   │   ├── web/                   # 静态前端资源
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── mcp/                           # @doc77/mcp MCP 服务层
│   │   ├── src/
│   │   │   ├── tools/                 # MCP 工具实现
│   │   │   ├── security/              # 路径安全
│   │   │   ├── queue/                 # 操作队列管理
│   │   │   ├── audit/                 # 审计日志
│   │   │   ├── transaction/           # 事务管理器
│   │   │   │   ├── executor.ts        # 事务执行器（含 SQLite 锁）
│   │   │   │   ├── preflight.ts       # 飞行前检查
│   │   │   │   ├── shadow.ts          # 影子备份
│   │   │   │   └── rollback.ts        # 回滚
│   │   │   ├── event-bus.ts           # Internal Event Bus 接口
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── ai/                            # @doc77/ai AI 能力模块
│   │   ├── src/
│   │   │   ├── provider/              # AI 接口提供者 (OpenAI / 兼容)
│   │   │   ├── prompts/               # 提示词模板
│   │   │   ├── agent/                 # Doc Agent 核心
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── cli/                           # doc77 CLI 主应用
│       ├── src/
│       │   ├── cli/                   # 命令实现
│       │   └── bin/doc77.ts           # 入口
│       ├── package.json
│       └── tsconfig.json
│
├── __tests__/                         # 测试用例
│   ├── safeMove.test.ts
│   ├── transaction.test.ts
│   ├── project-lock.test.ts
│   ├── shadow-gc.test.ts
│   ├── session.test.ts
│   └── ...
├── .github/workflows/
│   └── ci.yml
├── README.md
├── LICENSE
└── .gitignore
```

### 8.2 关键代码片段（safeMove 实现）

见 5.3 节，此处不重复。

### 8.3 项目级锁实现

见 5.4 节 SQLite 持久化 + Heartbeat 方案，此处不重复。

### 8.4 Graceful Shutdown 流程

```
SIGTERM / SIGINT
  → 1. 停止接收新 HTTP 请求（close server socket）
  → 2. 等待当前执行的事务完成（最多等待 lock_timeout 分钟）
  → 3. 中断等待中的排队任务（标记为 rejected）
  → 4. Runtime GC：清理当前完成的 shadow 目录
  → 5. 关闭 SQLite 数据库连接
  → 6. 关闭 MCP transport（stdio / HTTP）
  → 7. 退出进程（exit code 0）
```

### 8.5 Cross-Platform 文件系统注意事项

- **Windows 文件锁定**：打开的文件无法被 move/delete。Pre-flight check 需使用平台适配方法（Windows 下尝试只读 `CreateFile`）。
- **Windows MAX_PATH**：默认 260 字符限制。需在应用 manifest 中启用 long path 支持，或使用 `\\?\` 前缀路径。
- **大小写敏感性**：macOS 默认大小写不敏感，Linux 大小写敏感。`fs.realpath` 获取真实路径用于比较。
- **Symbolic Link**：默认 `follow_symlinks: false`。路径遍历检查在 realpath 解析后进行，拒绝指向 project 外部的 symlink。
- **WSL 跨文件系统**：Windows WSL 下，Windows 文件系统 (`/mnt/c/`) 与 Linux 文件系统 (`/home/`) 之间的操作会触发 EXDEV。


## 九、CLI 命令全集

```bash
# === 核心命令 ===
doc77 start                              # 启动服务（展示所有已注册项目）
doc77 start --port 8080                  # 指定端口
doc77 start --no-browser                 # 不自动打开浏览器

# === 项目管理 ===
doc77 register ./path                    # 注册项目（自动取文件夹名）
doc77 register ./path --name "项目A"    # 注册并指定别名
doc77 register --config ./config.json   # 批量注册

doc77 list                               # 列出所有项目
doc77 list --json                        # JSON 格式输出

doc77 remove <id>                        # 按 ID 移除项目
doc77 remove --name "项目A"              # 按别名移除

doc77 update <id> --path <new-path>     # 更新路径
doc77 update <id> --name <new-name>     # 更新别名

# === 配置管理 ===
doc77 config set <key> <value>           # 设置配置项
doc77 config get <key>                   # 获取配置项
doc77 config list                        # 列出所有配置

# === MCP 服务 ===
doc77 mcp serve                          # 启动 MCP 服务模式（stdio transport）
doc77 mcp serve --http                   # 同时启用 stdio + Streamable HTTP
doc77 mcp serve --port 8899              # 指定 HTTP 端口
doc77 mcp status                         # 查看 MCP 服务状态

# === 锁管理 ===
doc77 lock status                        # 查看当前所有活跃 project lock
doc77 lock release <project_id>          # 手动释放指定 project 的 stale lock

# === 任务审批 (Headless) ===
doc77 approve --list                     # 列出待审批任务
doc77 approve --accept <task_id>         # 批准指定任务
doc77 approve --reject <task_id>         # 拒绝指定任务
doc77 approve --accept --all             # 批量批准
doc77 approve --reject --all             # 批量拒绝

# === AI 能力 ===
doc77 ai summarize ./docs/README.md      # 总结单文档
doc77 ai classify ./project              # 分析项目结构
doc77 ai summary ./project               # 生成项目摘要
doc77 ai chat                            # 进入 AI 对话模式

# === 其他 ===
doc77 status                             # 查看服务状态
doc77 --version                          # 显示版本号
doc77 --help                             # 显示帮助
```


## 十、核心交互场景完整流程

### 场景一：首次使用 + 注册项目

```bash
npm install -g doc77
cd ~/work/customer-a-docs
doc77 register ./ --name "客户A项目"
doc77 start
```

### 场景二：多项目切换预览（开会场景）
Dashboard 展示所有项目卡片 → 点击进入 → 左侧目录树按需加载 → 点击文件即时预览。

### 场景三：AI 智能整理文档（含事务回滚）

1. 用户在对话区输入“帮我整理技术文档文件夹”。
2. AI 调用 `list_files`（含文件大小），分析结构。
3. AI 生成操作计划（避开大文件），调用 `batch_operations` 入队，返回 `task_id` 列表。
4. AI 回复：“已生成 6 条操作建议，请审批”。
5. 前端展示操作清单，用户审批后执行。
6. 事务管理器执行 Pre-flight → Shadow 备份 → 顺序执行。
7. 若第 4 步失败，立即停止，逆序回滚前 3 步，文件恢复原状，前端提示“操作失败，已自动回滚”。
8. 若全部成功，Shadow 清空，目录树自动刷新，AI 对话更新执行结果。

### 场景四：外部编辑器打开

预览页点击“📝 在 VS Code 中打开” → 构造 `vscode://file/...` 协议 → 打开编辑器；失败则提示降级到“在文件夹中显示”。

### 场景五：并发任务排队

用户连续两次点击审批两个针对同一项目的批量任务。第一个任务获取项目锁，开始执行；第二个任务排队等待，直到第一个 Commit 完成后自动启动。


## 十一、自动化测试策略

### 11.1 单元测试
- **safeMove**：
  - 模拟同盘 `rename` 成功。
  - 模拟 `EXDEV` 错误，验证 UUID 临时文件生成、原子重命名与源删除。
  - 模拟 `copyFile` 中途失败（Mock 抛异常），验证临时文件被清理，目标正式文件不存在。
- **项目级锁**：
  - 模拟同一项目并发提交两个任务，验证第二个任务等待第一个完成（stale lock 检测 + heartbeat 超时）。
  - 验证 lock heartbeat 定时更新，lock 超时后新任务可抢占。
- **Session Management**：
  - 验证 server 端生成 UUID session token。
  - 验证伪造 session_id 被拒绝。
  - 验证 session 过期后 API 返回 401。
- **Internal Event Bus**：
  - 验证 task lifecycle event（queued/executing/executed/failed）正确发布。
  - 验证 SSE 推送 payload 与 event 一致。

### 11.2 集成测试
- **批量事务正常执行** → 全部提交，shadow 清空，审计日志正确。
- **中间操作失败**（如手动删除目标文件夹使移动失败）→ 验证逆序回滚，文件恢复原状，审计日志记录 `failed_and_rolled_back`。
- **跨盘场景**（使用 RAM 盘或 Docker 卷，或 mock `fs` 层返回 `EXDEV`）→ 验证 `safeMove` 降级正确，UUID 临时文件无残留。
- **进程崩溃模拟**（在测试中 kill 进程或超时中断）→ 重启后 Startup GC 清理 orphan shadow 和 `*.doc77tmp`，且项目文件未受损。
- **Runtime GC**：创建 orphan shadow 后等待一个 GC 周期（默认 30 分钟，测试时可缩短），验证自动清理。
- **Graceful Shutdown**：模拟 `SIGTERM`，验证当前事务完成、排队任务被标记为 rejected。

### 11.3 端到端测试
- CLI 提交 AI 整理请求 → Web 审批 → 观察文件变化，故意在浏览器断连后重连，验证 SSE 对账正确。
- 大文件熔断：构造 >50MB 文件，AI 生成操作建议时不包含对其的覆盖操作；若强制加入，前端弹窗正确显示二次确认。
- Delete 操作始终 shadow（包括大文件），验证回滚成功。
- MCP stdio transport 与 Claude Desktop 兼容性测试。


## 十二、非功能需求

### 12.1 性能目标

| 指标 | 目标值 |
| :--- | :--- |
| 启动时间 | < 3 秒（首次）/ < 1 秒（二次） |
| 目录浅层扫描（100 条目） | < 100ms |
| 按需加载子目录 | < 50ms |
| Markdown 渲染 | < 100ms |
| 内存占用 | < 150MB |
| npm 包体积 | < 10MB |
| exe 打包体积 | < 30MB |

### 12.2 安全设计

| 安全点 | 措施 |
| :--- | :--- |
| **只读预览** | 预览引擎只有读取权限 |
| **路径铁笼** | 所有 MCP 操作强制校验在项目路径内 |
| **审批机制** | 所有写操作默认进入队列，需用户审批 |
| **Auto 模式默认关闭** | 必须显式开启，删除操作强制二次确认 |
| **审计日志** | 所有写操作记录到 JSON 结构化日志 |
| **无云端存储** | 所有数据留在本地，不主动上传 |

### 12.3 兼容性

| 平台 | 支持情况 | 说明 |
| :--- | :--- | :--- |
| **macOS** | ✅ 完全支持 | 开发主力平台 |
| **Windows** | ✅ 完全支持 | 路径适配 |
| **Linux** | ✅ 完全支持 | 主流发行版 |


## 十三、项目里程碑

| 阶段 | 内容 | 预计时间 |
| :--- | :--- | :--- |
| **Phase 1** | 项目骨架搭建，SQLite 初始化，基础 CLI 命令 | 1 周 |
| **Phase 2** | 预览引擎开发（Markdown + Mermaid + 代码高亮） | 1 周 |
| **Phase 3** | Web Dashboard + 预览页面 + 目录树懒加载 | 1 周 |
| **Phase 4** | MCP 服务层（8 个工具 + 安全校验） | 1 周 |
| **Phase 5** | 操作队列审批流、事务回滚（safeMove + GC + 读写锁） | 1.5 周 |
| **Phase 6** | AI 能力模块（总结/分类/Agent 对话，对接大小感知） | 1 周 |
| **Phase 7** | 自定义协议打开 + 配置文件完善 + 测试覆盖 | 1 周 |
| **Phase 8** | 打包 exe + 文档撰写 + 发布 v1.0 | 1 周 |

**总计：约 8-9 周**


## 十四、开源与社区

| 项目 | 信息 |
| :--- | :--- |
| **开源协议** | MIT License |
| **代码仓库** | github.com/doc77/doc77 |
| **npm 包** | `doc77`（CLI）/ `@doc77/core`（引擎）/ `@doc77/mcp`（MCP）/ `@doc77/ai`（AI） |
| **文档** | doc77.dev（官网建设中） |
| **社区** | Discord / GitHub Issues |


## 十五、总结

Doc77 v2.5 在 v2.4 基础上完成了 technology stack 全面升级、缺失依赖补充、架构图修正和安全/可靠性增强。新增 Session Management、SQLite 持久化 Project Lock、Runtime Shadow GC、Internal Event Bus 接口定义、MCP Transport 明确和 Authentication 设计。它为”只读预览、安全写入、AI 调度”三层能力提供了更扎实的工程基础。

> **一句话总结：**
> Doc77 是轻量级的本地文档预览器 + MCP 文件操作桥梁 + AI 对话驱动的智能管理 Agent，内置安全审批、原子化事务回滚、跨盘容错、SQLite 持久化并发控制与自动清理，让 AI 辅助文件管理既强大又安心。

---

> 本设计方案版本：v2.5  
> 更新日期：2026-07-07  
> 状态：✅ Architecture v2.5（technology stack 升级 + 安全/可靠性增强），可进入编码与测试阶段

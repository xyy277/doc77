# CLAUDE.md

## 文档语言规范

本项目所有文档遵循以下语言规范：

- **专业名词 / 技术术语**：使用 **英文** 原文（如 Node.js, Express, SQLite, MCP, SDK, API, CLI, SSE, JSON-RPC, TypeScript 等）
- **其余说明文字**：使用 **中文**

### 术语对照示例

| 英文术语 | 说明 |
|---|---|
| Node.js | 运行时，不翻译 |
| Express | Web 框架，不翻译 |
| SQLite | 数据库，不翻译 |
| MCP (Model Context Protocol) | 协议名称，保留英文 |
| SDK | 软件开发工具包，保留英文缩写 |
| CLI | 命令行接口，保留英文缩写 |
| API | 应用程序接口，保留英文缩写 |
| SSE (Server-Sent Events) | 服务端推送事件，保留英文缩写 |
| JSON-RPC | 协议，保留英文 |
| TypeScript | 编程语言，不翻译 |
| Shadow / Shadow Copy | 影子备份，可保留英文并附中文说明 |
| Pre-flight Check | 飞行前检查 |
| Rollback | 回滚 |
| GC (Garbage Collection) | 垃圾回收 |
| safeMove | 安全移动（函数名保留英文） |
| batch_operations | 批量操作（函数名保留英文） |
| session_id | 会话标识符（字段名保留英文） |

### 编写原则

1. 技术名词首次出现时，可附中文注释说明，后续统一使用英文术语
2. 代码、命令、配置项、字段名、表名保持英文原文
3. 结构化内容（表格、列表）中的术语使用英文，描述性文字使用中文
4. 标题可根据内容性质使用中英混合

## 项目概述

Doc77 是一个"默认安全、对话驱动"的智能本地文档管理 Agent。

- **技术栈**：Node.js, TypeScript, Express, SQLite, MCP Protocol
- **架构**：monorepo（4 个 package：core, mcp, ai, cli）
- **当前状态**：设计阶段，尚未开始编码

## 文档结构

```
docs/
├── README.md                               # 文档导航
├── design/
│   └── system-architecture.md              # 系统架构完整设计方案（v2.5）
├── analysis/
│   └── system-architecture-analysis.md     # 架构评审与技术栈验证报告
└── planning/
    ├── implementation-plan.md              # 实施方案（40 个 Task，9 个 Phase）
    └── implementation-status.md            # 实施进度跟踪
```

## 实施进度

实施跟踪文件：`docs/planning/implementation-status.md`

共 40 个 Task，当前进度 0%。开始实施时，按 Task 更新 status checklist。

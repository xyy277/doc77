# Doc77

> 默认安全、对话驱动的智能本地文档管理 Agent

**Doc77** 是轻量级本地文档预览器 + MCP 文件操作桥梁 + AI 对话驱动管理 Agent。它只读时是多项目陈列馆，写入时是由你审批的智能管家——所有文件操作经你确认后才执行，内置安全审批、原子化事务回滚与跨盘容错。

## 核心定位

```
📋 只读预览          🔧 MCP 文件操作            🤖 AI 智能管理
多项目 Dashboard    通过 MCP 协议暴露工具集    自然语言对话驱动
Markdown/Mermaid/   AI 可读取、分析、          智能归类、批量整理、
PDF/图片原生预览    规划文件变更              文档总结
```

## 设计哲学

1. **文档留在原地** — 绝不复制/上传用户文件，只读本地路径
2. **预览 ≠ 编辑** — 编辑交给专业工具（VS Code / Typora），预览交给 Doc77
3. **注册即管理** — 一次注册项目目录，永久记住，点开即用
4. **轻量优先** — 单进程、SQLite、零配置、开箱即用
5. **对话驱动** — 自然语言交互，AI 辅助规划，用户最终决策

## 快速开始

```bash
# 安装
npm install -g doc77

# 注册一个项目
doc77 register ./my-docs --name "我的文档"

# 启动 Dashboard
doc77 start

# 或启动 MCP 服务模式（供 Claude Desktop 等客户端连接）
doc77 mcp serve
```

## 功能概览

| 功能 | 说明 |
|---|---|
| **多项目预览** | 注册多个本地目录，Dashboard 统一管理，Markdown / Mermaid / PDF / 图片即时预览 |
| **MCP 文件操作** | 通过 MCP 协议暴露 8 个 Tool（list_files, read_file, write_file, batch_operations 等），AI 可安全读写本地文件 |
| **审批工作流** | 所有写操作默认入队等待用户审批，支持 CLI 和 Web 双通道审批 |
| **事务回滚** | Pre-flight 检查 + Shadow 备份 + 逆序回滚，批量操作失败时自动恢复 |
| **AI 文档管理** | 自然语言对话驱动，智能归类建议、批量操作规划、文档总结分析 |
| **安全设计** | 路径沙箱、敏感文件过滤、Session 管理、Rate Limiting、审计日志 |

## 文档

| 文档 | 说明 |
|---|---|
| [系统架构设计](docs/design/system-architecture.md) | 完整设计方案：架构、数据模型、API、事务系统、安全设计 |
| [架构分析报告](docs/analysis/system-architecture-analysis.md) | Technology Stack 验证与 Architecture 评审 |
| [实施方案](docs/planning/implementation-plan.md) | 40 个 Task、9 个 Phase 的详细实施计划 |
| [实施进度](docs/planning/implementation-status.md) | 实时开发进度跟踪 |

## 技术栈

| 组件 | 选型 |
|---|---|
| Runtime | Node.js >= 22.x |
| Language | TypeScript ^5.8 |
| Web Framework | Express ^5.x |
| Database | SQLite（better-sqlite3 ^12.x） |
| MCP Protocol | 2025-11-25（@modelcontextprotocol/sdk） |
| Frontend | 原生 HTML + CSS + JS（marked, Mermaid, PDF.js, highlight.js） |
| Build | tsup + pnpm workspaces |
| Test | Vitest |

## 项目结构

```
doc77/
├── packages/
│   ├── core/          # @doc77/core  预览引擎 + 文件系统抽象层 + Express Server
│   ├── mcp/           # @doc77/mcp   MCP 服务层 + 安全校验 + 事务系统
│   ├── ai/            # @doc77/ai    AI Provider + Agent 核心 + Chat API
│   └── cli/           # doc77 CLI    命令行入口
├── docs/
│   ├── design/        # 设计文档
│   ├── analysis/      # 分析报告
│   └── planning/      # 实施规划
├── CLAUDE.md          # 项目规范
└── README.md          # 本文件
```

## 开源协议

[MIT License](LICENSE)

---

> **一句话总结：** Doc77 = 本地文档预览器 + MCP 文件操作桥梁 + AI 对话驱动管理 Agent。内置安全审批、原子化事务回滚、跨盘容错、SQLite 持久化并发控制与自动清理，让 AI 辅助文件管理既强大又安心。

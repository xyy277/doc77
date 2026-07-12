# @doc77/cli

Doc77 CLI — 默认安全、对话驱动的智能本地文档管理 Agent。

## Installation

```bash
npm install -g @doc77/cli
```

## Quick Start

```bash
doc77 register ./my-docs --name "我的文档"
doc77 start
```

## Commands

### 项目管理

| 命令 | 说明 |
|---|---|
| `doc77 start [--port <n>] [--bind <addr>]` | 启动 Web Dashboard |
| `doc77 register <path> [--name <n>]` | 注册项目目录 |
| `doc77 list [--json]` | 列出所有项目 |
| `doc77 remove <id>` | 移除项目 |
| `doc77 update <id> [--name <n>] [--path <p>]` | 更新项目 |

### 密码管理

| 命令 | 说明 |
|---|---|
| `doc77 config set-password` | 设置密码（首次，输出恢复码） |
| `doc77 config change-password` | 修改密码 |
| `doc77 config reset-password` | 使用恢复码重置密码 |
| `doc77 config reset-password --force` | 强制重置（清空加密配置） |
| `doc77 config recovery-codes` | 重新生成恢复码 |

### MCP & AI

| 命令 | 说明 |
|---|---|
| `doc77 mcp serve [--http] [--port <n>]` | 启动 MCP 服务 |
| `doc77 approve --list` | 列出待审批任务 |
| `doc77 approve --accept <id>` | 批准任务 |

---

Part of [Doc77](https://github.com/xyy277/doc77) — 本地文档预览与管理工具

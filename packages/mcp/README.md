# @doc77/mcp

Doc77 MCP 服务层 — MCP 协议实现、安全校验、操作队列、事务系统。

## Installation

```bash
npm install @doc77/mcp
```

## Features

| 模块 | 说明 |
|---|---|
| **MCP Server** | Model Context Protocol 实现（stdio + HTTP 传输），8 个 Tool 暴露文件系统能力 |
| **Read Tools** | `list_files`、`read_file`、`get_file_info` |
| **Write Tools** | `write_file`、`create_folder`、`move_file`、`delete_file`、`batch_operations` |
| **Security Guard** | 路径沙箱限制、敏感文件过滤 |
| **Transaction** | Pre-flight 检查 + Shadow 备份 + 逆序回滚，批量操作失败自动恢复 |
| **Approval Queue** | 写操作入队等待审批，支持 CLI / Web 双通道 |
| **Session** | Session 管理、Rate Limiting、审计日志 |

## Tools

| Tool | Type | Description |
|---|---|---|
| `list_files` | Read | 列出目录内容 |
| `read_file` | Read | 读取文件内容 |
| `get_file_info` | Read | 获取文件元信息 |
| `write_file` | Write | 写入文件 |
| `create_folder` | Write | 创建目录 |
| `move_file` | Write | 移动文件 |
| `delete_file` | Write | 删除文件 |
| `batch_operations` | Write | 批量操作 |

## Usage

```bash
# Stdio 模式（本地 AI 工具调用）
doc77 mcp serve

# HTTP 模式（远程 Agent）
doc77 mcp serve --http --port 8899
```

---

Part of [Doc77](https://github.com/xyy277/doc77) — 本地文档预览与管理工具

# idoc77

本地文档预览器 · 开源免费 — 一行命令开启文档工作台。

## Installation

```bash
npm install -g idoc77
```

## Quick Start

```bash
# 注册项目
doc77 register ./my-docs --name "我的文档"

# 启动服务
doc77 start

# 浏览器打开 http://localhost:27777
```

## What's Included

`idoc77` 是 Doc77 的 umbrella 包，安装后自动包含：

- `@doc77/core` — 核心引擎
- `@doc77/cli` — 命令行工具
- `@doc77/mcp` — MCP 服务
- `@doc77/ai` — AI 模块

## Features

- Markdown / Mermaid / PDF / 图片 / docx / xlsx 即时预览
- 代码高亮（44+ 语言）
- TTS 朗读 + 阅读进度
- AI 文档分析 + 对话管理
- 密码保护 + 恢复码重置
- MCP 协议支持（stdio + HTTP）
- 移动端自适应 UI
- Electron 桌面版

## Documentation

完整文档请访问 [GitHub Repository](https://github.com/xyy277/doc77)。

---

Part of [Doc77](https://github.com/xyy277/doc77)

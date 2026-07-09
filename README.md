# Doc77

> 默认安全、对话驱动的智能本地文档管理 Agent

**Doc77** 是轻量级本地文档预览器 + MCP 文件操作桥梁 + AI 对话驱动管理 Agent。它只读时是多项目陈列馆，写入时是由你审批的智能管家——所有文件操作经你确认后才执行，内置安全审批、原子化事务回滚与跨盘容错。

## 快速开始

```bash
# 安装
npm install -g @doc77/cli

# 注册一个项目
doc77 register ./my-docs --name "我的文档"

# 启动 Dashboard（仅本机访问）
doc77 start

# 或允许局域网 / 外部访问
doc77 start --bind 0.0.0.0

# 浏览器打开 http://localhost:3099
```

## 命令参考

### 核心命令

| 命令 | 说明 |
|---|---|
| `doc77 start [--port <n>] [--bind <addr>]` | 启动 Web Dashboard（默认端口 3099） |
| `doc77 register <path> [--name <n>]` | 注册项目目录 |
| `doc77 list [--json]` | 列出所有已注册项目 |
| `doc77 remove <id>` | 按 ID 移除项目（不会删除源文件） |
| `doc77 update <id> [--name <n>] [--path <p>]` | 更新项目名称或路径 |
| `doc77 status` | 查看服务状态 |

### 配置管理

| 命令 | 说明 |
|---|---|
| `doc77 config set <key> <value>` | 设置配置项 |
| `doc77 config get <key>` | 获取配置项 |
| `doc77 config list` | 列出所有配置 |

常用配置项：

| Key | 说明 | 默认值 |
|---|---|---|
| `ai.enabled` | 启用 AI 助手 | `false` |
| `ai.token` | AI API Token | — |
| `ai.base_url` | AI API Base URL | `https://api.deepseek.com` |
| `ai.model` | 模型名称 | `deepseek-v4-pro` |
| `editor.default` | 默认编辑器 | `vscode` |

### MCP 服务

| 命令 | 说明 |
|---|---|
| `doc77 mcp serve [--http] [--port <n>]` | 启动 MCP 服务（stdio 或 HTTP 传输） |

### 任务审批

| 命令 | 说明 |
|---|---|
| `doc77 approve --list` | 列出待审批任务 |
| `doc77 approve --accept <task_id>` | 批准指定任务 |
| `doc77 approve --reject <task_id>` | 拒绝指定任务 |
| `doc77 approve --accept --all` | 批量批准 |
| `doc77 approve --reject --all` | 批量拒绝 |

### 锁管理

| 命令 | 说明 |
|---|---|
| `doc77 lock status` | 查看活跃的项目锁 |
| `doc77 lock release <project_id>` | 手动释放项目锁 |

### 离线支持

```bash
# 下载所有 CDN 资源到本地（约 16MB）
doc77 vendor-install

# 跳过 Pyodide（Python 运行时），节省 ~12MB
doc77 vendor-install --no-pyodide
```

资源缓存到 `~/.doc77/vendor/`，重启服务后自动生效。重复执行会跳过已下载的文件。

## 支持的格式

| 格式 | 扩展名 | 阅读模式 |
|---|---|---|
| **Markdown** | `.md` `.mdx` `.markdown` | ✅ TTS/搜索/大纲/进度 |
| **Mermaid 图表** | `.mermaid` `.mmd` | ✅ |
| **代码** (~44 种) | `.ts` `.js` `.py` `.go` `.rs` `.java` `.c` `.cpp` `.html` `.css` `.json` … | ✅ 语法高亮 |
| **PDF** | `.pdf` | ✅ 浏览器原生预览 + 一键全屏 |
| **图片** (9 种) | `.png` `.jpg` `.gif` `.svg` `.webp` `.avif` `.bmp` `.ico` | ✅ Lightbox 缩放/导航 |
| **Word 文档** | `.docx` | ✅ mammoth.js 渲染 |
| **Excel 表格** | `.xlsx` `.xls` | ✅ SheetJS 渲染 + Tab 切换 |
| **JavaScript 执行** | `.js` | ✅ Sandbox 运行 |
| **Python 执行** | `.py` | ✅ Pyodide WASM 运行 |
| **不支持的格式** | `.mp4` `.zip` `.exe` `.shp` `.psd` … | ❌ 文件信息卡 + 文件夹中显示 |

## 一键重启

```bash
./scripts/restart.sh              # 默认端口 3099
./scripts/restart.sh --port 8080  # 自定义端口
```

> 如需绑定 `0.0.0.0` 允许外部访问，使用 `doc77 start --bind 0.0.0.0`（启用后需要设置访问密码）。

## 功能概览

| 功能 | 说明 |
|---|---|
| **多项目预览** | 注册多个本地目录，Dashboard 统一管理，Markdown / Mermaid / PDF / 图片即时预览 |
| **阅读模式** | TTS 朗读、自动滚动、阅读进度、文档内搜索 (Ctrl+F)、AI 摘要 |
| **MCP 文件操作** | 通过 MCP 协议暴露 8 个 Tool（list_files, read_file, write_file, batch_operations 等），AI 可安全读写本地文件 |
| **审批工作流** | 所有写操作默认入队等待用户审批，支持 CLI 和 Web 双通道审批 |
| **事务回滚** | Pre-flight 检查 + Shadow 备份 + 逆序回滚，批量操作失败时自动恢复 |
| **AI 文档管理** | 自然语言对话驱动，智能归类建议、批量操作规划、文档总结分析 |
| **安全设计** | 路径沙箱、敏感文件过滤、Session 管理、Rate Limiting、审计日志 |

## 设计哲学

1. **文档留在原地** — 绝不复制/上传用户文件，只读本地路径
2. **预览 ≠ 编辑** — 编辑交给专业工具（VS Code / Typora），预览交给 Doc77
3. **注册即管理** — 一次注册项目目录，永久记住，点开即用
4. **轻量优先** — 单进程、SQLite、零配置、开箱即用
5. **对话驱动** — 自然语言交互，AI 辅助规划，用户最终决策

## 文档

| 文档 | 说明 |
|---|---|
| [系统架构设计](docs/design/system-architecture.md) | 完整设计方案 |
| [架构分析报告](docs/analysis/system-architecture-analysis.md) | Technology Stack 验证与 Architecture 评审 |
| [实施方案](docs/planning/implementation-plan.md) | 40 个 Task、9 个 Phase 详细计划 |
| [实施进度](docs/planning/implementation-status.md) | 实时开发进度跟踪 |
| [变更日志](CHANGELOG.md) | 版本变更记录 |

## 技术栈

| 组件 | 选型 |
|---|---|
| Runtime | Node.js >= 22.x |
| Language | TypeScript ^5.8 |
| Web Framework | Express 5.x |
| Database | SQLite（sql.js） |
| MCP Protocol | @modelcontextprotocol/sdk |
| Frontend | 原生 HTML + CSS + JS（marked, Mermaid, highlight.js）+ 浏览器原生 PDF / HTML 预览 |
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
├── scripts/           # 工具脚本
├── CLAUDE.md          # 项目规范
└── README.md          # 本文件
```

## 隐私与安全

- 所有数据存储在本地 `~/.doc77/`
- AI Token 加密存储在 SQLite 数据库
- 不向外部服务器发送任何文件内容（除非手动启用 AI 功能）
- 支持访问密码保护

## 开源协议

[MIT License](LICENSE)

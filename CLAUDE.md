# CLAUDE.md

## Skill 选择策略

- **简单任务** — 如单行修复、小改动、纯问答、明确单一操作等，直接执行，无需调用 skill
- **复杂任务** — 如新功能开发、重构、bug 诊断、多文件改动、需要设计评审等，**自动选择合适的 skill** 来处理（如 brainstorming → writing-plans → test-driven-development 等），即使用户没有明确指定 skill

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

## 隐私与安全规范

**严禁将包含隐私数据的文件提交到 Git 仓库。** 以下文件一律默认保留在本地，不得 `git add`、`git commit` 或 `git push`：

- 包含 token、API key、secret、password、access_key、private key 等认证凭据的任何文件
- 环境变量文件：`.env`、`.env.local`、`.env.development`、`.env.production` 等（`.env.example` 模板文件除外）
- 证书与密钥：`*.pem`、`*.key`、`*.pfx`、`*.p12`、`*.cert`、`*.crt`
- 任何 OAuth、AWS、GitHub token 等第三方服务凭据

### 原则

1. **默认本地** — 不确定是否包含敏感数据时，默认不提交
2. **模板替代** — 如需共享配置结构，提供 `.example` 模板文件（值用占位符）
3. **提交前隐私检查（强制）** — 每次 `git commit` 前，必须对 `git diff --cached` 的内容执行隐私泄露扫描，检查是否包含以下敏感信息：

   | 类型 | 检测模式 |
   |---|---|
   | Token / API Key | `sk-`、`ghp_`、`gho_`、`xox[bprs]-`、`AKIA`、`eyJ`（JWT） 等前缀 |
   | Password / Secret | `password\s*[:=]`、`secret\s*[:=]`、`passwd` |
   | 手机号 | `1[3-9]\d{9}`（中国手机号） |
   | 邮箱 | `\S+@\S+\.\S+`（非示例/占位邮箱，如 `test@example.com` 除外） |
   | 私钥 | `-----BEGIN.*PRIVATE KEY-----`、`-----BEGIN RSA PRIVATE KEY-----` |
   | 内网地址 | `192\.168\.`、`10\.\d{1,3}\.\d{1,3}\.\d{1,3}`、`172\.(1[6-9]\|2\d\|3[01])\.` |

   发现匹配后，确认是否为真实敏感数据。真实数据立即移除，仅保留占位符。

4. **误提交处理** — 若不慎提交，立即回滚并轮换所有泄露的凭据

## 发布规范

**严禁默认发布 npm 包。发布是高风险操作，必须逐次授权。**

### 授权规则

1. **逐次授权，无持续性** — 用户必须在 **当前对话回合** 中明确说"发布"、"publish"、"推到 npm"等关键词。一次授权只能用于一轮发布（一个或多个 package），发布完成后授权自动失效
2. **禁止自动发布** — 修复 bug、添加功能、commit、push 后 **不得** 主动建议或执行发布。即使完成了 `git commit && git push`，也必须等用户另外给出发布指令
3. **禁止推测授权** — 以下情况 **不算** 发布授权：
   - 用户说"准备好了"、"搞定了"、"可以了"
   - 用户在讨论发布流程或最佳实践
   - 用户要求 commit/push（commit/push ≠ publish）
   - 上一轮对话中说过"发布"（授权已随回合结束失效）

### 发布前强制检查清单

执行 `npm publish` 或 `pnpm publish` 前，**必须逐项确认**：

| # | 检查项 | 状态 |
|---|---|---|
| 1 | 用户在当前回合明确说了"发布" | ☐ |
| 2 | `pnpm test` 全部通过（156 tests） | ☐ |
| 3 | `pnpm build` 全部成功 | ☐ |
| 4 | `git status` 无未提交的关键改动 | ☐ |
| 5 | 版本号已确认（用户同意 bump 类型） | ☐ |

**任何一项未满足，停止发布流程。**

### 安全和质量

3. **必须使用 `pnpm publish`** — 严禁使用 `npm publish`。`pnpm publish` 会自动将 `workspace:^` 协议解析为实际版本号。使用 `npm publish` 会导致发布的包依赖中残留 `workspace:^`，npm 无法安装。
4. **发布前验证** — 发布前必须完成：
   - 所有测试通过（`pnpm test`）
   - `pnpm build` 全部成功
5. **token 安全** — npm token 仅存储在 `~/.npmrc`，不得出现在任何项目文件中
6. **选择性发布** — 使用 `bash scripts/publish.sh <package> [bump]`，只发布有变更的包

### 历史记录清理（隐私数据已入 Git 历史时）

**优先级：先轮换凭据，再清理历史。** 清理 Git 历史不能让已泄露的 token 失效，必须先在服务端 revoke / rotate 所有暴露的凭据。

#### 推荐方案：`git filter-repo`

```bash
pip install git-filter-repo

# 删除某个文件的所有历史记录
git filter-repo --path .env --invert-paths

# 替换历史中的敏感字符串
git filter-repo --replace-text <(echo 'sk-abc123xxx==>***REDACTED***')
```

#### 备选方案

| 工具 | 说明 |
|---|---|
| `git filter-repo`（推荐） | Python 工具，速度快，安全校验 |
| BFG Repo-Cleaner | Java 工具，比 `filter-branch` 快 |
| `git filter-branch` | Git 内置，但慢且容易出错 |

#### 清理后操作

```bash
# 1. 强制推送
git push origin --force --all
git push origin --force --tags

# 2. 清理本地引用
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

#### 协作者须知

所有 clone 过仓库的人必须**删除本地副本后重新 clone**（不能 `git pull`），否则后续推送可能将敏感数据重新引入。

> GitHub 会将 force-push 前的旧 commits 在 `https://github.com/<org>/<repo>/security/secret-alerts` 中保留。推送清理后，联系 GitHub Support 请求清除缓存。

## 项目概述

Doc77 是一个"默认安全、对话驱动"的智能本地文档管理 Agent。

- **技术栈**：Node.js, TypeScript, Express, SQLite, MCP Protocol
- **架构**：monorepo（4 个 package：core, mcp, ai, cli）
- **当前状态**：开发中

## Git 提交规范

- **提交者**：所有 commit 必须包含 `Co-Authored-By: xyy277 <907507646@qq.com>` 作为结尾
- **提交信息格式**：`type: description`（type = feat / fix / style / refactor / chore / docs）

## 开发工作流

- **构建**：`pnpm build`
- **启动开发服务**：`pnpm dev:start`（构建 + 启动，端口 2777，绑定 0.0.0.0 用于测试）
- **重启开发服务**：`pnpm dev:restart`（杀旧进程 + 构建 + 启动，绑定 0.0.0.0）
- **运行测试**：`pnpm test`
- **不要使用** `doc77 start` 全局命令开发，那是生产安装方式
- **开发服务默认绑定 0.0.0.0**，以便在移动端设备或其他主机上进行测试访问

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

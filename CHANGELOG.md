# Changelog

本文档记录 Doc77 各 package 的版本变更。遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

---

## [2026-07-08]

### @doc77/core `0.2.5`

**Changed**
- 改进静态文件目录解析：增加 3 个候选路径 (`dist/web/`, `src/web/`, `dist/../src/web/`)，覆盖更多部署场景
- 添加显式 `GET /` 路由，即使 web 目录缺失也返回 fallback HTML，避免 404
- 移除跨包导入 (`../../mcp/src/transaction/executor.js`)，新增 `createQueueApproveHandler()` 工厂函数导出

**Fixed**
- 首页 404 问题：pnpm workspace 中 `@doc77/core` 解析为旧版 npm 包导致 `express.static` 未挂载

### @doc77/mcp `0.1.6`

**Changed**
- 内部依赖改为 `workspace:^` 协议

### @doc77/ai `0.1.5`

**Changed**
- 内部依赖改为 `workspace:^` 协议

### @doc77/cli `0.1.8`

**Changed**
- 注册 `/api/queue/approve` 路由（`createQueueApproveHandler` + `executeApprovedTasks`）
- 内部依赖改为 `workspace:^` 协议

---

## [2026-07-07]

### @doc77/core `0.2.3`

**Fixed**
- 静态文件打包：build 脚本增加 `cpSync('src/web','dist/web')`，确保发布包包含 web 资源
- 修复 `/api/health` 中 DB 连接检测在 `express.static` 缺失时的崩溃

### @doc77/core `0.2.2`

**Fixed**
- 修复 `express.static` 路径回退逻辑

---

## [2026-06-28]

### @doc77/core `0.2.1`

**Fixed**
- Express 5 类型兼容：`req.query.path` 类型适配

### @doc77/core `0.2.0`

**Added**
- 预览引擎：支持 Markdown、Mermaid、代码高亮、图片、PDF 渲染
- 文件系统抽象层：路径验证、敏感文件检测
- 目录扫描：文件树 + 缓存

---

## [Initial Release]

### @doc77/core `0.1.0`
- 数据库层（SQLite via sql.js）
- 项目管理（CRUD）
- 配置管理
- Express Server + API 路由

### @doc77/mcp `0.1.0`
- MCP 协议实现（stdio / SSE 传输）
- 操作队列与审批流
- 事务系统（Shadow Copy + Rollback）
- Session 管理

### @doc77/ai `0.1.0`
- AI Provider 抽象层
- OpenAI 兼容 adapter
- Agent 核心逻辑

### @doc77/cli `0.1.0`
- CLI 命令入口（`doc77 start|register|list|remove|...`）
- Web Dashboard 启动

---

## 发布说明

- 使用 `bash scripts/publish.sh <package> [bump]` 选择性发布，非全部发布
- `workspace:^` 协议确保开发时链接本地包，发布时自动替换为版本号

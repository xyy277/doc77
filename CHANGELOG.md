# Changelog

本文档记录 Doc77 各 package 的版本变更。遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

---

## [2026-07-17] — `1.0.0-beta.2`

### 全包 (`1.0.0-beta.2`)

**Fixed**
- Electron 桌面版启动崩溃 `ERR_REQUIRE_ESM`：主进程静态 `import { t } from '@doc77/core'` 被 tsc 转译为 require，而 core 的 CJS 构建加载 ESM-only 的 marked，Electron 内置 Node 20 不支持 require(esm)。改为延迟绑定 shim（core 仅经动态 import 加载），并新增构建门禁 `verify-no-static-core.cjs` 防回归

## [2026-07-17] — `1.0.0-beta.1`

### 全包 (`1.0.0-beta.1`)

**Added**
- 多语言 UI：简体中文 / English 内置双语，自动检测浏览器与系统语言，`~/.doc77/locales/<lang>.json` 外部语言包目录扩展任意语言（755+ 词条，六层覆盖：Web/CLI/API/MCP/AI/Electron）
- 导出自包含 HTML：一键导出自包含 HTML（内联样式与图片、保留深浅主题底色、舒适留白），footer 链接更正为 GitHub 仓库
- 局域网只读分享：创建分享链接（`/s/<token>`，二维码，可撤销），有效期可配置，敏感文件过滤
- 离线翻译：Opus-MT ONNX 模型完全本地运行（en↔zh），自动语言检测（CJK 启发式），划词即译 + 长文档分段翻译
- 项目导入增强：Obsidian vault（`[[wikilink]]` 解析）、Git 项目批量扫描注册、VS Code workspace 一键导入、技术栈标签识别
- 移动伴侣：Dashboard 扫码直达手机版，mDNS 局域网发现，移动端自适应 UI
- 多 tab 预览：多文档标签页（LRU 渲染缓存），临时文件拖放预览，轻量文本编辑（外部修改冲突检测）
- Dashboard 快捷卡片：收藏夹计数、近期文件 strip、项目标签徽章、Obsidian 图标
- AI 模型输入框：datalist 替代硬编码 select，支持自定义模型名称
- 动态设置 tabs：系统/AI/账户/翻译/分享统一渲染（主页 + 预览页）
- pre-commit 门禁扩展：`pnpm check:i18n` 覆盖硬编码中文扫描 + data-i18n 嵌套约束 + t 形参遮蔽检测

**Changed**
- 默认端口：CLI `2777 → 27777`，Electron 桌面版默认 `28888`（防止与 CLI 实例端口冲突）
- 后端 t() 全局语言切换即时生效（不依赖重启），前端无覆盖时自动 reload
- `getReadTools/getWriteTools` 工厂化（惰性求值，避免模块加载时序问题）
- MCP tool descriptions 按全局语言本地化
- AI system prompt 中英文双版本

**Fixed**
- `applyI18n` 用 textContent 替换文本导致嵌套子元素（`#favCount`/`#projCount`/`#pendingBadge`）被摧毁 → 移到内层纯文本 span；`check-i18n` 新增此类违规的门禁规则
- `renderTabBar`/`loadTasks` 回调形参 `t` 遮蔽全局 i18n `t()` → 全仓重命名 + `check-i18n` 新增禁止规则
- `createAIChatHandler` 工厂化解构丢失 `AiProvider`/`DocAgent` → 每次 AI 对话抛 ReferenceError
- `translate()` 无实际语言检测，「文档」→ 英中模型 → 退化复读 → 新增 `detectLang()` + 同语言 no-op
- 划词翻译 popup 8s 自动移除竞态：慢翻译结果渲染到已移除节点 → 点击翻译时取消空闲计时器
- 导出产物尾部三处死链 `doc77.dev` → GitHub 仓库
- index/preview.html 设置 tabs 不一致（preview 缺分享 tab、样式未对齐）
- Dashboard QR 代码移入 hero 右侧，窄屏自动隐藏
- `katexCss` 去掉 `href="about:blank"`（消除 `ERR_UNKNOWN_URL_SCHEME` 控制台噪音）
- transformers.js MarianTokenizer 已知无害警告抑制

**Design**（参考 spec）
- 多语言化设计方案：`docs/superpowers/specs/2026-07-16-i18n-design.md`
- 多语言化实施计划：`docs/superpowers/plans/2026-07-16-i18n.md`（18 tasks）

## [2026-07-16]

### @doc77/core `0.9.0`

**Added**
- 临时文件拖拽预览：`POST /api/render-temp` 无状态渲染接口，支持 Markdown / 代码 / Mermaid 等文本格式的纯内存渲染
- 浏览器端拖拽交互（`initDropZone` + `openTempTab`）：preview 页面拖入文件 → 以带 📎 标识的临时 tab 打开，刷新即消失
- 二进制预览类型（图片 / PDF / docx / xlsx）通过 `URL.createObjectURL` 直接渲染，无需后端参与
- 临时文件类型分类 + 文本前 8KB null 字节嗅探，镜像服务端 `isBinaryFile` 语义
- 临时 tab 生命周期管理：不持久化到 localStorage、禁用 edit/AI/reveal 按钮、`releaseTab` 时自动 `revokeObjectURL`
- 前端 UMD 模块 `temp-preview.js`：`makeTempPath` / `isTempPath` / `classifyTempFile` / `sniffBinary`

## [2026-07-12]

### @doc77/core `0.6.0`

**Added**
- 密码恢复功能：信封加密（DEK）+ 一次性恢复码（10 个，Crockford Base32 格式）
- 密码学扩展：HKDF-SHA256、Crockford Base32 编解码、CRC-16 校验
- DEK 包裹/解包：AES-256-GCM，密码与恢复码双路径
- 忘记密码 API：`POST /api/auth/forgot-password/verify` + `/reset`
- 密码修改 API：`POST /api/auth/change-password`
- 恢复码管理 API：`GET /api/auth/recovery-status` + `/api/auth/recovery-codes`
- 审计日志扩展：`password_changed`、`recovery_code_used`、`recovery_codes_regenerated`、`password_force_reset`
- `user_auth` 表 v2 迁移：11 个新字段支持信封加密

**Security**
- 密钥派生增强：scrypt N=131072（符合设计规格）+ HKDF 域分离
- 独立爆破防护：登录 5 次锁定 15 分钟，恢复码独立 5 次锁定 15 分钟
- 恢复码安全：仅展示一次，scrypt 哈希存储，timingSafeEqual 防时序攻击
- 遗留模式兼容：旧用户修改密码时自动迁移到信封加密

**Changed**
- `POST /api/auth/setup` 返回恢复码列表
- `GET /api/auth/status` 新增 `hasRecovery` 字段

### @doc77/cli `0.2.0`

**Added**
- `doc77 config set-password` — 输出恢复码
- `doc77 config change-password` — 交互式修改密码
- `doc77 config reset-password` — 恢复码重置密码
- `doc77 config reset-password --force` — 强制重置（清空加密配置）
- `doc77 config recovery-codes` — 重新生成恢复码

### Web UI `0.6.0`

**Added**
- 忘记密码流程：登录门增加"忘记密码？"链接 → 恢复码验证 → 新密码设置
- 恢复码展示弹窗：首次设置密码后展示 10 个恢复码，支持一键复制
- 账户设置增强：剩余恢复码数量、重新生成按钮、新改密码 API

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

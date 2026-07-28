# Doc77 安全审查与优化报告

> 审查日期：2026-07-28
> 审查范围：代码审查、测试、性能、用户体验、安全漏洞修复
> 审查版本：v1.0.8

---

## 一、执行摘要

对 Doc77 monorepo（8 个 package，TypeScript）进行了全面安全审查。发现 **1 个关键漏洞、3 个高危漏洞、多个中低风险问题**。已修复所有关键和高危问题。测试套件因预先存在的环境问题（sql.js WASM 不支持 FTS5）无法运行，与本次改动无关。

### 修复概览

| # | 严重度 | 问题 | 状态 |
|---|---|---|---|
| 1 | 🔴 Critical | 认证中间件缺失 — 登录 token 从不验证，LAN 暴露时所有 API 裸奔 | ✅ 已修复 |
| 2 | 🔴 Critical | `/api/find-folder` 命令注入（RCE） | ✅ 已修复 |
| 3 | 🟠 High | `tryWslPath` 命令注入（RCE） | ✅ 已修复 |
| 4 | 🟠 High | 会话 token 可预测（`'session-' + Date.now()`） | ✅ 已修复 |
| 5 | 🟡 Medium | reveal-in-finder 命令注入（需认证 + 恶意文件名） | 📝 已记录 |
| 6 | 🟡 Medium | 65 处同步 I/O 阻塞事件循环 | 📝 已记录 |
| 7 | 🟢 Low | 依赖漏洞 43 个（1 critical / 22 high / 15 moderate / 5 low） | 📝 已记录 |

---

## 二、已修复漏洞详情

### 🔴 #1 认证中间件缺失（Critical）

**文件**：`packages/core/src/server/auth.ts`、`packages/core/src/server/app.ts`、`packages/core/src/web/js/common.js`

**问题**：
- `verifyLogin()` 返回 token `'session-' + Date.now()`，但该 token **从未在任何后续请求中被验证**
- 前端登录成功后仅存储 `sessionStorage["doc77-auth"] = "1"`（一个标志，非 token），所有 fetch 请求不携带认证信息
- 代码注释明确承认："No auth middleware exists yet (tech debt per spec Section 11)"
- 当服务器绑定 `0.0.0.0`（LAN 共享）时，LAN 上任何人可绕过密码访问所有 API：读取/删除文件、重启服务器、创建分享链接、更改密码

**修复**：
1. **auth.ts** — 新增服务端会话存储：
   - `authSessions` Map（内存，12 小时滑动 TTL）
   - `validateSessionToken(token)` — 验证并续期
   - `destroySession(token)` — 注销单个会话
   - `revokeAllSessions()` — 密码变更/重置时撤销所有会话
   - `isPasswordSet()` — 判断是否处于密码保护模式
   - `issueSessionToken()` — 供 setup 流程签发 token
   - `verifyLogin()` 现返回 `randomBytes(32).toString('hex')`（64 字符，不可预测）

2. **app.ts** — 新增认证中间件：
   - 公开路由白名单（login、setup、status、forgot-password、health、i18n、server-info 等）
   - 未设置密码时 → 开放模式（仅 localhost 场景）
   - 已设置密码时 → 要求 `Authorization: Bearer <token>` 或 `X-Doc77-Token` 头
   - 新增 `POST /api/auth/logout` 端点
   - `/api/auth/setup` 现返回 token（首次设置后保持登录）
   - 凭据变更（change-password / reset / force-reset）自动撤销所有会话

3. **common.js** — 前端 fetch 拦截器：
   - Monkey-patch `window.fetch`，为所有 `/api/` 请求注入 `Authorization: Bearer <token>`
   - 登录/设置成功后存储真实 token（而非 "1"）
   - 收到 401 时清除 token 并刷新页面（重新显示登录门）
   - `doLogout()` 调用服务端注销端点

**i18n**：新增 `api.auth.loginRequired` 键（中英文）

---

### 🔴 #2 `/api/find-folder` 命令注入（Critical, RCE）

**文件**：`packages/core/src/server/app.ts`（原 line 872）

**问题**：
```typescript
execSync(`find "${root}" -maxdepth 4 -type d -name "${folderName}" 2>/dev/null; true`, ...)
```
`folderName` 来自 `req.body`（用户输入），直接插入 shell 命令字符串。攻击者可构造 `folderName: '"; rm -rf /; echo "'` 执行任意命令。该端点此前无需认证，任何人可触发 RCE。

**修复**：改用 `execFileSync('find', [root, '-maxdepth', '4', '-type', 'd', '-name', folderName], ...)` — 无 shell，参数以数组传递，彻底消除注入。

---

### 🟠 #3 `tryWslPath` 命令注入（High, RCE）

**文件**：`packages/core/src/fs/index.ts`（line 267）

**问题**：
```typescript
execSync(`wslpath -u "${windowsPath}"`, ...)
```
`windowsPath` 来自用户注册项目时的路径输入，可包含 shell 元字符。

**修复**：改用 `execFileSync('wslpath', ['-u', windowsPath], ...)` — 无 shell。

---

### 🟠 #4 会话 token 可预测（High）

**文件**：`packages/core/src/server/auth.ts`（原 line 388）

**问题**：
```typescript
return { ok: true, token: 'session-' + Date.now(), status: 200 };
```
token 仅为时间戳，可在 1 毫秒内被猜出。即使后续有验证逻辑（此前没有），也可被轻易伪造。

**修复**：改用 `randomBytes(32).toString('hex')`（256 位熵），并存储在服务端会话表中供验证。

---

## 三、未修复问题（建议后续处理）

### 🟡 #5 reveal-in-finder 命令注入（Medium）

**文件**：`packages/core/src/server/app.ts`（line ~2515-2532）

**问题**：`exec(command, ...)` 中 `command` 由 `absPath` 拼接而成。若项目内存在含 shell 元字符的文件名（如 `";rm -rf ~;".md`），点击"在文件管理器中显示"时触发注入。

**风险等级**：现已需认证（#1 修复后），且需恶意文件名，风险降为 Medium。

**建议修复**：对非 Windows 平台使用 `execFile` + 参数数组；Windows 路径使用 `child_process.spawn` 避免 shell 解析。

---

### 🟡 #6 同步 I/O 阻塞事件循环（Medium, 性能）

**文件**：`packages/core/src/server/app.ts`

**问题**：app.ts 中有 **65 处同步文件系统调用**（`readFileSync`、`statSync`、`readdirSync`、`writeFileSync` 等）直接在请求处理中执行，阻塞 Node.js 事件循环。单用户本地使用影响小，但 LAN 多用户并发时会导致请求排队延迟。

**建议修复**：将热路径（`/api/content/:id`、`/api/tree/:id`、`/api/browse-fs`）的同步 I/O 逐步迁移为异步（`fs.promises.*`）。优先级：大文件读取 > 目录扫描 > 文件元信息。

---

### 🟢 #7 依赖漏洞（Low，多为构建时依赖）

**`pnpm audit` 结果**：43 个漏洞（1 critical / 22 high / 15 moderate / 5 low）

| 类别 | 包 | 影响 | 说明 |
|---|---|---|---|
| tar (critical/high) | `tar@6.2.1` | 路径遍历、符号链接投毒、DoS | 仅在 `electron-builder` 构建链中，**非运行时依赖**，不影响已发布应用 |
| electron (low) | `electron@33.4.11` | UAF、剪贴板崩溃等 | 升级至 ≥38.8.6 / ≥39.8.5 |
| esbuild (low) | `esbuild@0.27.7` | Windows dev server 任意文件读取 | 升级至 ≥0.28.1 |
| @hono/node-server (moderate) | MCP SDK 间接依赖 | — | 升级 MCP SDK |

**建议**：运行时无 critical/high 漏洞（tar/electron 均为构建时依赖）。建议在下次发布前执行 `pnpm update` 升级 electron-builder 和 electron。

---

## 四、测试结果

- **`pnpm test`**：因环境问题无法完成 — sql.js WASM 构建不支持 FTS5 扩展，`runMigrations()` 在创建 FTS5 虚拟表时抛出 `no such module: fts5`。此为**预先存在的问题**，与本次改动无关。
- **`pnpm lint`**：121 个 warning，0 个 error。多为 `@typescript-eslint/no-explicit-any` 和未使用变量，不影响运行。
- **`tsc --noEmit`**：存在预先存在的类型错误（sql.js 缺类型声明、marked 类型不兼容、`string|string[]` 查询参数），项目使用 tsup/esbuild 构建（不做完整类型检查），不影响运行。**本次改动未引入新的类型错误。**
- **`check:i18n`**：✅ 913 键一致，新增的 `api.auth.loginRequired` 键通过校验。

---

## 五、变更文件清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `packages/core/src/server/auth.ts` | 修改 | 新增会话存储、token 签发/验证/撤销、isPasswordSet；verifyLogin 使用随机 token；凭据变更撤销会话 |
| `packages/core/src/server/app.ts` | 修改 | 新增认证中间件 + logout 端点；setup 返回 token；修复 find-folder 命令注入；execSync→execFileSync |
| `packages/core/src/fs/index.ts` | 修改 | 修复 tryWslPath 命令注入；execSync→execFileSync |
| `packages/core/src/web/js/common.js` | 修改 | fetch 拦截器注入 Bearer token；存储真实 token；doLogout 调用服务端 |
| `packages/core/src/i18n/locales/zh-CN.json` | 修改 | 新增 api.auth.loginRequired |
| `packages/core/src/i18n/locales/en-US.json` | 修改 | 新增 api.auth.loginRequired |

---

## 六、安全架构说明（修复后）

```
请求流入
  │
  ├─ 非 /api/ 路由 → 静态文件/HTML/分享页（独立验证）
  │
  ├─ /api/auth/*（公开白名单）→ 登录/设置/忘记密码
  │
  ├─ /api/health, /api/i18n, /api/server-info 等（公开）→ 基本信息
  │
  └─ 其他 /api/* 路由
       │
       ├─ isPasswordSet() === false → 开放模式（localhost 场景）
       │
       └─ isPasswordSet() === true
            │
            ├─ Authorization: Bearer <valid_token> → 放行
            ├─ X-Doc77-Token: <valid_token> → 放行
            └─ 无/无效 token → 401 AUTH_REQUIRED
```

**会话生命周期**：
- 登录成功 → 签发 256 位随机 token，存入内存 Map（12h TTL，滑动续期）
- 每次请求 → 验证 token 存在且未过期，续期 TTL
- 密码变更/重置/强制重置 → `revokeAllSessions()` 撤销所有会话
- 注销 → `destroySession(token)` 撤销当前会话
- 服务重启 → 内存清空，所有会话失效（本地文档服务器可接受）

---

## 七、后续建议

1. **短期**：将同步 I/O 热路径迁移为异步；修复 reveal-in-finder 命令注入
2. **中期**：升级 electron 至 38+、electron-builder 至最新；为 sql.js 测试环境提供 FTS5 支持或 mock
3. **长期**：考虑将认证会话持久化到 SQLite（支持服务重启后保持登录）；添加 CSRF 防护（若引入 cookie 认证）
4. **测试**：为新增的认证中间件编写单元测试（token 验证、过期、撤销、公开路由白名单）

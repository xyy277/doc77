# Electron 强制重设设计文档（Force Reset）

日期：2026-08-11
状态：已确认（brainstorming 两节设计均通过）
分支：feature/electron-force-reset

## 1. 背景与问题

Doc77 采用信封加密（Envelope Encryption）：密码与 10 个 recovery code 分别包裹同一个 DEK（Data Encryption Key），DEK 用于加密 config 中的敏感项（AI token、base_url、model 等）。

当用户**同时忘记密码和 recovery code** 时，现有逃生通道全部失效：

| 通道 | 位置 | 失效原因 |
|---|---|---|
| 忘记密码 → recovery code 重置 | 登录页 `showForgotPassword()` | recovery code 也忘记 |
| `/api/auth/force-reset`（web） | `packages/core/src/server/app.ts:3322` | 要求输入当前密码 + `yes-i-know`，密码忘记即死路 |
| `doc77 config reset-password --force` | CLI | Electron 用户未安装 npm CLI |

后果：Electron 用户被永久锁定在自己的本地应用中。

## 2. 目标与非目标

### 目标

- Electron 应用内提供「忘记密码和恢复码」强制重设入口，重设后回到设置新密码流程
- 重设清除所有敏感数据（密码类、token 类），保留项目文档与业务数据
- 安全上区别于未授权访问：LAN / 远程攻击者无法通过 web 页面触发重设
- 复用现有 `forceResetPassword()`，改动最小化

### 非目标

- 不提供「保留 AI 配置的免密恢复」能力（那是 OS Keychain 方案，列为后续候选）
- 不修改 web 端 `/api/auth/force-reset` 的密码验证要求（保持 LAN 攻击面不变）
- 不引入新依赖、不修改数据库 schema（无 migration）

## 3. 现状梳理

### 3.1 认证机制（`packages/core/src/server/auth.ts`）

- `setupPasswordWithDEK()`：生成 DEK → 密码 + 10 个 recovery code 分别包裹 → 存 `user_auth` 表
- `forceResetPassword()`：清空 `user_auth` 全部认证字段 + 删除硬编码的 3 个 AI config key + `revokeAllSessions()`
- DEK 仅加密 config 敏感项；**用户文档为磁盘明文文件，不受 DEK 影响**

### 3.2 Electron 架构（`packages/electron/`）

- 薄壳：主进程 in-process 启动 core 的 Express app（`DOC77_ELECTRON=1`），DB 位于 `~/.doc77/data.db`
- `preload.ts` 通过 contextBridge 暴露 `window.doc77`（IPC 桥），仅在 Electron 渲染进程存在
- 主进程可直接调用 core 函数（`server.ts` 已动态 import core）

### 3.3 登录 gate（`packages/core/src/web/js/common.js`）

- `hasPassword=false` 且非 legacy → `showSecurityPrompt()`（设置密码流程）——重设后 reload 即自然回到此流程
- 现有「忘记密码」链接走 recovery code 流（`showForgotPassword()`）

### 3.4 威胁模型

DB 位于用户本地磁盘，有本机访问权者本就可直接改/删 DB 或装 CLI 强制重设。认证防的是 LAN / 远程攻击者（服务器绑 0.0.0.0 时）。因此：重设通道**仅在 Electron 进程内走 IPC + 原生对话框**，不产生新攻击面。

## 4. 方案设计

### 4.1 组件与改动

| 组件 | 改动 | 职责 |
|---|---|---|
| `packages/core/src/server/auth.ts` | 扩展 `forceResetPassword()` | 清除范围扩展至全部敏感 config；清空 `resetState`；审计 source 参数化 |
| `packages/electron/src/main.ts` | 新增 `ipcMain.handle('auth:forceReset')` | 原生 `dialog.showMessageBox` 确认 → in-process 调用 `forceResetPassword()` |
| `packages/electron/src/preload.ts` | 暴露 `window.doc77.reset.forceReset()` | IPC 桥新增方法 |
| `packages/core/src/web/js/common.js` | 登录 gate 新增入口与覆盖层 | 仅 Electron 显示链接 → 输入 `yes-i-know` 确认 → 调 IPC → reload |
| i18n 字典 | en-US.json / zh-CN.json / electron i18n.ts | 新增文案 key |

### 4.2 数据流

```
① 登录页（仅 Electron 渲染进程显示）:
   "忘记密码？" 下方新增 "忘记密码和恢复码？" 链接
   （window.doc77 不存在时不渲染）

② 点击 → 内页覆盖层:
   警告文案（清除：密码、恢复码、AI 配置等敏感配置；保留：项目文档、非敏感设置）
   输入框：输入 yes-i-know 后「执行重置」按钮才可用

③ window.doc77.reset.forceReset() → IPC 'auth:forceReset'

④ 主进程 dialog.showMessageBox 最终确认:
   "将清除密码与全部敏感配置（AI token 等）。文档不会丢失。"
   [取消] / [继续重置]

⑤ 确认 → forceResetPassword('electron') → revokeAllSessions()
        → 返回 {ok:true}

⑥ 渲染进程收到 ok → location.reload()
   → gate 检测 hasPassword=false → showSecurityPrompt()
   → 用户设置新密码 → 生成全新 recovery codes
```

### 4.3 安全边界

| 攻击场景 | 结果 |
|---|---|
| LAN 攻击者在普通浏览器访问登录页 | 无 `window.doc77` → 链接不显示、IPC 不可达 → 无法触发 |
| 攻击者伪造 HTTP 请求 | IPC 是进程内通道，HTTP 无法触达 → 无法触发 |
| 攻击者控制本机账户 | 等同于物理访问（可直接改/删 DB 或装 CLI），威胁模型不变，无新增攻击面 |
| web 端（非 Electron） | `/api/auth/force-reset` 保持密码验证，LAN 攻击面不变 |

双重确认（页面输入 `yes-i-know` + 主进程原生对话框）与现有 CLI/web 确认惯例一致。

## 5. 数据清除范围

`forceResetPassword()` 硬编码 3 个 AI key 改为**遍历 config 表，删除所有 `isSensitiveKey(key)` 匹配的行**（token / secret / password / apikey / authorization 关键词），将来新增敏感配置自动覆盖。

| 内容 | 处理 |
|---|---|
| user_auth 认证字段（密码、recovery codes、DEK、salts） | 清除（现有逻辑） |
| 全部敏感 config（AI token / base_url / model 等） | 清除（扩展：由硬编码 3 个 → 按 isSensitiveKey 全量） |
| `resetState`（内存中 5 分钟 TTL 的 DEK 暂存） | 清除（新增，防旧 reset token 残留） |
| 项目文档、业务数据（DB 其他表、磁盘文件） | 保留 |
| 非敏感 config（语言、端口、主题等） | 保留 |
| 所有登录会话 | `revokeAllSessions()`（现有逻辑） |

审计日志：`writeAuditLog('password_force_reset', {}, source, 'success')`，source 参数化：CLI 传 `'cli'`（现状）、Electron 传 `'electron'`（新增）。

## 6. 错误处理与边界情况

- IPC handler 全程 try/catch：DB 未初始化等异常 → `{ok:false, error}`，页面 toast 显示
- 用户取消原生对话框 → `{cancelled:true}`，无副作用
- 非 Electron 环境（纯浏览器）：`window.doc77` 不存在 → 链接不渲染、调用 no-op，天然降级
- 重置后 reload 期间失败 → 下次打开仍为登录页，状态一致，可重试
- 重置中已有会话在其他设备登录 → `revokeAllSessions()` 立即失效

## 7. i18n

新增 key（`en-US.json` + `zh-CN.json` 的 `common.login.*` 与 `electron.dialog.*` 系列）。注意：`packages/electron/src/i18n.ts` 是 shim，其 `t()` 委托 core 字典，**原生对话框文案 key 也放 core 字典**（electron/i18n.ts 本身无需改动）：

- 链接：Forgot password and recovery codes? / 忘记密码和恢复码？
- 覆盖层：清除内容说明、保留内容说明、`yes-i-know` 输入提示、执行中 / 成功 / 失败 / 已取消
- 原生对话框：标题、正文、按钮

## 8. 测试

- `packages/core/__tests__/auth.test.ts` 扩展 `forceResetPassword` 测试：
  - 造多个敏感 / 非敏感 config key → 断言敏感全删、非敏感保留
  - 断言 `user_auth` 认证字段清空
  - 断言 `resetState` 清空（verifyStoredResetToken 返回 invalid）
- Electron IPC handler 保持薄壳（dialog + 调 core），核心逻辑均在 core 层覆盖
- web JS 为原生 JS 无测试框架，交互流程手工验证（dev server 手动走一遍；注：部分开发环境沙箱无法 bind socket 启动 server（exit 144），此时仅能依靠 core 层 unit test 覆盖，完整交互验证需在真实环境进行）

## 9. 验证清单（提交前 CI 预检）

CLAUDE.md 强制：`pnpm format:check && pnpm lint && pnpm check:i18n && pnpm build && pnpm test`

## 10. 变更文件清单

- `packages/core/src/server/auth.ts`（forceResetPassword 扩展）
- `packages/core/src/web/js/common.js`（登录 gate 入口 + 覆盖层）
- `packages/core/src/i18n/locales/en-US.json`、`zh-CN.json`（文案，含 `electron.dialog.*`——Electron 主进程经 i18n shim 委托 core 字典）
- `packages/electron/src/main.ts`（IPC handler + 原生对话框）
- `packages/electron/src/preload.ts`（IPC 桥方法）
- `packages/core/__tests__/auth.test.ts`（测试扩展）

## 11. 后续候选（本次不做）

- OS Keychain 备份密钥（safeStorage / DPAPI / Keychain / Secret Service）：免密恢复且保留 AI 配置，零数据丢失。需要 DB migration、Linux 无 keyring 降级处理，列为独立后续工作。

# Electron 强制重设（Force Reset）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Electron 用户提供「忘记密码和恢复码」时的应用内强制重设入口：IPC + 原生对话框双重确认后调用扩展的 `forceResetPassword()`，清除全部敏感配置、保留文档，回到设置新密码流程。

**Architecture:** core 层扩展 `forceResetPassword()`（全敏感 config 清除 + resetState 清空 + source 参数）；Electron 主进程新增 `auth:forceReset` IPC handler（原生对话框确认后动态 import core 执行）；preload 暴露 `window.doc77.reset.forceReset()`；web 登录 gate 仅在 Electron 渲染进程（`window.doc77` 存在）显示「忘记密码和恢复码？」入口与覆盖层。

**Tech Stack:** Node.js / TypeScript / Express / SQLite / Electron / 原生 JS web UI / vitest

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-electron-force-reset-design.md`
- 分支：`feature/electron-force-reset`（已建，含 spec 提交）
- Commit 格式：`type(scope): description`，**每个 commit 必须以 `Co-Authored-By: xyy277 <907507646@qq.com>` 结尾**
- Commit 前隐私检查：`git diff --cached` 扫描 token/password/邮箱/内网 IP 等模式（见 CLAUDE.md）
- Electron main 进程是 CJS 编译，core 含 ESM-only 依赖，**只能通过动态 import 加载 core**（`new Function('specifier', 'return import(specifier)')` 模式，见 `packages/electron/src/server.ts:47`）
- Electron 主进程 i18n 用 `packages/electron/src/i18n.ts` 的 `t()`（委托 core 字典）——对话框文案 key 必须放 core 的 `en-US.json` / `zh-CN.json`
- 修改 core 文件后需同步 `packages/core` 内引用（CLI 无参调用 `forceResetPassword()` 必须保持兼容，默认 `source='cli'`）
- 文档语言规范：代码/字段名保持英文，中文说明见项目 CLAUDE.md
- 测试环境沙箱无法 bind socket 启动 server（exit 144）——web/electron 交互流程无法在本沙箱端到端验证，以 core 层测试 + 编译通过为准

---

### Task 1: core — 扩展 forceResetPassword（全敏感 config 清除 + resetState 清空 + source 参数）

**Files:**
- Modify: `packages/core/src/server/auth.ts:909-939`（forceResetPassword 函数）
- Test: `packages/core/__tests__/auth.test.ts`（describe('Force reset') 内新增 2 个 it）

**Interfaces:**
- Consumes: `crypto.isSensitiveKey(key: string): boolean`（已存在于 `../crypto.js`）；`getConnection()`（`../db/connection.js`）；模块内 `resetState`（auth.ts:136）；`writeAuditLog(operationType, operationData, source, status)`（auth.ts:10）
- Produces: `forceResetPassword(source?: string): void`（新增可选参数 `source`，默认 `'cli'`，Electron 传 `'electron'`；CLI 无参调用兼容）

- [ ] **Step 1: 写失败测试**

在 `packages/core/__tests__/auth.test.ts` 的 `describe('Force reset')` 内、现有 `'should force reset and clear everything'` 之后追加两个 it：

```ts
  it('should clear all sensitive config but keep non-sensitive keys', () => {
    const db = getConnection();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('ai.token', 'wrapped-token')").run();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('ai.base_url', 'wrapped-url')").run();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('translate.apikey', 'wrapped-key')").run();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('server.port', '27777')").run();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('locale.language', 'zh-CN')").run();

    forceResetPassword('electron');

    const keys = (db.prepare('SELECT key FROM config').all() as { key: string }[]).map((r) => r.key);
    expect(keys).not.toContain('ai.token');
    expect(keys).not.toContain('ai.base_url');
    expect(keys).not.toContain('translate.apikey');
    expect(keys).toContain('server.port');
    expect(keys).toContain('locale.language');
  });

  it('should invalidate pending recovery reset tokens after force reset', () => {
    const codes = setupPasswordWithDEK('token-test-pw');
    expect(codes).not.toBeNull();
    const verified = verifyRecoveryCode(codes!.plaintexts[0]);
    expect(verified.ok).toBe(true);
    expect(verified.resetToken).toBeDefined();

    forceResetPassword();

    const result = resetPasswordWithToken(verified.resetToken!, 'new-password');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('RESET_TOKEN_INVALID');
  });
```

注意：`config` 表 schema 为 `key TEXT PRIMARY KEY, value TEXT`（migrations.ts:113），INSERT OR REPLACE 直接可用。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/zhouj/code/doc77 && pnpm --filter @doc77/core test -- --run auth.test.ts`
Expected: 第一个 it FAIL（现有实现只删 3 个硬编码 key，`translate.apikey` 残留）；第二个 it FAIL（`forceResetPassword` 未清 `resetState`，且 `verifyStoredResetToken` 走 jwt_salt 校验也可能返回 invalid —— 若第二个 it 意外 PASS，以第一个 it 的失败为准，继续实现）。

- [ ] **Step 3: 实现**

将 `packages/core/src/server/auth.ts` 中 `forceResetPassword` 函数（约 909-939 行）替换为：

```ts
export function forceResetPassword(source = 'cli'): void {
  const db = getConnection();
  db.prepare(
    `
    UPDATE user_auth SET
      password_hash = NULL,
      pw_wrap_salt = NULL,
      rc_wrap_salt = NULL,
      jwt_salt = NULL,
      wrapped_dek_by_password = NULL,
      wrapped_dek_by_recovery = NULL,
      recovery_code_hashes = NULL,
      recovery_code_index_hashes = NULL,
      recovery_codes_used = NULL,
      recovery_codes_generated_at = NULL,
      failed_attempts = 0,
      locked_until = NULL,
      recovery_attempts = 0,
      recovery_locked_until = NULL
    WHERE id = 1
  `,
  ).run();

  // Clear ALL sensitive config values (AI token, API keys, etc.) — not just
  // hardcoded keys, so future sensitive configs are covered automatically.
  const rows = db.prepare('SELECT key FROM config').all() as { key: string }[];
  const sensitive = rows.filter((r) => crypto.isSensitiveKey(r.key)).map((r) => r.key);
  if (sensitive.length > 0) {
    const placeholders = sensitive.map(() => '?').join(',');
    db.prepare(`DELETE FROM config WHERE key IN (${placeholders})`).run(...sensitive);
  }

  // Drop any in-flight recovery-code reset state (DEK cached for 5 min).
  resetState.clear();

  writeAuditLog('password_force_reset', {}, source, 'success');

  // All auth state wiped — every existing session is now invalid.
  revokeAllSessions();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /home/zhouj/code/doc77 && pnpm --filter @doc77/core test -- --run auth.test.ts`
Expected: 全部 PASS（含新增 2 个 it 与现有用例）。

- [ ] **Step 5: 提交**

```bash
cd /home/zhouj/code/doc77
git add packages/core/src/server/auth.ts packages/core/__tests__/auth.test.ts
git diff --cached | grep -nE "sk-|ghp_|eyJ|password\s*[:=]|secret\s*[:=]|1[3-9][0-9]{9}|\S+@\S+\.\S+|BEGIN.*PRIVATE KEY|192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+" && echo "PRIVACY HIT — abort" || true
git commit -m "feat(core): extend force reset to wipe all sensitive config

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 2: i18n — 新增登录 gate 与原生对话框文案（en/zh 对称）

**Files:**
- Modify: `packages/core/src/i18n/locales/en-US.json`
- Modify: `packages/core/src/i18n/locales/zh-CN.json`

**Interfaces:**
- Consumes: 无（纯文案）
- Produces: key 全集——Task 3 使用 `common.login.forceReset*` / `common.login.forgotEverything`；Task 4 使用 `electron.dialog.forceReset*`

- [ ] **Step 1: en-US.json 插入 key**

在 `packages/core/src/i18n/locales/en-US.json` 的 `"common.login.forgotPassword"` 之前（按字母序，`forceReset*` 在 `forgot*` 前）插入：

```json
  "common.login.forceResetTitle": "Force reset",
  "common.login.forceResetDescWipe": "This will clear the password, recovery codes, and all sensitive configuration (AI tokens, API keys).",
  "common.login.forceResetDescKeep": "Your documents and projects will be kept.",
  "common.login.forceResetTypeConfirm": "Type yes-i-know to continue",
  "common.login.forceResetBtn": "Execute reset",
  "common.login.forceResetDone": "Reset complete, reloading...",
  "common.login.forceResetFailed": "Reset failed: ",
  "common.login.forceResetCancelled": "Reset cancelled",
  "common.login.forgotEverything": "Forgot password and recovery codes?",
```

在同文件任意 `electron.*` key 附近插入：

```json
  "electron.dialog.forceResetTitle": "Force reset Doc77",
  "electron.dialog.forceResetBody": "This will clear the password and all sensitive configuration (AI tokens etc.). Your documents will not be lost. Continue?",
  "electron.dialog.forceResetConfirm": "Continue reset",
  "electron.dialog.forceResetCancel": "Cancel",
```

- [ ] **Step 2: zh-CN.json 插入对称 key**

在 `packages/core/src/i18n/locales/zh-CN.json` 同样位置插入：

```json
  "common.login.forceResetTitle": "强制重设",
  "common.login.forceResetDescWipe": "将清除：密码、恢复码、AI 配置等全部敏感配置（token、API key 等）。",
  "common.login.forceResetDescKeep": "你的文档与项目数据将完整保留，不会丢失。",
  "common.login.forceResetTypeConfirm": "输入 yes-i-know 以继续",
  "common.login.forceResetBtn": "执行重置",
  "common.login.forceResetDone": "重置完成，正在重新加载...",
  "common.login.forceResetFailed": "重置失败：",
  "common.login.forceResetCancelled": "已取消重置",
  "common.login.forgotEverything": "忘记密码和恢复码？",
```

```json
  "electron.dialog.forceResetTitle": "强制重设 Doc77",
  "electron.dialog.forceResetBody": "将清除密码与全部敏感配置（AI token 等），你的文档不会丢失。确定继续？",
  "electron.dialog.forceResetConfirm": "继续重置",
  "electron.dialog.forceResetCancel": "取消",
```

- [ ] **Step 3: 验证 i18n 对称性**

Run: `cd /home/zhouj/code/doc77 && pnpm check:i18n`
Expected: PASS（en/zh 完全对称）。

- [ ] **Step 4: 提交**

```bash
cd /home/zhouj/code/doc77
git add packages/core/src/i18n/locales/en-US.json packages/core/src/i18n/locales/zh-CN.json
git commit -m "feat(i18n): add force-reset login and dialog copy

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 3: web UI — 登录 gate 强制重设入口与覆盖层（仅 Electron 显示）

**Files:**
- Modify: `packages/core/src/web/js/common.js`（登录卡片 innerHTML ~934 行；Forgot Password Flow 区块后新增函数）

**Interfaces:**
- Consumes: Task 2 的 i18n key；`window.doc77.reset.forceReset()`（Task 4 提供，本任务仅做存在性判断 `typeof window.doc77 !== 'undefined' && !!window.doc77.reset`，preload 注入前不渲染入口）
- Produces: `showForceReset()` / `doForceReset()`（供 `onclick` 使用，全局函数模式与 `showForgotPassword()` 一致）

- [ ] **Step 1: 登录卡片追加 Electron-only 链接**

在 `packages/core/src/web/js/common.js` 约 934 行的正常登录分支，将 `o.innerHTML = '...'` 赋值改为先拼 `forceResetLink` 再赋值（保持原有字符串不变，仅在 `<a href="javascript:showForgotPassword()" ...>...Forgot password?</a>` 之后追加）：

```js
      // Force-reset entry is Electron-only: the IPC bridge (window.doc77)
      // exists only inside the desktop app, so web/LAN clients never see it.
      var isElectron = typeof window.doc77 !== 'undefined' && !!window.doc77.reset;
      var forceResetLink = isElectron
        ? '<a href="javascript:showForceReset()" class="login-gate-link">' + t('common.login.forgotEverything') + '</a>'
        : '';
      o.innerHTML = '<div class="login-gate-card"><div class="login-gate-brand"><div class="login-gate-brand-row"><img src="/assets/favicon.svg" alt="Doc77"><span class="login-gate-brand-name">Doc77</span></div><div class="login-gate-brand-desc">' + t('common.login.tagline') + '</div></div><input id="loginPass" type="password" placeholder="' + t('common.login.enterPassword') + '" class="login-gate-input" onkeydown="if(event.key===\'Enter\')unlock()"><button onclick="unlock()" class="login-gate-btn">' + t('common.login.unlock') + '</button><div id="loginError" class="login-gate-error"></div><a href="javascript:showForgotPassword()" class="login-gate-link">' + t('common.login.forgotPassword') + '</a>' + forceResetLink + '</div>';
```

- [ ] **Step 2: 新增 showForceReset / doForceReset 函数**

在 `packages/core/src/web/js/common.js` 的 `doReset()` 函数之后（`//══════════ Recovery Codes Modal ══════════` 注释之前）追加：

```js
//══════════ Force Reset Flow (Electron only) ══════════
async function showForceReset(){
  var h = document.getElementById("loginGate");
  if(!h) return;
  h.innerHTML = '<div class="login-gate-card"><div class="login-gate-brand"><div class="login-gate-brand-row"><img src="/assets/favicon.svg" alt="Doc77"><span class="login-gate-brand-name">Doc77</span></div><div class="login-gate-brand-desc">' + t('common.login.forceResetTitle') + '</div></div>' +
    '<div style="font-size:12px;color:var(--danger);line-height:1.6;margin-bottom:10px">' + t('common.login.forceResetDescWipe') + '</div>' +
    '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px">' + t('common.login.forceResetDescKeep') + '</div>' +
    '<input id="forceResetConfirm" type="text" placeholder="' + t('common.login.forceResetTypeConfirm') + '" class="login-gate-input login-gate-mono-input" autocomplete="off">' +
    '<button onclick="doForceReset()" class="login-gate-btn">' + t('common.login.forceResetBtn') + '</button>' +
    '<div id="forceResetError" class="login-gate-error"></div>' +
    '<a href="javascript:location.reload()" class="login-gate-link">' + t('common.login.backToLogin') + '</a></div>';
}

async function doForceReset(){
  var c = document.getElementById("forceResetConfirm").value.trim();
  var e = document.getElementById("forceResetError");
  var btn = document.querySelector('.login-gate-btn');
  if(c !== 'yes-i-know'){ e.style.display="block"; e.textContent=t('common.login.forceResetTypeConfirm'); return; }
  e.style.display = 'none';
  if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }
  try {
    var d = await window.doc77.reset.forceReset();
    if(d && d.ok){
      e.style.display="block"; e.textContent=t('common.login.forceResetDone');
      showLoading(t('common.login.forceResetDone'));
      setTimeout(function(){ location.reload(); }, 800);
    } else if(d && d.cancelled){
      e.style.display="block"; e.textContent=t('common.login.forceResetCancelled');
      if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
    } else {
      e.style.display="block"; e.textContent=t('common.login.forceResetFailed') + ((d && d.error) || '');
      if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
    }
  } catch(ex){
    e.style.display="block"; e.textContent=t('common.login.networkError', {message: ex.message});
    if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
  }
}
```

（`showLoading` 为现有全局函数，`doReset()` 已使用 `t('common.loading.passwordReset')` 模式。）

- [ ] **Step 3: 验证语法与构建**

Run: `cd /home/zhouj/code/doc77 && pnpm lint && pnpm build`
Expected: lint PASS（web JS 在 lint 范围内）；build PASS。

- [ ] **Step 4: 提交**

```bash
cd /home/zhouj/code/doc77
git add packages/core/src/web/js/common.js
git commit -m "feat(web): add force-reset entry to login gate (Electron only)

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 4: Electron — auth:forceReset IPC handler、原生对话框、preload 桥

**Files:**
- Modify: `packages/electron/src/main.ts`（`ipcMain.handle('getPort', ...)` 之后新增 handler；顶部加 dynamicImport helper）
- Modify: `packages/electron/src/preload.ts`（`window.doc77` 对象新增 `reset` 命名空间）

**Interfaces:**
- Consumes: Task 2 的 `electron.dialog.*` key（经 `packages/electron/src/i18n.ts` 的 `t()` 委托 core 字典）；core 动态 import
- Produces: `window.doc77.reset.forceReset(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>`（Task 3 调用）；IPC 通道 `'auth:forceReset'`

- [ ] **Step 1: main.ts 添加 dynamicImport helper**

在 `packages/electron/src/main.ts` 顶部 import 区之后（`app.commandLine.appendSwitch` 之前）添加（与 `server.ts:47` 相同的模式）：

```ts
// Main is compiled to CommonJS but core's deps are ESM-only — core may only
// be loaded via dynamic import (see server.ts loadCore).
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<any>;
```

- [ ] **Step 2: main.ts 添加 IPC handler**

在 `packages/electron/src/main.ts` 的 `ipcMain.handle('getPort', () => server?.port ?? 28888);` 之后追加：

```ts
// Force reset — last-resort unlock when password AND recovery codes are
// lost. Gated twice: the IPC channel exists only inside Electron (a web/LAN
// client never reaches it), and this native dialog requires a deliberate
// confirmation before wiping auth state.
ipcMain.handle('auth:forceReset', async () => {
  if (!mainWindow) return { ok: false, error: 'no_window' };
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: t('electron.dialog.forceResetTitle'),
    message: t('electron.dialog.forceResetTitle'),
    detail: t('electron.dialog.forceResetBody'),
    buttons: [t('electron.dialog.forceResetCancel'), t('electron.dialog.forceResetConfirm')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice.response !== 1) return { ok: false, cancelled: true };
  try {
    const core = await dynamicImport('@doc77/core');
    core.forceResetPassword('electron');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
```

（`t` 已从 `./i18n` import，`dialog`、`ipcMain` 已从 electron import，`mainWindow` 为模块级变量。）

- [ ] **Step 3: preload.ts 暴露 reset 桥**

在 `packages/electron/src/preload.ts` 的 `window.doc77` 对象中，`platform: process.platform,` 之后追加：

```ts
  reset: {
    /** Ask the main process to force-reset auth (native dialog confirmation). */
    forceReset: (): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> =>
      ipcRenderer.invoke('auth:forceReset'),
  },
```

- [ ] **Step 4: 验证编译**

Run: `cd /home/zhouj/code/doc77 && pnpm build`
Expected: build PASS（含 `@doc77/electron` 的 `build:main` 与 `build:preload`，以及 `verify-no-static-core.cjs` 校验）。

- [ ] **Step 5: 提交**

```bash
cd /home/zhouj/code/doc77
git add packages/electron/src/main.ts packages/electron/src/preload.ts
git commit -m "feat(electron): add force-reset IPC handler with native dialog

Co-Authored-By: xyy277 <907507646@qq.com>"
```

---

### Task 5: 全量 CI 预检与分支收尾

**Files:** 无（仅验证；若有 format/lint 修复，修正后并入对应提交）

**Interfaces:**
- Consumes: Task 1-4 全部变更

- [ ] **Step 1: 全量 CI 预检**

Run: `cd /home/zhouj/code/doc77 && pnpm format:check && pnpm lint && pnpm check:i18n && pnpm build && pnpm test`
Expected: 全部 PASS。若 `format:check` / `lint` 报错，修复后 amend 到对应任务的 commit（`git commit --amend`），不得新增杂乱提交。

- [ ] **Step 2: 确认提交链与隐私**

Run: `cd /home/zhouj/code/doc77 && git status --short && git log --oneline main..HEAD`
Expected: 工作区干净（`test/1.md` untracked 为既有文件，不动）；提交链为：spec 提交 + Task 1-4 共 5 个提交，全部带 `Co-Authored-By` footer。

- [ ] **Step 3: 汇报验证结果**

汇总：CI 预检输出、提交列表、测试通过数（156 tests 基线），等待用户确认后 push 分支并创建 PR。

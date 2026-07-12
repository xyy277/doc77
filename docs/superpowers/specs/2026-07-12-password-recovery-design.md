# Doc77 密码恢复功能设计

> 状态：设计已确认 | 日期：2026-07-12

## 1. 设计背景

当前系统密码设计较为简单，一旦忘记无法找回——缺少忘记密码功能。Doc77 的使用者可能将系统作为简单的文档服务器部署，因此忘记密码功能需要**独立于邮件/SMTP**的安全结构来防止未授权绕过登录。

本文档定义了基于**信封加密**和**一次性恢复码**的密码恢复方案。

---

## 2. 核心设计：信封加密

### 2.1 模型

```
                     ┌──────────────────┐
                     │   加密配置数据      │
                     │  (AI Token 等)    │
                     └────────┬─────────┘
                              │ AES-256-GCM
                     ┌────────▼─────────┐
                     │  DEK (Data Enc.  │  ← 随机 32 字节，首次设置密码时生成
                     │  Key 数据密钥)    │
                     └────────┬─────────┘
                              │
              ┌───────────────┼───────────────┐
              │                               │
     ┌────────▼────────┐             ┌────────▼────────┐
     │  DEK ← 密码包裹   │             │ DEK ← 恢复码包裹  │
     │  (wrapped_by_pw) │             │ (wrapped_by_rc  │
     └─────────────────┘             │   [0..9])       │
                                     └─────────────────┘
```

- **DEK（Data Encryption Key）**：32 字节随机值，首次设置密码时生成，之后不变
- **密码包裹 DEK**：用户密码通过 scrypt 派生密钥，用 AES-256-GCM 加密 DEK
- **恢复码包裹 DEK**：每个恢复码通过 pbkdf2 派生密钥，用 AES-256-GCM 加密 DEK

### 2.2 场景矩阵

| 场景 | 操作 |
|---|---|
| 首次设置密码 | 生成 DEK → 密码包裹 DEK → 生成 10 个恢复码 → 每个恢复码包裹 DEK |
| 正常改密码 | 旧密码解包 DEK → 新密码重新包裹 DEK。恢复码不受影响 |
| 忘记密码（用恢复码） | 输入恢复码 → 解包 DEK → 新密码包裹 DEK → 该恢复码标记已用 |
| 重新生成恢复码 | 密码解包 DEK → 生成新恢复码 → 包裹 DEK，旧恢复码全部失效 |
| 最坏情况（密码 + 恢复码全丢） | CLI `--force` → DEK 不可恢复 → 加密配置全清空，密码重置 |

---

## 3. 密码学细节

### 3.1 密钥派生

- **密码派生（慢速 KDF）**：`pw_key = scrypt(password, pw_salt, 64, {N: 2^17, r: 8, p: 1})`
- **恢复码派生（相对快速）**：`rc_key = pbkdf2(rc_plaintext, rc_salt, 10000, 32, 'sha256')`
  - 恢复码本身熵够高（120+ bit），不需要 scrypt

### 3.2 DEK 包裹/解包

复用现有 `crypto.ts` 中的 `encrypt()` / `decrypt()` 函数（AES-256-GCM），DEK 作为 plaintext 输入，派生密钥作为 encryption key。

```
wrap(dek, key)  → EncryptedData { iv, tag, ciphertext }
unwrap(data, key) → Buffer
```

### 3.3 恢复码格式

```
格式: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (8 组，4 字符/组)
编码: Base32 (Crockford 变体) — 去掉 I/L/O/U 避免混淆
熵:   120 位 (15 字节随机 → 24 字符 Base32 → 28 字符含分隔符)
校验: 最后 4 个字符是 CRC-16 校验和 (Base32 编码)
```

选择 Crockford Base32 而非 hex：更短，字母和数字区分清晰，不易抄错。

### 3.4 恢复码哈希存储

每个恢复码用 `scryptSync` 独立哈希（去掉分隔符后计算），格式与密码哈希一致：`scrypt:salt:hash`。验证时使用 `timingSafeEqual` 防时序攻击。

---

## 4. 数据库设计

### 4.1 变更后 user_auth 表

```sql
CREATE TABLE user_auth (
    id INTEGER PRIMARY KEY DEFAULT 1,
    password_hash TEXT,
    pbkdf2_salt TEXT,              -- 配置加密迁移前的遗留盐值
    encryption_salt TEXT,           -- 遗留
    wrapped_dek_by_password TEXT,   -- EncryptedData JSON
    wrapped_dek_by_recovery TEXT,   -- EncryptedData[] JSON (10 个)
    recovery_code_hashes TEXT,      -- string[] JSON (10 个 scrypt hash)
    recovery_codes_used TEXT,       -- boolean[] JSON (10 个)
    recovery_codes_generated_at DATETIME,
    failed_attempts INTEGER DEFAULT 0,
    locked_until DATETIME,
    recovery_attempts INTEGER DEFAULT 0,
    recovery_locked_until DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4.2 迁移兼容性

现有已设置密码的用户没有 DEK。启动时检测：如果 `password_hash` 存在但 `wrapped_dek_by_password` 为空 → 视为遗留状态。遗留状态下，配置加密沿用旧的 `deriveKey('doc77-config-key', pbkdf2_salt)` 方式。用户下次修改密码时，自动迁移到信封加密模式。

---

## 5. API 设计

### 5.1 端点列表

| 端点 | 方法 | 用途 | 需要认证 |
|---|---|---|---|
| `/api/auth/status` | GET | 现有，新增返回 `hasRecovery` 字段 | 否 |
| `/api/auth/setup` | POST | **变更**——首次设置密码同时生成 DEK + 恢复码。返回恢复码列表 | 否 |
| `/api/auth/login` | POST | 现有，不变 | 否 |
| `/api/auth/change-password` | POST | **新增**——用旧密码 + 新密码，解包/重包 DEK | 是 |
| `/api/auth/forgot-password/verify` | POST | **新增**——输入恢复码，验证通过返回临时 reset_token | 否 |
| `/api/auth/forgot-password/reset` | POST | **新增**——用临时 reset_token + 新密码，重置密码哈希 + 重新包裹 DEK | 否 |
| `/api/auth/recovery-codes` | GET | **新增**——已登录状态下重新生成恢复码，旧码作废 | 是 |
| `/api/auth/recovery-status` | GET | **新增**——已登录状态下查看剩余恢复码数量 | 是 |

### 5.2 关键端点详细设计

#### POST /api/auth/setup

```json
// Request
{ "password": "user-password-min-6-chars" }

// Response
{
  "ok": true,
  "recovery_codes": [
    "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX1",
    "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX2",
    // ... 共 10 个
  ]
}
```

内部操作：
1. 生成 DEK（32 字节随机）
2. 密码 scrypt 派生密钥 → AES-GCM 包裹 DEK → 存 `wrapped_dek_by_password`
3. 生成 10 个恢复码
4. 每个恢复码 pbkdf2 派生密钥 → AES-GCM 包裹 DEK → 存 `wrapped_dek_by_recovery[i]`
5. 每个恢复码明文 scrypt 哈希 → 存 `recovery_code_hashes[i]`
6. `recovery_codes_used` 全部设为 `false`
7. 返回恢复码明文列表（**仅此次返回，之后不可查看**）

#### POST /api/auth/forgot-password/verify

```json
// Request
{ "recovery_code": "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX1" }

// Response (成功)
{ "ok": true, "reset_token": "eyJ...", "remaining_codes": 9 }

// Response (失败)
{ "error": "invalid_recovery_code", "remaining_attempts": 4 }
```

内部操作：
1. 去除输入中的分隔符 → scrypt 哈希 → timingSafeEqual 比对
2. 如果匹配且未被使用 → 生成 JWT reset_token（有效期 5 分钟，包含 `code_index` claim）
3. 如果匹配但已被使用 → 返回 `recovery_code_already_used`
4. 如果不匹配 → `recovery_attempts += 1`，5 次失败 → `recovery_locked_until = now + 15 min`

#### POST /api/auth/forgot-password/reset

```json
// Request
{ "reset_token": "eyJ...", "new_password": "new-password" }

// Response
{ "ok": true }
```

内部操作：
1. 验证 JWT 签名 + 未过期 + `code_index` claim
2. 新密码 scrypt 派生密钥 → AES-GCM 包裹 DEK → 更新 `wrapped_dek_by_password`
3. 更新 `password_hash`
4. 标记 `recovery_codes_used[code_index] = true`
5. 重置 `failed_attempts`、`locked_until`、`recovery_attempts`、`recovery_locked_until`

### 5.3 错误码

| 场景 | HTTP | error | 前端处理 |
|---|---|---|---|
| 恢复码格式错误 | 400 | `invalid_recovery_code_format` | 提示"格式不正确" |
| 恢复码不匹配 | 401 | `invalid_recovery_code (n/5)` | 显示剩余尝试次数 |
| 恢复码已被使用 | 401 | `recovery_code_already_used` | 提示"此恢复码已使用，请尝试其他恢复码" |
| 恢复码验证锁定 | 423 | `recovery_locked (N min)` | 显示"请 X 分钟后重试" |
| reset_token 过期 | 401 | `reset_token_expired` | 提示"已过期，请重新操作" |
| reset_token 无效 | 401 | `reset_token_invalid` | 提示"验证失败，请重新操作" |
| 旧密码错误（改密码时） | 401 | `current_password_wrong` | 提示"当前密码不正确" |
| DEK 解包失败 | 500 | `dek_unwrap_failed` | 记录日志，返回"系统错误" |

---

## 6. CLI 设计

### 6.1 命令列表

| 命令 | 用途 |
|---|---|
| `doc77 config set-password` | **变更**——首次设置密码，完成后输出恢复码 |
| `doc77 config change-password` | **新增**——交互式改密码（先验证旧密码） |
| `doc77 config reset-password` | **新增**——输入恢复码重置密码（交互式） |
| `doc77 config reset-password --force` | **新增**——强制作废：清空加密配置，重置密码。需输入确认文字 |
| `doc77 config recovery-codes` | **新增**——重新生成恢复码（旧码全部作废） |

### 6.2 交互示例

```
$ doc77 config set-password
请输入新密码（至少6位）: ******
请再次输入密码: ******
✅ 密码已设置

📋 以下是您的恢复码，请妥善保管：
   XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX1
   XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX2
   ...（共 10 个）
⚠️  这些恢复码仅在本次显示，关闭后将无法再次查看。

$ doc77 config reset-password
请输入恢复码: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX1
✅ 恢复码验证通过
请输入新密码（至少6位）: ******
请再次输入密码: ******
✅ 密码已重置，该恢复码已失效（剩余 9 个）

$ doc77 config reset-password --force
⚠️  此操作将清空所有加密配置（AI Token 等），且不可撤销。
⚠️  输入 "yes-i-know" 确认: yes-i-know
✅ 密码已重置，加密配置已清空
```

---

## 7. 前端交互设计

### 7.1 Web UI 变更点

**登录页面（现有登录门 overlay）**
- 密码输入框下方新增"忘记密码？"链接
- 点击 → 切换到恢复码输入界面
- 输入恢复码 → 验证 → 设置新密码

**首次设置密码页面**
- 密码设置成功后，弹窗展示 10 个恢复码
- 底部提示"请妥善保管，此页面关闭后无法再次查看"
- 用户可复制或手动记录，点击"我知道了"关闭

**账户设置页面（已登录状态）**
- 显示"剩余恢复码：X / 10"
- "重新生成恢复码"按钮（旧码作废）
- "修改密码"功能（输入旧密码 + 新密码）

### 7.2 移动端兼容

移动端 Web UI 同样支持：
- 登录页面的"忘记密码？"链接
- 恢复码输入与验证

---

## 8. 审计日志

所有安全敏感操作写入现有 `audit_log` 表：

| 事件 | 记录内容 |
|---|---|
| `password_changed` | 操作来源（web / cli）、时间戳 |
| `recovery_code_used` | 使用了第几个恢复码、时间戳 |
| `recovery_codes_regenerated` | 操作来源、时间戳 |
| `password_force_reset` | 操作来源、时间戳 |

---

## 9. 安全设计要点

### 9.1 防暴力破解

| 防护层 | 机制 |
|---|---|
| 登录尝试 | 现有机制：5 次失败 → 15 分钟锁定 |
| 恢复码验证 | 独立计数器：5 次失败 → 15 分钟锁定 |
| 时序攻击 | 所有码/哈希比较使用 `timingSafeEqual` |
| 并发恢复 | 新恢复流程启动时，旧的 reset_token 不失效（JWT 自身 5 分钟过期控制） |

### 9.2 恢复码安全性

- 恢复码明文仅生成时展示一次，服务器不存储明文
- 存储的是 scrypt 哈希，即使数据库泄露也不会暴露恢复码
- 每个恢复码为一次性使用，使用后即标记失效
- DEK 被恢复码包裹后，恢复码泄露 + 数据库泄露 = DEK 可被解包，这是可接受的风险（需要同时获取两样东西）

### 9.3 最坏情况

当用户同时丢失密码和所有恢复码时，CLI `--force` 是唯一选项：
- 要求用户输入确认字符串 `"yes-i-know"`
- 清空所有加密配置（AI Token 等）
- 密码重置为空白状态
- 记录审计日志

### 9.4 reset_token 安全

- JWT 格式，使用 HMAC-SHA256 签名（密钥为 DEK 前 32 字节）
- 有效期 5 分钟
- 包含 `code_index` claim 用于标记哪个恢复码被使用
- 一次性使用（reset 成功后对应的恢复码即被标记已用）

---

## 10. 代码变更范围

| Package | 文件 | 变更类型 |
|---|---|---|
| `core` | `src/crypto.ts` | 新增 `generateDEK()`、`wrapDEK()`、`unwrapDEK()`、`generateRecoveryCodes()` 函数 |
| `core` | `src/db/migrations.ts` | 新增 user_auth 表字段的 ALTER TABLE 迁移 |
| `core` | `src/server/app.ts` | 新增忘记密码相关 API 端点、变更 `/api/auth/setup` 端点 |
| `core` | `src/web/js/common.js` | 新增忘记密码流程的 UI 交互逻辑 |
| `core` | `src/web/index.html` | 新增恢复码展示弹窗、忘记密码链接 |
| `cli` | `src/bin/doc77.ts` | 新增 `reset-password`、`change-password`、`recovery-codes` 子命令 |
| `core` | `src/server/auth.ts` | **新文件**——auth 相关逻辑从 app.ts 中提取，便于复用和测试 |

### 测试范围

| 文件 | 内容 |
|---|---|
| `core/src/__tests__/crypto.test.ts` | DEK 包裹/解包、恢复码生成/验证的单元测试 |
| `core/src/__tests__/auth.test.ts` | 忘记密码流程的集成测试（verify → reset） |
| `cli/src/__tests__/` | CLI 命令的端到端测试 |

---

## 11. 已知技术债（本设计不处理，独立改进项）

以下项目在本次设计中已标注但不纳入实施范围：

1. **认证中间件缺失**：当前 Express 服务器无 auth middleware，API 路由在密码设置后仍可被未认证请求访问。建议新增 JWT-based auth middleware 作为独立的认证强化任务。
2. **会话管理薄弱**：登录返回的 token 是 `session-${Date.now()}`，无服务端验证。建议后续引入真正的 session token（JWT 或服务端 session store）。
3. **多用户支持**：`user_auth` 表硬编码单用户（id=1），如需支持多用户，需要重新设计用户模型。

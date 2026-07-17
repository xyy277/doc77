# @doc77/core

Doc77 核心引擎 — 数据库、文件系统抽象层、预览引擎、Express Server。

## Installation

```bash
npm install @doc77/core
```

## Modules

| 模块 | 说明 |
|---|---|
| **DB** | SQLite 数据库，项目管理、配置、审计日志、会话管理 |
| **Crypto** | scrypt 密码哈希、HKDF-SHA256 密钥派生、AES-256-GCM 信封加密、恢复码生成 |
| **File System** | 路径验证、敏感文件检测、文件读写抽象层 |
| **Scanner** | 目录扫描、文件树缓存、项目自动发现 |
| **Renderers** | Markdown、Mermaid、代码高亮、PDF、图片、docx、xlsx 渲染 |
| **Server** | Express 5 服务器、API 路由、认证系统、密码恢复 |
| **Auth** | 信封加密（DEK）、一次性恢复码、暴力破解防护 |

## API

```typescript
// Crypto
import { hashPassword, verifyPassword, generateRecoveryCodes, wrapDEK, unwrapDEK } from '@doc77/core';

// Database
import { initDatabase, getConnection, runMigrations } from '@doc77/core';

// Server
import { createApp } from '@doc77/core';
const app = createApp();
app.listen(27777);

// Auth
import { setupPasswordWithDEK, verifyLogin, changePassword } from '@doc77/core';
```

## Security

- 密码：scrypt（N=131072）+ HKDF-SHA256 域分离
- 恢复码：Crockford Base32，120-bit 熵，scrypt 哈希存储
- AES-256-GCM 信封加密保护 AI Token
- 独立爆破防护：登录 5 次 / 恢复码 5 次锁定 15 分钟

---

Part of [Doc77](https://github.com/xyy277/doc77) — 本地文档预览与管理工具

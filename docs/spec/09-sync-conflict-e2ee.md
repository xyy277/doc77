# 同步冲突智能解决 + 端到端加密 — 设计文档

> 日期: 2026-07-27 | 优先级: Q1-2027-1 | 状态: 设计
> 前置依赖: Spec 4 + Spec 5（同步引擎 + 适配器）

## 一、背景与目标

Spec 4/5 实现了基础同步，冲突处理为"保留双版本 + 用户手动选择"。本 spec 增强：
1. **智能冲突解决**：自动合并无冲突行、AI 辅助合并建议
2. **端到端加密（E2EE）**：同步传输和远程存储全程加密，即使 S3/WebDAV 服务商也无法读取内容

## 二、智能冲突解决

### 2.1 三级冲突处理策略

| 级别 | 条件 | 处理 |
|------|------|------|
| **L1: 自动合并** | 双方修改不同区域（行级无交叉） | 三路合并（3-way merge），无需用户介入 |
| **L2: AI 辅助** | 双方修改相同区域但语义可合并 | AI 生成合并建议，用户一键确认 |
| **L3: 手动解决** | 语义冲突、无法自动判断 | 并排 diff UI，用户逐块选择 |

### 2.2 三路合并（3-Way Merge）

```
输入:
  - base: 上次同步时的文件内容（baseline）
  - local: 本地当前版本
  - remote: 远程当前版本

算法:
  1. diff(base, local) → localChanges (行级)
  2. diff(base, remote) → remoteChanges (行级)
  3. 对每个变更区域:
     - 仅 local 修改 → 取 local
     - 仅 remote 修改 → 取 remote
     - 双方修改相同行 → CONFLICT
     - 双方修改不同行 → 合并两者
  4. 无 CONFLICT → 自动合并成功
  5. 有 CONFLICT → 升级到 L2/L3
```

实现：使用 `diff3` 算法（`node-diff3` 或自实现 Myers diff + 三路合并）。

### 2.3 AI 辅助合并（L2）

```
冲突文件 → 提取冲突块
  → 构建 prompt:
    "以下是同一文件两个版本的冲突区域，请生成合并结果：
     版本 A (本地): ...
     版本 B (远程): ...
     原始版本: ...
     请输出合并后的内容，保留双方有意义的修改。"
  → AI 返回合并建议
  → 显示给用户:
    ┌─────────────────────────────────────┐
    │ AI 合并建议:                         │
    │ ┌─────────────────────────────────┐ │
    │ │ (合并后的内容预览)               │ │
    │ └─────────────────────────────────┘ │
    │ [接受] [修改后接受] [拒绝,手动处理] │
    └─────────────────────────────────────┘
```

### 2.4 冲突解决 UI（L3 增强）

```
┌─ 冲突解决: docs/guide.md ──────────────────────────────┐
│                                                         │
│  [并排视图] [统一视图] [AI 建议]                        │
│                                                         │
│  ┌─ 本地版本 ──────┐  ┌─ 远程版本 ──────┐             │
│  │ # Guide          │  │ # Guide          │             │
│  │                  │  │                  │             │
│  │ ## 安装          │  │ ## 快速开始      │  ← 冲突块1  │
│  │ npm install doc77│  │ npx doc77        │             │
│  │                  │  │                  │             │
│  │ ## 使用          │  │ ## 使用          │  ← 相同     │
│  │ ...              │  │ ...              │             │
│  └──────────────────┘  └──────────────────┘             │
│                                                         │
│  冲突块 1/3:                                            │
│  [← 取本地] [取远程 →] [取两者] [AI 合并] [手动编辑]   │
│                                                         │
│  ─── 合并结果预览 ───                                   │
│  ┌──────────────────────────────────────┐              │
│  │ # Guide                               │              │
│  │ ## 安装                               │              │
│  │ npm install doc77                     │              │
│  │ ...                                   │              │
│  └──────────────────────────────────────┘              │
│                                                         │
│  [确认解决] [跳过此文件]                                │
└─────────────────────────────────────────────────────────┘
```

### 2.5 冲突预防

| 策略 | 说明 |
|------|------|
| 文件锁提示 | 编辑时检测该文件是否有未同步变更 |
| 同步前检查 | 编辑前自动 pull 最新 |
| 频繁同步 | 缩短同步间隔减少冲突概率 |
| 分区编辑 | 多人场景下按文件分工（提示"此文件其他设备正在编辑"） |

## 三、端到端加密（E2EE）

### 3.1 威胁模型

| 威胁 | 防护 |
|------|------|
| S3/WebDAV 服务商读取内容 | 客户端加密后再上传 |
| 传输中间人 | TLS + 加密内容（双重保护） |
| Git 仓库泄露 | 文件内容加密后 commit |
| 同步密钥丢失 | 恢复码机制 |

### 3.2 加密方案

```
加密算法: AES-256-GCM (对称)
密钥派生: PBKDF2 / Argon2id (从用户密码派生)
密钥交换: 设备间通过恢复码 / QR 码共享主密钥

文件加密流程:
  1. 主密钥 (Master Key) = Argon2id(用户密码, salt)
  2. 每个文件: fileKey = random(32 bytes)
  3. 加密: ciphertext = AES-256-GCM(fileKey, plaintext)
  4. 封装: encryptedFileKey = AES-256-GCM(masterKey, fileKey)
  5. 上传: { ciphertext, encryptedFileKey, iv, tag, salt }
```

### 3.3 加密元数据格式

```typescript
interface EncryptedFile {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;              // Base64, 12 bytes
  tag: string;             // Base64, 16 bytes (GCM auth tag)
  encryptedKey: string;    // Base64, AES(masterKey, fileKey)
  ciphertext: string;      // Base64, 加密后的文件内容
  originalName: string;    // 加密文件名（可选）
  originalSize: number;
  mimeType: string;
}
```

### 3.4 远程存储结构（加密模式）

```
S3 Bucket / WebDAV 目录:
├── .doc77-vault/
│   ├── manifest.enc       # 加密的文件清单
│   ├── salt               # 密钥派生 salt（明文，不含密钥信息）
│   └── version            # 加密协议版本
├── files/
│   ├── a1b2c3d4.enc       # 加密文件（UUID 命名，隐藏原始路径）
│   ├── e5f6g7h8.enc
│   └── ...
└── .doc77sync             # 同步配置（不含敏感信息）
```

### 3.5 密钥管理

```
首次启用 E2EE:
  1. 用户设置加密密码（或自动生成强密码）
  2. 派生 Master Key
  3. 生成恢复码（24 个单词 / 128-bit hex）
  4. 提示用户安全保存恢复码
  5. Master Key 仅存于内存（不落盘）
  6. 每次启动需输入密码解锁（或 biometric via Electron）

新设备加入:
  1. 输入恢复码 / 扫描 QR
  2. 派生相同 Master Key
  3. 解密文件清单
  4. 开始同步
```

### 3.6 性能影响

| 操作 | 无加密 | 有加密 | 开销 |
|------|--------|--------|------|
| 同步 1MB 文件 | ~200ms | ~250ms | +25% |
| 同步 100MB 文件 | ~5s | ~7s | +40% |
| CPU 占用 | 低 | 中（AES-NI 加速） | 可接受 |
| 存储膨胀 | 1x | ~1.35x（Base64 + 元数据） | 可接受 |

### 3.7 配置

```typescript
interface EncryptionConfig {
  enabled: boolean;
  algorithm: 'aes-256-gcm';
  keyDerivation: 'argon2id' | 'pbkdf2';
  unlockMethod: 'password' | 'biometric' | 'auto';  // auto = 开机后首次输入
  autoLockTimeout: number;   // 分钟，0=不自动锁定
  encryptFileNames: boolean; // 是否加密文件名
}
```

## 四、API 扩展

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/sync/:projectId/merge` | AI 辅助合并 |
| GET | `/api/sync/:projectId/diff` | 获取三路 diff |
| POST | `/api/sync/:projectId/encryption/setup` | 初始化 E2EE |
| POST | `/api/sync/:projectId/encryption/unlock` | 解锁密钥 |
| POST | `/api/sync/:projectId/encryption/lock` | 锁定密钥 |
| GET | `/api/sync/:projectId/encryption/status` | 加密状态 |
| POST | `/api/sync/:projectId/encryption/recovery` | 验证恢复码 |

## 五、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/sync/src/merge/diff3.ts` | 新增 | 三路合并算法 |
| `packages/sync/src/merge/ai-assist.ts` | 新增 | AI 合并建议 |
| `packages/sync/src/crypto/encrypt.ts` | 新增 | AES-256-GCM 加密 |
| `packages/sync/src/crypto/keyring.ts` | 新增 | 密钥管理 |
| `packages/sync/src/crypto/recovery.ts` | 新增 | 恢复码生成/验证 |
| `packages/sync/src/adapters/git.ts` | 修改 | 加密层集成 |
| `packages/sync/src/adapters/webdav.ts` | 修改 | 加密层集成 |
| `packages/sync/src/adapters/s3.ts` | 修改 | 加密层集成 |
| `packages/sync/src/web/conflict-ui.js` | 新增 | 冲突解决增强 UI |
| `packages/sync/src/web/encryption-setup.js` | 新增 | E2EE 设置向导 |

## 六、验收标准

### 冲突解决
1. 双方修改不同行 → 自动合并成功，无用户介入
2. 双方修改相同行 → AI 生成合并建议 → 用户一键接受
3. AI 建议不满意 → 并排 diff 手动逐块选择
4. 合并结果正确（不丢失任何一方的有效修改）

### E2EE
5. 启用加密 → S3 上的文件为密文（无法直接读取）
6. 另一设备输入恢复码 → 成功解密并同步
7. 忘记密码 + 无恢复码 → 数据不可恢复（安全）
8. 加密同步性能：1MB 文件 < 300ms
9. 锁定后无法访问远程文件（需重新解锁）

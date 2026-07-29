# WebDAV + S3 同步适配器 — 设计文档

> 日期: 2026-07-27 | 优先级: Q4-1 | 状态: 设计
> 前置依赖: Spec 4（@doc77/sync 骨架 + SyncAdapter 接口）

## 一、背景与目标

Spec 4 建立了同步引擎骨架和 Git 适配器。本 spec 实现另外两个适配器：

| 适配器 | 目标用户 | 典型场景 |
|--------|---------|---------|
| **WebDAV** | NAS 用户（群晖/Nextcloud/ownCloud） | 家庭 NAS 文档同步 |
| **S3** | 云备份用户（AWS S3/MinIO/Cloudflare R2/Backblaze B2） | 异地备份 + 多设备同步 |

**设计原则**：
- 复用 Spec 4 的 `SyncAdapter` 接口，零引擎改动
- 每个适配器独立文件，按需加载
- 配置凭据加密存储

## 二、WebDAV 适配器

### 2.1 配置

```typescript
interface WebDAVAdapterConfig extends AdapterConfig {
  type: 'webdav';
  endpoint: string;          // https://nas.local:5005/webdav/docs
  username: string;
  password: string;          // 加密存储
  remotePath: string;        // 远程根目录（相对于 endpoint），默认 '/'
  ignorePatterns: string[];
  chunkSize: number;         // 大文件分块上传大小，默认 10MB
}
```

### 2.2 依赖

```
webdav (^5.x)  — 纯 JS WebDAV 客户端，支持：
  - 基本认证 / Digest 认证
  - PROPFIND（目录列表 + 属性）
  - GET / PUT / DELETE / MKCOL
  - 流式传输
```

### 2.3 同步实现

**listRemote()**：
```
1. PROPFIND endpoint/remotePath (Depth: infinity)
2. 解析 multistatus XML → 文件列表 [{path, size, lastModified, etag}]
3. 过滤 ignorePatterns
4. 返回 RemoteFileEntry[]
```

**pull(remoteChanges)**：
```
for each file in remoteChanges:
  if file.type === 'deleted':
    fs.unlink(localPath)
  else:
    stream = client.createReadStream(remotePath)
    stream.pipe(fs.createWriteStream(localPath))
    // 保留 mtime: utimes(localPath, file.lastModified)
```

**push(localChanges)**：
```
for each file in localChanges:
  if file.type === 'deleted':
    client.deleteFile(remotePath)
  else if file.type === 'added':
    // 确保父目录存在
    await ensureRemoteDir(dirname(remotePath))
    client.putFileContents(remotePath, content)
  else: // modified
    client.putFileContents(remotePath, content, { overwrite: true })
```

### 2.4 冲突检测

WebDAV 无版本概念，冲突检测依赖 **mtime + etag**：

```
本地文件 mtime > 上次同步时间 AND 远程 lastModified > 上次同步时间
  → 同一文件双方都修改 → conflict
```

### 2.5 兼容设备

| 设备/服务 | 端点格式 | 认证 |
|-----------|---------|------|
| 群晖 DSM | `https://nas:5006/webdav/共享文件夹` | Basic |
| Nextcloud | `https://cloud.example.com/remote.php/dav/files/user/` | Basic / App Password |
| ownCloud | 同 Nextcloud | Basic |
| Windows IIS | `http://server/webdav/` | NTLM / Basic |
| nginx-dav | `https://dav.example.com/` | Basic |

### 2.6 测试连接

```
testConnection(config):
  1. PROPFIND endpoint (Depth: 0) — 仅获取根属性
  2. 成功 → { ok: true, server: 'Apache/2.4', quota: '...' }
  3. 401 → { ok: false, error: '认证失败' }
  4. 超时 → { ok: false, error: '无法连接' }
```

## 三、S3 适配器

### 3.1 配置

```typescript
interface S3AdapterConfig extends AdapterConfig {
  type: 's3';
  endpoint?: string;         // 自定义端点（MinIO/R2/B2），AWS 可留空
  region: string;            // 'us-east-1', 'auto' (R2)
  bucket: string;
  prefix: string;            // 对象前缀（虚拟目录），默认 'doc77/'
  accessKeyId: string;       // 加密存储
  secretAccessKey: string;   // 加密存储
  ignorePatterns: string[];
  storageClass: string;      // 'STANDARD' | 'INTELLIGENT_TIERING'
}
```

### 3.2 依赖

```
@aws-sdk/client-s3 (^3.x)  — AWS 官方 SDK v3，支持：
  - ListObjectsV2（目录列表）
  - GetObject / PutObject / DeleteObject
  - 兼容 MinIO / Cloudflare R2 / Backblaze B2（通过自定义 endpoint）
```

### 3.3 同步实现

**listRemote()**：
```
1. ListObjectsV2({ Bucket, Prefix: config.prefix })
2. 分页获取所有对象（ContinuationToken）
3. 映射 → [{path: key.slice(prefix.length), size, lastModified, etag}]
4. 过滤 ignorePatterns
```

**pull(remoteChanges)**：
```
for each file in remoteChanges:
  if file.type === 'deleted':
    fs.unlink(localPath)
  else:
    response = await s3.getObject({ Bucket, Key: prefix + file.path })
    response.Body.pipe(fs.createWriteStream(localPath))
```

**push(localChanges)**：
```
for each file in localChanges:
  if file.type === 'deleted':
    await s3.deleteObject({ Bucket, Key: prefix + file.path })
  else:
    await s3.putObject({
      Bucket, Key: prefix + file.path,
      Body: fs.createReadStream(localPath),
      ContentType: mime.lookup(file.path),
      Metadata: { 'doc77-mtime': stat.mtime.toISOString() }
    })
```

### 3.4 冲突检测

S3 使用 **ETag + 本地 baseline** 检测：

```
sync_state.last_baseline 存储: { [path]: etag } 的 JSON

pull 前:
  remoteFiles = listRemote()
  for each remoteFile:
    if remoteFile.etag !== baseline[file.path]:
      → 远程有变更
    if localFile.mtime > lastSyncAt AND remoteFile.etag !== baseline[file.path]:
      → 双方都修改 → conflict
```

### 3.5 兼容服务

| 服务 | endpoint | region | 说明 |
|------|----------|--------|------|
| AWS S3 | 留空（自动） | 实际 region | 标准 |
| MinIO | `http://localhost:9000` | `us-east-1` | 自建 |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `auto` | 免出口费 |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | 实际 region | 低价 |
| 阿里云 OSS | `https://oss-<region>.aliyuncs.com` | 实际 region | 国内 |
| 腾讯 COS | `https://cos.<region>.myqcloud.com` | 实际 region | 国内 |

### 3.6 大文件处理

- 文件 > 100MB：使用 S3 Multipart Upload（分片 10MB）
- 文件 > 5GB：拒绝同步（S3 单对象上限）
- 进度回调：每片完成 → emit progress event

## 四、本地目录镜像适配器（附加）

简单但实用：将项目同步到另一个本地目录（如外接硬盘、网络挂载）。

```typescript
interface LocalAdapterConfig extends AdapterConfig {
  type: 'local';
  targetPath: string;        // 目标目录绝对路径
  mirror: boolean;           // true=镜像（删除同步），false=仅增量
}
```

实现：`fs.cp` / `fs.rm` + mtime 对比，无需网络。

## 五、适配器注册与发现

```typescript
// adapters/index.ts
const ADAPTER_REGISTRY: Record<string, () => Promise<SyncAdapter>> = {
  git: () => import('./git').then(m => new m.GitAdapter()),
  webdav: () => import('./webdav').then(m => new m.WebDAVAdapter()),
  s3: () => import('./s3').then(m => new m.S3Adapter()),
  local: () => import('./local').then(m => new m.LocalAdapter()),
};

async function getAdapter(type: string): Promise<SyncAdapter> {
  const factory = ADAPTER_REGISTRY[type];
  if (!factory) throw new Error(`Unknown adapter: ${type}`);
  return factory();
}
```

## 六、前端 UI 增强

### 6.1 适配器选择向导

```
┌─ 新建同步 ─────────────────────────────────────────────┐
│                                                         │
│  选择同步方式:                                          │
│                                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │  🔀     │  │  🌐     │  │  ☁️     │  │  📁     │  │
│  │  Git    │  │ WebDAV  │  │   S3    │  │  本地   │  │
│  │         │  │         │  │         │  │  目录   │  │
│  │ 版本历史 │  │ NAS 同步 │  │ 云备份  │  │ 镜像   │  │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘  │
│                                                         │
│  ─── WebDAV 配置 ───                                    │
│  服务器:  [https://nas.local:5006/webdav/docs    ]      │
│  用户名:  [admin                              ]         │
│  密码:    [••••••••                          ]         │
│  远程路径: [/Documents                         ]        │
│                                                         │
│  [测试连接]  [下一步: 同步选项]                         │
└─────────────────────────────────────────────────────────┘
```

### 6.2 同步进度实时显示

```
┌─ 正在同步... ──────────────────────────────────────────┐
│                                                         │
│  ⬆ 推送: docs/guide.md (2.1 KB)                        │
│  ⬆ 推送: docs/api.md (5.3 KB)                          │
│  ⬇ 拉取: images/arch.png (120 KB) ████████░░ 80%      │
│                                                         │
│  进度: 3/5 文件  │  已用: 2.3s                          │
│  [取消]                                                 │
└─────────────────────────────────────────────────────────┘
```

## 七、CLI 扩展

```bash
doc77 sync config --adapter webdav    # WebDAV 交互式配置
doc77 sync config --adapter s3        # S3 交互式配置
doc77 sync test                       # 测试当前配置连接
```

## 八、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/sync/src/adapters/webdav.ts` | 新增 | WebDAV 适配器 |
| `packages/sync/src/adapters/s3.ts` | 新增 | S3 适配器 |
| `packages/sync/src/adapters/local.ts` | 新增 | 本地目录适配器 |
| `packages/sync/src/adapters/index.ts` | 修改 | 注册新适配器 |
| `packages/sync/src/web/sync-panel.js` | 修改 | 适配器选择向导 UI |
| `packages/sync/package.json` | 修改 | 添加 webdav + @aws-sdk/client-s3 依赖 |
| `packages/sync/__tests__/webdav.test.ts` | 新增 | WebDAV 适配器测试 |
| `packages/sync/__tests__/s3.test.ts` | 新增 | S3 适配器测试 |

## 九、验收标准

### WebDAV
1. 配置群晖/Nextcloud WebDAV → 测试连接成功
2. 本地新增文件 → 同步 → WebDAV 服务器出现该文件
3. WebDAV 服务器修改文件 → 同步 → 本地更新
4. 双方修改同文件 → 冲突检测 → 解决
5. 大文件（> 100MB）分块上传成功

### S3
1. 配置 AWS/MinIO/R2 → 测试连接成功
2. 同步 → S3 bucket 中出现对应对象
3. 删除本地文件 → 同步 → S3 对象被删除（mirror 模式）
4. 多设备：设备 A 同步 → 设备 B 拉取 → 内容一致
5. 大文件 Multipart Upload 进度可见

### 通用
6. 适配器切换：从 Git 换到 WebDAV → 重新配置 → 正常工作
7. 凭据加密存储，配置文件不含明文密码

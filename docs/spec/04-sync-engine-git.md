# @doc77/sync 同步引擎骨架 + Git 适配器 — 设计文档

> 日期: 2026-07-27 | 优先级: Q3-4 | 状态: 设计

## 一、背景与目标

用户反馈最强烈的需求之一：**多设备间文档同步**。Doc77 定位为"本地优先"，因此同步必须基于**用户自己的基础设施**（Git 仓库、NAS、S3 桶），Doc77 不运营任何云服务。

**本 spec 目标**：
- 设计 `@doc77/sync` package 核心架构（适配器模式）
- 实现第一个适配器：Git（覆盖技术用户 + 版本历史需求）
- 同步状态面板 UI
- 为后续 WebDAV / S3 适配器（Spec 5）打好地基

**核心原则**：
- 用户自托管，内容不经过 Doc77 服务器
- 懒加载，不用同步时零开销
- 可选端到端加密（Spec 9 实现）
- 文件级同步（非块级），简单可靠

## 二、Package 架构

### 2.1 依赖关系

```
@doc77/sync (新增)
├── dependencies: @doc77/core (workspace:^)
├── dependencies: simple-git (^3.x)     — Git 适配器
├── dependencies: chokidar (^4.x)       — 文件 watch（可选）
└── 不依赖: @doc77/mcp, @doc77/ai, @doc77/gallery

@doc77/cli
└── peerDependencies: @doc77/sync (optional)
```

### 2.2 目录结构

```
packages/sync/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                  # 公共入口：createSyncEngine()
    ├── types.ts                  # 核心类型定义
    ├── engine.ts                 # SyncEngine 主类（调度、状态机）
    ├── diff.ts                   # 文件差异检测（mtime + hash）
    ├── conflict.ts               # 冲突检测与解决策略
    ├── scheduler.ts              # 定时/手动/watch 触发器
    ├── state.ts                  # 同步状态持久化（SQLite）
    ├── adapters/
    │   ├── adapter.ts            # SyncAdapter 抽象接口
    │   ├── git.ts                # Git 适配器
    │   ├── webdav.ts             # WebDAV 适配器（Spec 5）
    │   ├── s3.ts                 # S3 适配器（Spec 5）
    │   └── local.ts              # 本地目录镜像适配器
    ├── routes.ts                 # REST API 路由工厂
    └── web/
        └── sync-panel.js         # 同步状态面板 UI 组件
```

## 三、核心类型定义

```typescript
// types.ts

/** 同步方向 */
type SyncDirection = 'bidirectional' | 'push' | 'pull';

/** 同步状态 */
type SyncStatus = 'idle' | 'syncing' | 'conflict' | 'error' | 'disabled';

/** 适配器抽象接口 */
interface SyncAdapter {
  readonly name: string;           // 'git' | 'webdav' | 's3' | 'local'
  readonly displayName: string;    // 'Git Repository'

  /** 测试连接是否可用 */
  testConnection(config: AdapterConfig): Promise<ConnectionResult>;

  /** 拉取远程变更到本地 */
  pull(ctx: SyncContext): Promise<PullResult>;

  /** 推送本地变更到远程 */
  push(ctx: SyncContext): Promise<PushResult>;

  /** 获取远程文件列表（用于 diff） */
  listRemote(config: AdapterConfig): Promise<RemoteFileEntry[]>;
}

/** 同步上下文 */
interface SyncContext {
  projectId: number;
  projectPath: string;
  direction: SyncDirection;
  changedFiles: FileChange[];      // 本地变更列表
  remoteFiles: RemoteFileEntry[];  // 远程文件列表
  options: SyncOptions;
}

/** 文件变更 */
interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  mtime: string;
  hash: string;
  size: number;
}

/** 同步结果 */
interface SyncResult {
  status: 'success' | 'conflict' | 'error';
  pushed: number;
  pulled: number;
  conflicts: ConflictEntry[];
  errors: string[];
  duration: number;  // ms
}

/** 冲突条目 */
interface ConflictEntry {
  path: string;
  localHash: string;
  remoteHash: string;
  resolution?: 'local' | 'remote' | 'merged';
}
```

## 四、同步引擎（SyncEngine）

### 4.1 状态机

```
idle → syncing → idle (success)
              → conflict (需用户处理)
              → error (可重试)
disabled → idle (用户启用)
```

### 4.2 同步流程（双向）

```
sync(projectId):
  1. status = 'syncing'
  2. localChanges = diff.scanLocal(projectPath, lastSyncState)
  3. remoteFiles = adapter.listRemote(config)
  4. remoteChanges = diff.compareRemote(remoteFiles, lastSyncState)
  5. conflicts = detectConflicts(localChanges, remoteChanges)
     // 同一文件双方都修改 → conflict
  6. if conflicts.length > 0:
       status = 'conflict'
       → 等待用户解决（或自动策略）
  7. // 无冲突部分正常同步
     pullResult = adapter.pull(nonConflictRemoteChanges)
     pushResult = adapter.push(nonConflictLocalChanges)
  8. updateSyncState(projectId, newBaseline)
  9. status = 'idle'
  10. emit SSE: { type: 'sync-complete', result }
```

### 4.3 触发方式

| 触发 | 实现 | 默认 |
|------|------|------|
| 手动 | UI 按钮 / CLI `doc77 sync` / API | ✅ |
| 定时 | `setInterval`（可配间隔） | 每 30min |
| 文件 watch | chokidar 监听项目目录 | 关闭（可选开启） |
| 启动时 | 服务启动后自动检查 | ✅ |

## 五、Git 适配器详细设计

### 5.1 配置

```typescript
interface GitAdapterConfig extends AdapterConfig {
  type: 'git';
  remoteUrl: string;         // git@github.com:user/repo.git 或 https://...
  branch: string;            // 默认 'main'
  remoteName: string;        // 默认 'origin'
  authMethod: 'ssh' | 'https' | 'token';
  token?: string;            // HTTPS token（加密存储）
  commitPrefix: string;      // 默认 '[doc77-sync]'
  autoCommit: boolean;       // 自动 commit 本地变更
  pullStrategy: 'merge' | 'rebase';  // 默认 'merge'
  ignorePatterns: string[];  // 额外忽略规则
}
```

### 5.2 Git 同步流程

**Pull（远程 → 本地）**：
```
1. git fetch origin
2. git diff --name-status HEAD..origin/branch → 远程变更列表
3. 对每个变更文件：
   - added/modified → git checkout origin/branch -- <file>
   - deleted → fs.unlink(localPath)
4. 记录 commit hash 作为新 baseline
```

**Push（本地 → 远程）**：
```
1. git add <changedFiles>
2. git commit -m "[doc77-sync] Update N files (2026-07-27 10:30)"
3. git push origin branch
4. 若 push 失败（non-fast-forward）→ 先 pull --rebase → 再 push
```

### 5.3 冲突处理（Git 特有）

```
git pull 产生 merge conflict:
  1. 检测 conflict markers (<<<<<<)
  2. 对每个冲突文件：
     - 保存 .local 版本（当前工作区）
     - 保存 .remote 版本（origin/branch）
     - 生成 .conflict 文件（含 markers）
  3. 通知用户解决
  4. 用户选择后：
     - 选 local → git checkout --ours <file>
     - 选 remote → git checkout --theirs <file>
     - 手动编辑 → 用户自行处理 markers
  5. git add <resolved> && git commit
```

### 5.4 .doc77sync 配置文件

项目根目录可选放置 `.doc77sync`（JSON）：

```json
{
  "adapter": "git",
  "direction": "bidirectional",
  "interval": 1800,
  "ignore": ["node_modules/", ".git/", "*.tmp", "~$*"],
  "conflictStrategy": "ask",
  "git": {
    "branch": "main",
    "autoCommit": true,
    "commitPrefix": "[doc77-sync]",
    "pullStrategy": "rebase"
  }
}
```

## 六、数据模型（SQLite）

```sql
-- 同步配置
CREATE TABLE IF NOT EXISTS sync_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  adapter_type TEXT NOT NULL,           -- 'git' | 'webdav' | 's3' | 'local'
  config_json TEXT NOT NULL,            -- 加密存储的适配器配置
  direction TEXT DEFAULT 'bidirectional',
  interval_seconds INTEGER DEFAULT 1800,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id)
);

-- 同步状态记录
CREATE TABLE IF NOT EXISTS sync_state (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'idle',           -- idle/syncing/conflict/error
  last_sync_at TEXT,
  last_baseline TEXT,                   -- Git: commit hash; S3: etag 集合
  last_error TEXT,
  total_pushed INTEGER DEFAULT 0,
  total_pulled INTEGER DEFAULT 0,
  total_conflicts INTEGER DEFAULT 0
);

-- 同步日志
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  direction TEXT,                       -- 'push' | 'pull' | 'bidirectional'
  status TEXT,                          -- 'success' | 'conflict' | 'error'
  files_pushed INTEGER DEFAULT 0,
  files_pulled INTEGER DEFAULT 0,
  conflicts INTEGER DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_log_project ON sync_log(project_id, created_at);
```

## 七、REST API

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/sync/status` | 所有项目同步状态概览 |
| GET | `/api/sync/:projectId/status` | 单项目同步详情 |
| POST | `/api/sync/:projectId/run` | 手动触发同步 |
| POST | `/api/sync/:projectId/config` | 创建/更新同步配置 |
| DELETE | `/api/sync/:projectId/config` | 删除同步配置 |
| POST | `/api/sync/:projectId/test` | 测试连接 |
| GET | `/api/sync/:projectId/log` | 同步历史日志 |
| POST | `/api/sync/:projectId/resolve` | 解决冲突 |
| GET | `/api/sync/:projectId/conflicts` | 获取冲突列表 |

### 7.1 关键端点

**`POST /api/sync/:projectId/config`**
```json
{
  "adapter": "git",
  "direction": "bidirectional",
  "interval": 1800,
  "config": {
    "remoteUrl": "git@github.com:user/my-docs.git",
    "branch": "main",
    "authMethod": "ssh",
    "autoCommit": true
  }
}
```

**`POST /api/sync/:projectId/resolve`**
```json
{
  "resolutions": [
    { "path": "docs/guide.md", "choice": "local" },
    { "path": "docs/api.md", "choice": "remote" }
  ]
}
```

## 八、前端 UI — 同步面板

### 8.1 Dashboard 集成

项目卡片新增同步状态指示：
```
┌──────────────────────────────┐
│ 📂 My Docs          🔄 ✓    │  ← 同步图标（绿=同步/黄=冲突/灰=未配置）
│ /home/docs                    │
│ 120 files · 45MB             │
│ Last sync: 5min ago          │
│ [📷 Gallery] [🔄 Sync] [📂] │
└──────────────────────────────┘
```

### 8.2 同步设置页

```
┌─ 同步设置 ─────────────────────────────────────────────┐
│                                                         │
│  适配器: [Git ▾]  (Git / WebDAV / S3 / 本地目录)       │
│                                                         │
│  远程地址: [git@github.com:user/repo.git        ]       │
│  分支:     [main                                ]       │
│  认证:     (●) SSH  ( ) HTTPS Token                     │
│                                                         │
│  方向:     (●) 双向  ( ) 仅推送  ( ) 仅拉取            │
│  间隔:     [30] 分钟                                    │
│  自动提交: [✓]                                          │
│                                                         │
│  [测试连接]  [保存并启用]                               │
│                                                         │
│  ─── 同步日志 ───                                       │
│  ✓ 2026-07-27 10:30 — 推送 3 文件，拉取 1 文件 (2.1s) │
│  ✓ 2026-07-27 10:00 — 无变更 (0.3s)                    │
│  ⚠ 2026-07-27 09:30 — 冲突 1 文件 [解决]               │
└─────────────────────────────────────────────────────────┘
```

### 8.3 冲突解决 UI

```
┌─ 同步冲突 (2 个文件) ──────────────────────────────────┐
│                                                         │
│  📄 docs/guide.md                                       │
│  ┌─────────────────┬─────────────────┐                 │
│  │ 本地版本         │ 远程版本         │                 │
│  │ (你的修改)       │ (其他设备)       │                 │
│  │                  │                  │                 │
│  │ # Guide          │ # Guide          │                 │
│  │ Updated line     │ Different line   │                 │
│  └─────────────────┴─────────────────┘                 │
│  [保留本地] [保留远程] [手动合并]                       │
│                                                         │
│  📄 docs/api.md                                         │
│  ...                                                    │
│                                                         │
│  [全部保留本地] [全部保留远程] [确认解决]               │
└─────────────────────────────────────────────────────────┘
```

## 九、CLI 命令

```bash
doc77 sync status              # 所有项目同步状态
doc77 sync run [project]       # 手动触发同步
doc77 sync config [project]    # 交互式配置向导
doc77 sync log [project]       # 查看同步日志
doc77 sync resolve [project]   # 交互式解决冲突
```

## 十、安全考虑

- Git token / WebDAV 密码使用现有信封加密存储（`security.encrypt()`）
- SSH key 不经过 Doc77，直接使用系统 `~/.ssh/`
- 同步日志不记录文件内容，仅记录路径和操作类型
- `.doc77sync` 中不存储任何凭据

## 十一、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/sync/` | 新增 | 整个 package |
| `packages/sync/src/engine.ts` | 新增 | 同步引擎核心 |
| `packages/sync/src/adapters/git.ts` | 新增 | Git 适配器 |
| `packages/sync/src/adapters/adapter.ts` | 新增 | 适配器接口 |
| `packages/sync/src/diff.ts` | 新增 | 差异检测 |
| `packages/sync/src/conflict.ts` | 新增 | 冲突处理 |
| `packages/sync/src/routes.ts` | 新增 | API 路由 |
| `packages/sync/src/web/sync-panel.js` | 新增 | 前端面板 |
| `packages/core/src/db/migrations.ts` | 修改 | 新增 sync 表 |
| `packages/cli/src/bin/doc77.ts` | 修改 | 新增 sync 命令 |
| `pnpm-workspace.yaml` | 修改 | 添加 packages/sync |

## 十二、验收标准

1. 配置 Git 远程 → 测试连接成功
2. 本地修改文件 → 手动同步 → 远程仓库收到 commit
3. 远程修改文件 → 同步 → 本地文件更新
4. 双方修改同一文件 → 冲突检测 → UI 解决
5. 定时同步：配置 30min → 到期自动执行
6. 同步日志可查看历史
7. 未配置同步的项目 → 零开销（模块不加载）
8. CLI `doc77 sync status` 正常输出

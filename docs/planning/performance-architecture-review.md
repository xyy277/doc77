# 性能架构评审与修复记录（2026-08-15）

> 本文档是性能问题的**事实档案与后续工作交接**：根因证据链、已实施的修复（1.1.4）、以及待执行的架构专项路线图。后续任何涉及性能、DB 层、搜索、启动链路的改动，**先读本文档**，避免重复调查或误将临时方案当作永久方案。
>
> 状态：1.1.4 热修复（Part 1 A-D）与高性价比架构项（Part 2 F1-F4）已实施完毕并全部通过验证（745 测试全绿），等待发布。
>
> 语言规范：专业术语英文，其余中文（见根 CLAUDE.md）。

## 1. 背景与定位

- **系统定位**：轻量 —— 性能必须好、响应快、开销小（用户明确要求）。
- **事故**：v1.1.3 Electron 版打开后系统卡死，内存暴涨至 1500MB，CPU 持续 ~10% 不降；dev 模式（CLI server）同样复现；打开即发生；此前版本有轻微卡顿，用户长期反馈"越来越卡、打开慢、进入项目也慢"。Windows 平台。

## 2. 根因证据链（全部经代码验证，含行号）

### 2.1 放大器：sql.js 全内存 DB + 每次写入全库序列化

- `packages/core/src/db/connection.ts:82-84`：每条 `INSERT/UPDATE/DELETE` 的 `.run()` 都调 `_scheduleSave()`；`:23-40` 500ms 去抖后 `rawDb.export()` **全量序列化整个 DB** + `Buffer.from` 复制 + 同步 `writeFileSync` + `renameSync`。
- DB 常驻 WASM 堆（`:204`），export 每次再复制一份等大 Buffer。DB ≈ 500MB 量级时，每次写入 = 同步序列化+写盘 ~500MB×2 → 事件循环阻塞、系统卡死、内存翻倍。
- **历史**：better-sqlite3 只存活一天（2026-07-07 提交 `6f1cacf`，WAL 模式），2026-07-08 提交 `ff0f238` 因 Windows 原生模块安装问题（"Cannot GET /"）换 sql.js。本机 `~/.doc77/data.db-wal`/`data.db-shm` 即迁移当天化石（sql.js 从不产生 WAL）。
- **FTS5 实测不可用**：sql.js 官方 dist（1.14.1，SQLite 3.49.1）无 FTS5 符号（strings 扫描为 0，只有 FTS3）。`migrations.ts:35-46` 的 `detectFts5` 恒定失败 → `search/query.ts:218-260` 的 `searchWithLike`（`LIKE '%term%'` 前导通配，索引失效，全表扫）是唯一生效路径；`searchWithFts5`（`:153-213`）是死代码。**自 7/8 迁移日起全库搜索一直是 LIKE 线性扫描。**

### 2.2 引爆器：1.1.3 新增 watcher → SSE → 刷新 → 重扫 级联

- 1.1.3 核心改动 = commit `f7ed21d`（fs watcher + 无条件 SSE 事件，事件总线移入 core）。
- `packages/core/src/server/watcher.ts`：启动对全部项目根 `_watcher.add(absRoot)` 递归监听；`awaitWriteFinish {stabilityThreshold:150, pollInterval:50}`（:138）对每个被写文件 50ms stat 轮询；每个 fs 事件 → flush（:62-87）→ `clearCache()`（DB DELETE → 触发一次全库 export）→ SSE `file-tree:changed`。
- `packages/core/src/scanner/index.ts:22-77`：前端收到事件 → `refreshSubtree` → GET /api/tree → `scanDirectory`：`isCacheValid`（:100-126，对目录内**每个条目** statSync + readdirSync）→ 失效则 DELETE（写 #1）→ `listDir` 重扫 → INSERT（写 #2）→ 又触发全库 export。
- `packages/core/src/web/js/preview.js:83-118`：渲染端无条件 EventSource('/api/events')，每次 file-tree:changed 都 freshFetch 刷新子树。
- 启动点：`packages/electron/src/server.ts:390-396` 与 `packages/cli/src/bin/doc77.ts:414-421` 无条件 `startFileWatcher({debounceMs:300})`。
- **结果**：单次文件变更 = 2-3 次 DB 写 + 1 次全库序列化 + 全目录 stat；任何周期性写文件者（编辑器 autosave、git、同步引擎、agent 写入、Windows 事件抖动）让此链无限运转 → 空闲 CPU 10% 不降、内存只涨不跌。

### 2.3 启动慢 / 进入项目慢 / 越来越卡

| 症状 | 根因 | 位置 |
|---|---|---|
| 打开慢 | 无条件加载 4.5MB AWS SDK（`@aws-sdk/client-s3`）+ sharp 原生模块（从未配 S3 也加载） | `packages/sync/src/adapters/s3.ts:5`、`packages/gallery` 入口、`packages/electron/src/server.ts:277,283` |
| 打开慢 | `startServer` 串行 await 链，窗口等全部就绪才出现；`migrateOldAiChatSessions` 每次启动全量读旧表；`cleanupTrash` 同步 IIFE | `packages/electron/src/server.ts:342-413`、`migrations.ts:97/669-783`、`app.ts:1707-1743` |
| 打开慢 | 远程 CDN 阻塞脚本（unpkg phosphor）+ `body{visibility:hidden}` 固定 1.5s 白屏 + 全同步脚本 | `packages/core/src/web/index.html:4-5,18,273-279`、`preview.html:15-16,256-264` |
| 进入项目慢 | 缓存"校验"≈重新扫描：isCacheValid 对每个条目 statSync + readdirSync | `scanner/index.ts:100-126` |
| 进入项目慢 | /api/tree 无并发控制，逐目录展开即逐请求同步扫描 | `app.ts:1746-1766`、`preview.js:531-552` |
| 搜索冻结 | /api/search 递归 readFileSync 每个文件 + 逐行 indexOf，全同步阻塞事件循环 | `app.ts:3014-3128`、`preview.js:1613-1630` |
| 越来越卡 | `ai_chat_sessions` 每次对话写全量历史 JSON；`pruneAiSessions`（ai-sessions.ts:49-58）**只有 CLI 调用**（cli/bin/doc77.ts:225-226），Electron 永不执行 | `app.ts:4254` |
| 越来越卡 | `audit_log`/`sync_log`/FTS 内容表无限累积无保留窗 | 各写入点 |
| 越来越卡 | SW 把每篇打开的文档缓存**两份**（Cache API + IndexedDB `doc77-offline`），均无 LRU/上限 | `sw-policy.js:15`、`sw.js:191-237` |

### 2.4 已排除项

Electron 主进程无 setInterval；preload 无轮询；无 dev-server 混入打包（electron-builder.yml 确认）；自动更新非轮询（updater.ts:59-61 一次性）；无高频日志；项目根 <1 万文件（watcher watch 图非内存主因）；SSE 连接监听器随 req close 正确清理（events.ts）。

## 3. 1.1.4 修复记录

> 状态标记：⬜ 未开始 / ✅ 已完成 / 🚧 进行中。实施完成后回填。

### Part 1 — Hotfix（保留 1.1.3 自动刷新功能，降开销；每项可独立 revert）

| 项 | 内容 | 状态 |
|---|---|---|
| P0-A | `scanner/index.ts`：filetree_cache 移入内存 Map（`Map<projectId\|path, {entries, mtimeMap}>`，每项目 FIFO 上限 ~2000）；`migrations.ts` 加幂等 `DELETE FROM filetree_cache`（表结构保留，db.test.ts:46 断言表存在）；`app.ts:2577` 删除 `scanned_at` 死写（全库无读取者） | ✅ |
| P1-B | `connection.ts:21-52`：`_scheduleSave` 叠加"距上次落盘 <2s 则推迟到 2s"cap → 导出频率封顶 1 次/2s；删 `Buffer.from` 中间复制直写 Uint8Array；`index.ts` 导出 `flushDatabase`（强制立即落盘兜底） | ✅ |
| P1-C | `watcher.ts`：删 `awaitWriteFinish`；`DEFAULT_DEBOUNCE_MS` 300→500；`acquireWatcherRef()`/`releaseWatcherRef({idleStopMs})` 引用计数 + **延迟停止 10s**（防 reload 翻覆）；`app.ts:3716` `/api/events` 包 acquire/release；`electron/src/server.ts:390-396`、`cli/bin/doc77.ts:414-421` 删无条件启动 | ✅ |
| P2-D | `preview.js:94-117`：SSE 回调改 1s 合并队列；`document.hidden` 丢弃、`visibilitychange` 补 flush | ✅ |
| P3-E | sync scheduler 不改代码；CHANGELOG 记录已知风险（interval_seconds 无下限） | ✅ |

### Part 2 — 高性价比架构项（治"打开慢 / 进入项目慢 / 越来越卡"）

| 项 | 内容 | 状态 |
|---|---|---|
| F1 | `scanner/index.ts`：缓存验证降为**单次目录 stat**（目录 mtime 覆盖增删）+ 条目数比对；文件内容修改由 watcher clearCache 精确失效兜底 | ✅ |
| F2 | `sync/src/adapters/s3.ts:5` AWS SDK 移方法内 lazy import（webdav/simple-git 同查）；`sync/src/index.ts` 不再静态 re-export 重型适配器；gallery sharp 方法内 lazy | ✅ |
| F3 | `electron/src/server.ts` 启动时（initDatabase 后）：`pruneAiSessions(24)`；`audit_log`/`sync_log` 90 天保留窗。`.doc77-trash` shadow 孤儿清理发现已由 createApp 的 cleanupTrash（app.ts:1707-1743，30 天保留）覆盖，无需新增 | ✅ |
| F4 | `sw.js`：CACHE_VERSION → `doc77-v3`；Cache API + IndexedDB 各加 200 条上限 + 30 天过期裁剪；`index.html` 移除远程 phosphor 脚本（3 处图标改文字字形）、脚本 defer；`preview.html` 移除渲染阻塞的 highlight 远程 CSS（改 preview.js 懒加载 ensureHighlightCss，vendor 可本地化）；i18n 1.5s 兜底核实：本地 fetch 秒回，保留 | ✅ |

## 4. 专项路线图（后续 AGENT 直接接着干）

### P-A. better-sqlite3 迁移（优先级最高，约 1-2 天）

**为什么**：sql.js 的整库序列化、全内存模型、FTS5 缺失三个根因靠节流只能缓解。迁移收益：export 机制消失（性能放大器根除）、内存基线大降（不再整库常驻 WASM 堆）、FTS5 搜索真实可用、崩溃不丢数据（当前 `flushDatabase` 无调用方，未 export 的写入全部丢失）。

**实施清单**：
1. `connection.ts` 重写：删 `_persistDb`/`_scheduleSave`/`_persist`/`_saveAndClose` 全家桶；**保留 `async initDatabase` 签名**（内部同步实现返回 resolved promise，cli/electron/33 个测试文件的 `await` 零改动）；保留 `DatabaseCompat`/`StatementCompat` 导出名与 `prepare().get()/all()/run()` 形状（`{changes, lastInsertRowid}`）；恢复 `journal_mode = WAL`；`PRAGMA foreign_keys = ON` 保留。
2. 依赖：`packages/core/package.json` sql.js → better-sqlite3@^12（`pnpm-workspace.yaml:13` 的 `allowBuilds: better-sqlite3: true` 已存在，无需改）。
3. **v13 迁移陷阱（必做）**：迁回后 `fts5Available` 变 true，v7 的 `CREATE VIRTUAL TABLE IF NOT EXISTS file_content_fts USING fts5(...)` 会因同名**普通表**已存在而静默 no-op → query.ts 走 FTS5 分支 `MATCH` 抛错被 catch 吞掉 → **搜索返回空结果（比 LIKE 更糟）**。必须加 v13：`fts5Available && 现表非虚拟表` → DROP 重建 + 重跑 `fullIndex`。残留 `temp_fts5_test` 是 temp 表，无害。
4. 行为差异测试面：better-sqlite3 参数类型严格（undefined/NaN 抛错）、get() 列名大小写 —— 142+ 现有测试正好是验证面。
5. **三平台打包验证（上次就是 Windows 打包翻车）**：electron-builder 会自动识别 .node 原生模块 asarUnpack + `@electron/rebuild`（lockfile 3.6.1 已有），但必须 Win/macOS/Linux 实测；npm 发布路径（cli → core）postinstall prebuild 下载需验证网络可达。
6. 验收：export 相关代码全删后 142+ 测试全绿；Windows 打包打开搜索 FTS5 生效；`~/.doc77/data.db` 恢复 WAL 文件；内存基线不再随 DB 线性涨。

### P-B. 搜索改造（依赖 P-A，P-A 完成后 FTS5 原生）

- `/api/search`（app.ts:3014-3128）全文件递归扫描**改走 FTS 索引**（消除事件循环冻结数秒）；保留旧接口兼容重定向。
- fullIndex 增量更新（现在每次保存文件都全量重读 + sha256 + 重写，app.ts:2583）；FTS 内容总量上限（indexer 只有 5MB 单文件上限，总量无限）。
- 若 P-A 未做则备选：自建倒排表 `search_terms(project_id, term, file_path)`（sql.js 可用），查询按 term 精确匹配走索引。

### P-C. boot 并行化

- `electron/src/server.ts:342-413`：listen 先起 → 窗口先渲染 loading → 模块后挂；`cleanupTrash`（app.ts:1707-1743）移出同步路径异步执行；`migrateOldAiChatSessions` 全量读旧表确认是否可一次性迁移后跳过。

### P-D. 其他

- sync scheduler（`packages/sync/src/scheduler.ts`）interval_seconds 加下限（当前用户可配 1s 全量 sync）；sync_log 保留窗。
- node:sqlite 远期选项：Electron 33 = Node 20.18（无 node:sqlite），Electron 35+（Node 22.14+）可用；CLI 模式系统 Node 也不保证 ≥22.5。
- share-manager 60s cleanup、tunnel 3s 重启循环：低风险，暂不动。

## 5. 验证清单（用户 Windows 实测，每版必跑）

1. 打开应用观察内存/CPU —— 应显著下降，内存不再只涨不跌
2. 任务管理器确认内存基线（data.db 所在进程）
3. 进入项目/展开大目录速度
4. 搜索响应
5. 冷启动时间
6. 外部编辑文件 → 目录树自动刷新仍工作（1.1.3 功能不能丢）

## 6. 决策记录

| 日期 | 决策 | 依据 |
|---|---|---|
| 2026-08-15 | 1.1.4 先节流止血（Part 1），better-sqlite3 迁移作下个专项（P-A） | 上次迁移就是 Windows 打包翻车，hotfix 窗口内三平台 native 验证风险高；代码工作量其实很小，风险全在打包验证 |
| 2026-08-15 | 本次范围 = 热修复 + 高性价比架构项（Part 2 F1-F4），搜索改造/boot 并行化排后续 | 范围越大验证周期越长 |
| 2026-08-15 | 保留 1.1.3 目录树自动刷新功能，降开销而非关停 | 用户明确 |

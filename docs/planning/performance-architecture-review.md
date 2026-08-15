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

### P-A. better-sqlite3 迁移 ✅（2026-08-15 完成，分支 feature/better-sqlite3-migration）

**为什么**：sql.js 的整库序列化、全内存模型、FTS5 缺失三个根因靠节流只能缓解。迁移收益：export 机制消失（性能放大器根除）、内存基线大降（不再整库常驻 WASM 堆）、FTS5 搜索真实可用、崩溃不丢数据（当前 `flushDatabase` 无调用方，未 export 的写入全部丢失）。

**实际改动**（commit `fix(core): migrate db layer from sql.js to better-sqlite3 (P-A)`）：
1. 依赖：`packages/core/package.json` sql.js@^1.11.0 → `better-sqlite3@^12.11.1` + `@types/better-sqlite3@^7.6.13`（devDependency；better-sqlite3 v12 自带无 .d.ts，@types 必需非废弃）。`pnpm-workspace.yaml:13` allowBuilds 已存在未改。tsup 无需改（dependencies 自动 external，实证 dist 中 `require("better-sqlite3")`）。
2. `connection.ts` 重写：删 `_persistDb`/`_scheduleSave`/`_persist`/`_saveAndClose`/WASM 加载全家桶；保留 `DatabaseCompat`/`StatementCompat` 类名与 API 形状、`async initDatabase` 签名（内部同步，返回 resolved promise）、`getConnection`/`closeConnection` 守卫语义；`flushDatabase()` 改 **no-op**（WAL 下每写即落盘，仅 API 兼容保留，零生产调用方）；恢复 `journal_mode = WAL` + `foreign_keys = ON`；内部用本地结构化接口（`NativeDatabase`/`NativeStatement`）持 better-sqlite3 实例，类型不泄漏进 dist/index.d.ts。
3. **v14 迁移（注意编号：v13 已被 1.1.4 的 filetree_cache 清理占用）**：`fts5Available && file_content_fts 非虚拟表` → DROP 普通表 + `search_index_meta`（必须：否则 hash 短路让重索引全跳过，FTS 恒空）+ `ai_messages_fts` + 3 个悬空触发器（挂在 ai_messages 上不随表删，不 DROP 则后续 INSERT 全抛）→ 重跑 `SEARCH_SCHEMA_SQL` + `AI_V9_SCHEMA_SQL` → `INSERT INTO ai_messages_fts(ai_messages_fts) VALUES('rebuild')`（外部内容表重建索引）→ 同步 `fullIndexSync` 重索引所有项目（一次性 boot 延迟）。新增 `fullIndexSync`（indexer.ts，fullIndex 的同步版，无 yield/progress）。
4. 行为差异修复：`session-store.ts` `searchMessages` FTS5 分支包 try/catch（better-sqlite3 对纯标点等非法 MATCH 语法抛错，旧 shim 吞错返回 []）；严格绑定审计（undefined/NaN）全量 grep 无违规调用点。
5. 测试：persist-throttle.test.ts 改写为 WAL / 写后立即持久化（关→重开读回）/ flushDatabase no-op / **FTS5 端到端（indexFile → searchProject MATCH 命中，此前从未被测过）**；其余 142+ 用例零改动全绿（748 通过）。
6. 打包：`packages/electron/electron-builder.yml` 加 `asarUnpack: ["**/node_modules/better-sqlite3/**"]`；electron-builder 25 `npmRebuild` 默认 true 打包时按 Electron ABI 重建（**仓库无 @electron/rebuild，也不需要**——修正此前"lockfile 已有"的错误假设）；CI release-electron.yml 无需改（hoisted linker 下 better-sqlite3 + bindings 落根 node_modules，现有 glob 覆盖）。

**遗留问题**：
- query.ts / session-store.ts 的 LIKE fallback 分支成死代码（better-sqlite3 恒有 FTS5）→ 归 P-B 清理
- 发布后的 @doc77/core 带原生依赖：安装期 prebuild-install 需网络（三平台预编译已发布，备选本地编译）
- 旧库升级首次启动有一次同步重索引延迟（一次性）
- 2026-07 那次 Windows "Cannot GET /" 实为静态资源打包 bug（dist/web 未进 tarball），非原生模块失败——本次原生风险面已由 asarUnpack + npmRebuild 覆盖，仍需用户 Windows 实测

**验收**：export 相关代码全删后 748 测试全绿（基线 745 + 新增 3）；旧 sql.js 库升级冒烟通过（普通表 → 虚拟表 + 重索引 MATCH 命中）；Windows 打包打开搜索 FTS5 生效 + `~/.doc77/data.db-wal`/`-shm` 出现由用户实测。

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

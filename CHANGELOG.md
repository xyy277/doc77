# Changelog

This document records all notable changes to Doc77 packages. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [2026-08-19] — `1.1.10`

**Fixed — preview 多 tab 内容缓存失效链（core/web）**
- **外部修改自动刷新**：SSE `file-tree:changed` modify/mixed 事件命中打开中的 tab 时，活动 tab 1s 节流自动重载新内容（编辑中/页面隐藏不打断，横幅保留）；后台 tab 切回激活时强制 fresh 重拉。修复前三层前端缓存（`tabDataCache`/`paneCache`/SW SWR）命中即走、从不校验新鲜度——外部更新后已打开 tab 与"刷新目录树后重开"均显示历史内容
- **SW 缓存绕过**：内容请求引入 `x-doc77-fresh` 网络优先语义（横幅手动重载、后台 tab 激活、启动校验共用），修复"清内存缓存后首次仍被 SW SWR 喂旧数据"；fresh 响应照常写回缓存，离线能力不变
- **启动新鲜度校验**：boot 恢复的 tab 后台校验（带 If-None-Match，未变走 ETag 304 零渲染），覆盖"应用关闭期间文档被外部修改、重启后显示旧内容"
- **目录树刷新兜底**：刷新后对比 open tab 的服务端 mtime（SSE 断线/漏事件/单事件 paths>50 truncated 时生效），走与 SSE 同款自动刷新链路
- **ETag 精度**：markdown ETag 去 `Math.round` 保留 `mtimeMs` 小数，粗粒度文件系统同秒内修改不再 304 复用旧体
- 新增 `doc-freshness.js` 纯函数模块（`isNewer`/`autoReloadDecision`）；SW `CACHE_VERSION` v4→v5 清除修复前残留的过期 SWR 条目

**验证**
- 测试 929 passed（+8：doc-freshness 决策矩阵、ETag 小数精度）
- 实测：ETag 小数精度、If-None-Match 304、外部修改 etag 失效、SSE modify 事件携带路径

---

## [2026-08-18] — `1.1.9`

**Fixed — watcher OOM（core）**
- **chokidar `followSymlinks: false`**：注册项目为 pnpm monorepo 时（`packages/*/node_modules` → `.pnpm` 虚拟 store 交叉 symlink 图），chokidar 默认跟随 symlink 展开成指数级枚举——`ready` 永不触发、零事件、以 ~17-25MB/s 分配 fs 对象直至 V8 4GB 堆满 OOM（打开 Dashboard 后 ~4 分钟崩溃，exit 134）。symlink 按普通文件处理（node_modules 本就在忽略列表）；项目根 `fs.realpathSync` 归一化保证 symlink 项目根仍可监听。回归测试：symlink web fixture（120 包 + 60 symlink）旧代码 `watcherReady()` 超时、新代码毫秒级
- 沙箱实测：全量 preview 流量 3 分钟 RSS 恒定 ~323MB（修复前 80s OOM）

**Fixed — config 敏感值加密（core/cli/electron）**
- **机器密钥文件 `config.key`**（与 `data.db` 同目录、权限 0600、AES-256-GCM）：`ai.token` 等敏感 config 值统一加密落库。修复前 CLI `doc77 config set` 从未加密；设置页加密分支依赖 `user_auth.pbkdf2_salt`，DEK 迁移后该字段被清空导致加密失效 → 明文落库
- `setConfig`/`getConfig` 统一加解密（读取三级回退：机器密钥 → 旧 pbkdf2 派生 key → 明文兼容）；`listConfig`/`GET /api/config` 敏感值解密后打码
- 启动幂等迁移 `migrateSensitiveConfigs()`（CLI + Electron）：历史明文/旧密文 → 机器密钥加密
- 删除 app.ts 三处复制粘贴的手工 pbkdf2 解密分支

**Fixed — bfcache 僵尸 SSE 连接（core/web）**
- preview/graph 页 `pagehide`（persisted）主动关闭 EventSource、`pageshow` 重建（Chromium bfcache 冻结页面连接不关闭，占用每源 6 连接槽位 → 反复进出页面后同源请求永久排队）
- SSE 心跳 30s（NAT/代理空闲超时）+ write 失败即收割（`res.destroy()` 保证 watcher 引用释放）
- graph 页 SSE 作用域提升至 factory 级（pageshow 可重建）；SW `CACHE_SHELL` LRU 上限 50

**验证**
- 测试 921 passed（+13：watcher followSymlinks 回归、config 加密 roundtrip/兼容/迁移幂等/权限）

---

## [Unreleased] — 红队性能专项（待发布版本）

**Changed — 保存链（core）**
- **原子写替换 shadow**：`PUT /api/content/:id` 改 tmp+rename（修复前每次保存整文件复制到 shadow 后立即删除，成功路径 100% 白做）；写失败时原文件从未被触碰
- **content 透传**：保存点内容已在内存，FTS 与图谱索引直接复用（修复前同一文件被读 3 次 + sha256 3 次）
- **增量图谱索引事务包裹**：50 链接文档从 ~52 次 autocommit fsync 降到 1 commit；watcher 兜底路径 mtime+size 前置短路（不再重读文件）
- **保存路径零目录重扫**：createLinkResolver 复用共享文件列表缓存（10k 文件保存 +10-50ms → <1ms）

**Changed — 文档渲染（core）**
- **wikilink 解析索引化**：O(链接数×文件数) 线性扫描 → O(链接数) Map 查找（100 链接 × 1 万文件从数秒 → ~56ms）；`.doc77links` 别名表按 mtime 缓存；文件列表缓存原地增删（保存/重命名/删除挂点）
- **`/api/content` markdown ETag/304**：重复打开文档免全量渲染（304 短路在渲染前）
- 行为修复：node_modules 内 .md 不再作为 wikilink 目标（与图谱语义统一）

**Changed — 服务端阻塞消除（core）**
- **discover 异步化**：`/api/discover` 与 `/api/discover/git` 改 fs.promises + 每 64 目录让出 + deadline（git 分支修复前无 deadline，大 home 目录 5-30s 同步冻结）+ 并发限流 429
- **find-folder 异步化**：execFileSync 同步外部 find（最坏 8-40s 冻结）→ execFile 异步 + 每 root 超时 + 并行 + 总 deadline；路由补 lanRestrict + 入参上限
- **busy_timeout 5000ms**：WAL 多连接并发写（MCP 副本/sync/图谱重建）不再立即 SQLITE_BUSY

**Changed — 前端（core）**
- **SSE 熔断**：preview 页连续 3 次失败即关闭并提示（修复前服务重启后每 3s 无限重连，每次触发 watcher 全树枚举风暴）；graph.js 熔断死代码修正（readyState 条件在自动重连期恒 false）；新 i18n `web.preview.sseLost`

**验证**
- 测试 908 passed（+27：原子写、ETag、discover async 对等、find-folder 注入、wikilink 索引对等/缓存失效、保存链透传/短路/事务回滚、性能回归 2 项）
- 性能实测：增量索引 0.2ms/文件（修复前 10-50ms+）；100 链接 × 1 万文件渲染 56ms（修复前数秒）

---

## [2026-08-17] — `1.1.8`

### 全包 (`1.1.8`)

**Added — 图谱页导航与布局降级（core）**
- **显式返回 Dashboard 按钮**：图谱页 header 左侧新增"← 返回首页"（修复前仅 logo 可点击返回，外观是页面标题用户未察觉）；i18n `web.graph.backToDashboard` 双语
- **大图快速布局横幅**：>2000 节点自动网格布局时顶部横幅提示 + 一键"启用力导向布局"按钮（`web.graph.layoutHint` / `web.graph.enableForce` 双语）

**Changed — 图谱进入性能（core/electron）**
- **大图布局降级**：>2000 节点默认网格快速布局（首帧 <100ms 立即可交互，修复前 d3-force 全量模拟数千节点卡死数秒）；物理参数按节点数分段自适应（1000+/2000+ 去 collide、提高 alphaDecay、弱电荷）
- **洞察数据懒加载**：orphans/broken 移出进入关键路径（修复前每次进入/SSE 刷新都拉 1MB 全量），空闲后台加载 + 打开面板即时拉取
- **draw() 边视口裁剪**：大图每帧从 O(E) 降到 O(可见边)；boot 时 d3-force 预加载与数据请求并行（原先串行 4 个 UMD）
- **Electron 常驻 CPU 修复**：`fullGraphIndex` 加 `file_hash` 短路（修复前每次启动对全部项目全量重建图谱，10k 文件 20-30s 单核满负荷 = 常驻 CPU ~10%）；bootstrap 串行化避免多项目并发峰值
- **移除强制 GPU 开关**：`enable-gpu-rasterization`/`enable-zero-copy` 在无 GPU 环境（WSL2/虚拟机）强制 SwiftShader 反向加码，删除后恢复 Chromium 自动策略

**Fixed**
- grid 布局模式节点拖拽失效（无 sim 时只设 fx/fy 无消费者，改直写 x/y）
- hash 短路回归：删除文件后指向它的 resolved 边不再自动标 broken（stale 清理补显式自愈）

**验证**
- 测试 873 passed（+20：shouldAutoForce/physicsFor/gridLayout/applyOrphans/边裁剪 18 项 + indexer 短路 2 项）
- Playwright 浏览器冒烟 22/22（新增返回按钮、2500 节点大图降级、小图回归守卫三节）
- 性能：启动图谱重建 10k 文件 20-30s → 秒级（未变更文件全部跳过）

---

## [2026-08-16] — `1.1.7`

### 全包 (`1.1.7`)

**Added — 知识图谱二阶段：可视化 + 洞察（core）**
- **`/graph` 力导向图谱页**：Canvas + vendor 懒加载 d3-force（dispatch/quadtree/timer/force 4 模块按序），5000 节点 <60fps（DPR≤2、视口裁剪、标签上限、收敛即停）；节点大小 = 入链数、颜色 = 首标签、孤立页淡化开关；拖拽/缩放/点击打开文档、FTS 搜索定位（缩放居中 + 高亮）
- **多项目聚合图谱**：`/api/graph?projects=` 家族（nodes/stats/orphans/broken，查询层 IN 合并零表结构改动）+ `mode=full` 全量模式（20k 节点/200k 边上限 + truncated 探测）；项目 tab 切换含"全部"
- **洞察侧栏**：孤立页/死链列表（与 stats 同谓词共享，计数永远一致），断链行点击打开源文档编辑
- 入口：dashboard 导航 + preview 工具栏；PWA shell 资产；i18n `web.graph.*` 双语

**Added — AI 对话引擎（ai/cli/electron）**
- AgentLoop 会话处理（SessionStore 持久化）+ Ollama provider 支持 + 会话消息树/中断/regenerate

**Changed**
- **SSE 认证**：`/api/events` 接受 `?token=` 查询参数（EventSource 无法携带 header；窄范围仅该端点，header 优先）——预览页与图谱页设密后事件推送恢复
- **安全加固**（独立对抗性审查 38 项发现修复）：XFF 信任边界（修复伪造 `X-Forwarded-For: 127.0.0.1` 绕过隧道门控的 P1 漏洞，仅本机代理转发时信任且取末条真实 IP）；limit 参数下界 clamp（负值不再绕过上限，防 LAN 内存 DoS）；聚合路由 FULL caps；`JSON.parse(tags)` 防御；严格整数参数解析
- **图谱页修复**（审查确认 21 项）：拖拽失效（sim 收敛后保留引用 lazy restart）、属性注入 XSS（escAttr → esc）、命中半径随缩放、reload 保留缩放视图、SSE 401 重连循环（3 次失败提示）、d3 vendor 探测缺失（离线即挂）、孤儿 >10000 上限提示

**Fixed**
- d3-force UMD 依赖加载（单文件加载抛 `r.timer is not a function`）
- POST `/api/graph/:id/index` 双重建（5s 去抖计时器未取消 → 全量 ×2）
- 子图边查询窗口截断（>8000 边项目锚点边静默缺失）

**验证**
- 测试 853 passed（+21 独立验证新增）；perf 回归：5000 节点全量图接口 ~49ms、20 万边表孤儿/断链 ~30ms、事件循环停顿 <50ms
- Playwright 浏览器冒烟 13/13（`pnpm exec tsx scripts/graph-e2e-smoke.mts`）
- 审查记录 `docs/planning/graph-viz-review.md`；手工冒烟清单 `docs/planning/graph-viz-smoke-checklist.md`

---

## [2026-08-16] — `1.1.6`

### 全包 (`1.1.6`)

**Fixed**
- **目录树刷新失效（1.1.5 回归）**：外部新增文件后，已展开的目录内容不更新（点 🔄 刷新、重进项目均无效）
  - Web: 🔄 刷新按钮改为刷新根目录 + **所有已展开的目录**（此前只刷新根目录，展开子目录的 DOM 与 SW 缓存条目永不更新）
  - Web: Service Worker `CACHE_VERSION` bump 至 `doc77-v4` —— 清除 1.1.4 时代缓存的旧 `/api/tree` 条目（SWR 命中即返回旧数据）
  - Core: watcher 初始枚举窗口期（chokidar 递归建 watch，大项目根可达数十秒）内发生的文件变化不产生事件 → `ready` 后为每个项目补发一次全量刷新事件；另加 SSE 连接 5s 定时兜底（`ready` 不触发的大目录环境）

---

## [2026-08-15] — `1.1.5`

### 全包 (`1.1.5`)

**Changed**
- **DB 层迁移：sql.js（WASM 全内存）→ better-sqlite3（原生）** — 三个性能根因一次性根除：
  - Core: 删除 sql.js 全库 export 序列化 + 去抖落盘机制（1.1.3 性能灾难放大器，1.1.4 节流为临时缓解）— WAL 模式下每写即落盘，崩溃不丢数据，`flushDatabase()` 保留为 no-op 兼容导出
  - Core: DB 不再常驻 WASM 堆，内存基线不再随库大小线性增长
  - Core: **FTS5 搜索真实可用**（sql.js 官方 dist 无 FTS5，此前一直是 LIKE 全表扫描）；历史库自动迁移（v14：FTS 表 DROP 重建 + 一次性全量重索引）
- Core: `flushDatabase` 语义变更（no-op），`persist-throttle` 测试改写为 WAL/持久化/FTS5 回归

**Fixed**
- Web: 删除/新建/重命名文件后，目录树在刷新或重进项目时可能仍显示旧状态（再操作报"文件不存在"）— Service Worker 的 SWR 缓存对 `/api/tree` 命中即返回旧数据且变更后从未失效；现在变更类请求通过时清除该项目范围的缓存条目，SSE 刷新响应同步写回缓存

**Docs**
- `docs/planning/performance-architecture-review.md`：P-A 专项标记完成 ✅，记录实际改动与遗留问题

---

## [2026-08-15] — `1.1.4`

### 全包 (`1.1.4`)

**Fixed**
- **致命性能回归（1.1.3 引入）**：文件监听链路每个 fs 事件 → 目录缓存 DB 写 → sql.js 整库序列化落盘，导致内存暴涨至 ~1500MB、CPU 持续 ~10%、打开即卡死
  - Core: 目录树缓存移入进程内内存 Map（不再读写 `filetree_cache` 表，热路径 0 DB 写；表结构保留，历史行启动时清理；删除 `scanned_at` 死写）
  - Core: sql.js 全库序列化落盘加最小间隔节流（连续写入时最多每 2s 一次，与写入频率/库大小解耦；`flushDatabase()` 仍强制立即落盘，新增导出）
  - Core: 文件监听改为**惰性启动**（首个 SSE 客户端连接才启动，断开后延迟停止）— 无 UI 客户端时零开销；移除 `awaitWriteFinish` 的 50ms stat 轮询；去抖 300ms → 500ms
  - Web: 目录树刷新合并为 1s 去抖，页面隐藏时不刷新（恢复可见补刷）
- Core: 目录扫描缓存校验从逐条目 statSync 降为单次目录 stat（O(N) → O(1)，"进入项目/展开目录"明显提速；内容修改由 watcher 精确失效兜底）
- Core: 启动不再无条件加载 4.5MB AWS SDK / webdav / simple-git / sharp（改为按需动态加载）— 冷启动提速
- Electron: 启动补 `pruneAiSessions(24)` 与 `audit_log`/`sync_log` 90 天保留窗（此前仅 CLI 清理会话，Electron 永不清 → 表无限膨胀拖慢全库序列化）
- Web: Service Worker API 缓存（Cache API + IndexedDB 各一份）加 200 条上限 + 30 天过期裁剪（此前无上限，长期使用存储无限膨胀）
- Web: 首屏去阻塞 — 移除远程 phosphor 图标脚本（3 处图标改文字字形）、脚本加 `defer`、highlight 主题 CSS 改懒加载（原远程渲染阻塞）

**Docs**
- `docs/planning/performance-architecture-review.md`：性能根因证据链（sql.js 全库序列化放大器 + watcher 引爆链路）、修复记录、后续架构专项路线图（better-sqlite3 迁移 P-A / 搜索改造 P-B / boot 并行化 P-C）

**已知风险**
- `sync` 调度器 `interval_seconds` 无下限（用户可配置 1s 全量同步）— 级联已拆断后仅剩扫描成本，后续专项处理

---

## [2026-08-14] — `1.1.3`

### 全包 (`1.1.3`)

**Fixed**
- Web: Service Worker 不再拦截非 GET 请求 — `cache.put` 对非 GET 响应抛异常曾导致新建文件/文件夹/重命名/删除误报 `503 offline`（文件实际已创建）；`CACHE_VERSION` bump 至 `doc77-v2` 清除旧 shell 缓存
- Web: 预览复制内容改为复制**原始 Markdown**（走 `/api/raw`，此前复制渲染 JSON/HTML）
- Web: 重命名弹框预填当前文件名（`promptDialog` 读取 `defaultValue`）
- Web: 目录树刷新改为增量 diff 渲染 — 展开状态与选中高亮保留，仅增删改变化的行
- Web: 新建/重命名/删除 — 取消不再误弹成功 toast；创建后自动定位新节点；重命名/删除同步迁移或关闭打开的 tab
- Core: `/api/raw` MIME map 补 `md`/`markdown`/`txt`

**Added**
- Core: chokidar 文件监听（`server/watcher.ts`）— 外部改动（git / webdav / 编辑器 / agent 写入）→ `file-tree:changed` SSE 事件；按目录 300ms 去抖合并，paths 上限 50 防事件风暴
- Core: 事件总线移至 core（globalThis 单例）— 修复 Electron 双 core 副本事件断裂；`/api/events` 无条件注册（不再依赖 MCP 安装）
- Web: SSE 驱动目录树自动局部刷新；外部删除打开中的文件 → 关闭 Tab + 提示；外部修改 → 横幅 + 手动重载（保存仍走 409 乐观并发）
- Docs: `docs/analysis/spec-status-2026-08-14.md`（11 份 spec 核对报告）+ README Sync 章节（git/webdav/s3/local 使用指南）

---

## [2026-08-14] — `1.1.2`

### 全包 (`1.1.2`)

**Fixed**
- Electron: 修复发布门禁测试 — fileAssociations 断言从 `package.json` 迁移至 `electron-builder.yml`（构建配置已随 95721cb 迁移）
- Web: AI workspace 新增 settings 抽屉，修复 dark theme 与 preview settings 面板侧移（`translate-x-full`）问题
- Web: 预览复制改为复制渲染后的 HTML（而非原始 JSON）
- Web: 修复 `wireActions` 中 aiMessages 节点被错误替换的问题
- Gallery: 恢复 auth token、thumbnail API 与目录导航

## [2026-08-12] — `1.1.1`

### 全包 (`1.1.1`)

**Added**
- Electron: 登录门禁强制重设（Force Reset）— 同时忘记密码与 recovery code 时，经 IPC + 原生对话框双重确认重置认证，清除全部敏感配置（token / API key 类），保留文档与项目数据
- Core: `forceResetPassword()` 清除范围扩展至全部敏感 config（`isSensitiveKey` + legacy `ai.base_url`/`ai.model`），新增 in-memory reset-state 清理与 `source` 审计参数（`cli` / `electron` / `web`）
- LICENSE: 新增 MIT 许可证，修复 README license badge 死链

**Security**
- Force reset 通道仅限 Electron 进程内（IPC），LAN / web 客户端无法触发；重置后撤销全部会话并清空 DEK 缓存

## [2026-08-10] — `1.1.0`

### 全包 (`1.1.0`)

**Added**
- Sync: three-way merge（三向合并）引擎、E2EE（End-to-End Encryption）加密适配器（Git / WebDAV / S3）、conflict 检测与 AI 辅助合并、定时调度器、keyring 密钥管理
- AI: RAG（Retrieval-Augmented Generation）引擎 — chunker / embedder / retriever / vector-store，Provider 动态切换
- Core: plugin 沙箱（vm 隔离 + renderer takeover）、tunnel 配置与设备管理 + 强制远程认证、PWA SW 策略、csv/tsv 表格渲染、DB migrations
- Web: sync / tunnel / plugin / conflict / encryption 设置面板，i18n 扩展（+92 keys，共 1074 keys）
- Electron: 系统通知、待处理文件（pending-files）、文件关联（file associations）、接线 sync/rag/plugin 路由
- CLI: wiring-regression 接线回归测试（真实服务器启动 + 真实 fetch 验证）

**Security**
- tunnel 强制远程认证（forced remote auth）
- Sync E2EE 适配器 + keyring 加密存储

## [2026-07-24] — `1.0.8`

### 全包 (`1.0.8`)

**Fixed**
- Gallery: Tailwind CSS 构建时添加 `@source` 指令扫描 gallery 文件，确保样式正确生成
- Monorepo: vitest 添加 root 配置，修复 monorepo workspace 解析问题

## [2026-07-24] — `1.0.7`

### 全包 (`1.0.7`)

**Security**
- 登录端点新增速率限制：每 IP 每分钟最多 5 次尝试，超限返回 429

## [2026-07-24] — `1.0.6`

### 全包 (`1.0.6`)

**Fixed**
- Gallery album 点击后不显示图片缩略图：backend 忽略 `paths` 过滤参数
- Gallery 页面仍使用 CDN tailwind，离线环境样式丢失

## [2026-07-24] — `1.0.5`

### 全包 (`1.0.5`)

**Changed**
- Tailwind CSS: 从 CDN 运行时（400KB JS）迁移到构建时静态生成（47KB CSS）
- Vendor 资产: 移除 tailwind.js 依赖

**Fixed**
- 修复 tailwindcss CDN 连接失败时 preview 页面样式丢失的问题
- 修复 express.static dotfiles 默认 `ignore` 导致 vendor `.ready` 不可读的问题
- Electron 构建缺失 gallery 包，导致注册项目卡片无 git 标记、相册等功能不可用
- CI check:i18n 白名单未包含 mcp prompts（AI 系统提示词），导致流水线失败
- CI 中 gallery 测试因 express 非直接依赖在 pnpm symlink 模式下找不到模块

## [2026-07-22] — `1.0.4`

### 全包 (`1.0.4`)

**Added**
- 文件管理：tree 右键上下文菜单（重命名/复制/删除/移动）
- 工具栏新增三按钮：✏️ 编辑 / ↗️ 外部编辑器 / 📂 打开文件夹
- 增量树刷新：sse 事件驱动局部更新，避免整树重载

**Fixed**
- WSL 环境下外部编辑器调用适配
- `enterEditMode` 守卫拆分：分离文件选择与编辑器打开逻辑
- 文件管理 3 个边缘 case bug

**Changed**
- 工具栏图标重新设计，采用 icon-only 风格
- `extract-changelog.cjs` 添加 `shell: bash` 以兼容 Windows CI runner

## [2026-07-22] — `1.0.3`

### 全包 (`1.0.3`)

**Added**
- 分享页和导出 HTML 新增文档大纲侧边栏，基于 h1-h3 标题自动生成（桌面端 sticky 右侧栏 + 移动端 FAB 底部抽屉）
- `normalizeMessages` 函数：在 LLM 调用前合并多条 system-role message，兼容 ChatML 模型（如 Qwen）

**Fixed**
- MCP HTTP transport 的 `serverInfo.version` 从硬编码 `1.0.0` 改为读取 `VERSION`
- Electron CI 构建：修复 `gen-latest-yml.cjs` 中文件扩展名大小写匹配问题

**Changed**
- 跨平台端口释放：`dev:start` / `dev:restart` 用 `kill-port.cjs` 替代 Linux 专用的 `fuser -k`

## [2026-07-19] — `1.0.2`

### 全包 (`1.0.2`)

**Fixed**
- Electron AI 模块一键安装：tarball 闭包方案（@doc77/ai + @doc77/core）无法满足 core 的第三方运行时依赖（express/sql.js/marked），重启后模块沉默加载失败 → 永远显示「未安装」。改为 npm 完整依赖树安装（与 translate/mcp 一致）
- Electron 中文环境下后端提示为英文：Windows 无 LANG/LC_ALL，core 的 i18n 自动检测落到 en-US。boot() 将 Chromium `app.getLocale()` 注入为 LANG 供检测
- 翻译模型下载未生效国内镜像：settingToggle 是 `<button data-value>`，下载代码误读 `.checked`（恒 undefined），导致始终直连 huggingface.co。改为读取 `dataset.value`

## [2026-07-19] — `1.0.1`

### 全包 (`1.0.1`)

**Fixed**
- Electron 桌面版启动无窗口（僵尸进程）：`loadDefaults` 默认写入的 `server.port=27777` 被桌面版盲目采用，与 CLI 实例抢端口 → listen 失败且 `boot()` 无 catch。现在仅显式非默认端口且空闲才采用，否则保持 28888+ 探测端口；窗口加载实际监听端口；boot 失败写 `~/.doc77/electron-error.log` 并弹错误框
- npm 包页面空 README：`pnpm publish` 不上传 readme 元数据。发布流程改为 `pnpm pack`（保留 workspace 解析）+ `npm publish <tarball>`；新增 `scripts/sync-readme.cjs` 将根 README（相对链接转绝对 GitHub URL）同步到 idoc77 包

**Changed**
- npm 旧版本治理：idoc77 与 @doc77/ai 的 0.x/beta 版本已全部 unpublish；@doc77/core/mcp/cli 因被依赖不可删除，已全部标记 deprecated
- 本版本为 1.0.0 的重新发布（npm 不允许复用已撤下的版本号）；1.0.0 将随本版本上线后从 npm 撤下

## [2026-07-17] — `1.0.0-beta.2`

### All Packages (`1.0.0-beta.2`)

**Fixed**
- Electron desktop crash `ERR_REQUIRE_ESM`: main process static `import { t } from '@doc77/core'` was transpiled to `require()` by tsc, but core's CJS build loads ESM-only `marked`, and Electron's built-in Node 20 does not support `require(esm)`. Changed to deferred binding shim (core only loaded via dynamic `import`), added build gate `verify-no-static-core.cjs` to prevent regression

## [2026-07-17] — `1.0.0-beta.1`

### All Packages (`1.0.0-beta.1`)

**Added**
- Multilingual UI: English / 简体中文 built-in, auto-detects browser and system language, `~/.doc77/locales/<lang>.json` external language pack directory for extensibility (755+ entries, six-layer coverage: Web/CLI/API/MCP/AI/Electron)
- Self-contained HTML export: one-click export with inline styles and images, preserves light/dark theme, footer link corrected to GitHub repo
- LAN read-only sharing: create share links (`/s/<token>`, QR code, revocable), configurable TTL, sensitive file filtering
- Offline translation: Opus-MT ONNX models fully local (en↔zh), auto-language detection (CJK heuristic), translate-on-select + long-doc segment translation
- Enhanced project import: Obsidian vault (`[[wikilink]]` resolution), Git project batch scan, VS Code workspace import, tech-stack tag recognition
- Mobile companion: Dashboard QR code to mobile view, mDNS LAN discovery, adaptive mobile UI
- Multi-tab preview: multiple document tabs (LRU render cache), drag-and-drop temp file preview, lightweight text editing (external change conflict detection)
- Dashboard cards: favorites count, recent files strip, project tag badges, Obsidian icon
- AI model input: datalist replaces hardcoded select, supports custom model names
- Dynamic settings tabs: System/AI/Account/Translation/Share unified rendering (home + preview pages)
- Extended pre-commit gate: `pnpm check:i18n` covers hardcoded Chinese scan + `data-i18n` nesting constraints + `t` parameter shadowing detection

**Changed**
- Default port: CLI `2777 → 27777`, Electron desktop default `28888` (prevents conflict with CLI instances)
- Backend `t()` global language switch takes effect immediately (no restart), auto-reloads frontend when no UI override exists
- `getReadTools/getWriteTools` factory pattern (lazy evaluation, avoids module loading timing issues)
- MCP tool descriptions localized per global language
- AI system prompt bilingual (English/Chinese)

**Fixed**
- `applyI18n` using `textContent` to replace text destroyed nested child elements (`#favCount`/`#projCount`/`#pendingBadge`) — moved to inner plain-text spans; `check-i18n` added violation rules
- `renderTabBar`/`loadTasks` callback parameter `t` shadowed global i18n `t()` — full repo rename + `check-i18n` prohibition rule
- `createAIChatHandler` factory destructuring lost `AiProvider`/`DocAgent` — threw ReferenceError on every AI conversation
- `translate()` had no actual language detection, "document" → Chinese model → degenerate repetition — added `detectLang()` + same-language no-op
- Translate-on-select popup 8s auto-remove race condition: slow translation result rendered to already-removed node — cancel idle timer on click
- Three dead links `doc77.dev` → GitHub repo in export output
- index/preview.html settings tabs inconsistent (preview missing share tab, styles misaligned)
- Dashboard QR code moved into hero right side, auto-hidden on narrow screens
- `katexCss` removed `href="about:blank"` (eliminates `ERR_UNKNOWN_URL_SCHEME` console noise)
- transformers.js MarianTokenizer known harmless warning suppressed

**Design** (see specs)
- Internationalization design: `docs/superpowers/specs/2026-07-16-i18n-design.md`
- Internationalization implementation plan: `docs/superpowers/plans/2026-07-16-i18n.md` (18 tasks)

## [2026-07-16]

### @doc77/core `0.9.0`

**Added**
- Temp file drag-and-drop preview: `POST /api/render-temp` stateless render endpoint, supports Markdown / code / Mermaid text formats in-memory
- Browser-side drag interaction (`initDropZone` + `openTempTab`): drop files onto preview page → open as temp tab with 📎 indicator, disappears on refresh
- Binary preview types (images / PDF / docx / xlsx) rendered via `URL.createObjectURL`, no backend involvement
- Temp file type classification + first 8KB null-byte sniffing, mirrors server-side `isBinaryFile` semantics
- Temp tab lifecycle: no localStorage persistence, disable edit/AI/reveal buttons, auto `revokeObjectURL` on `releaseTab`
- Frontend UMD module `temp-preview.js`: `makeTempPath` / `isTempPath` / `classifyTempFile` / `sniffBinary`

## [2026-07-12]

### @doc77/core `0.6.0`

**Added**
- Password recovery: envelope encryption (DEK) + 10 one-time recovery codes (Crockford Base32)
- Cryptography extensions: HKDF-SHA256, Crockford Base32 encode/decode, CRC-16 checksum
- DEK wrap/unwrap: AES-256-GCM, dual path via password and recovery code
- Forgot password API: `POST /api/auth/forgot-password/verify` + `/reset`
- Change password API: `POST /api/auth/change-password`
- Recovery code management API: `GET /api/auth/recovery-status` + `/api/auth/recovery-codes`
- Audit log extensions: `password_changed`, `recovery_code_used`, `recovery_codes_regenerated`, `password_force_reset`
- `user_auth` table v2 migration: 11 new columns supporting envelope encryption

**Security**
- Enhanced key derivation: scrypt N=131072 (per design spec) + HKDF domain separation
- Independent brute-force protection: login locks for 15 min after 5 attempts, recovery codes independently lock for 15 min after 5 attempts
- Recovery code security: shown once, scrypt-hashed storage, timingSafeEqual against timing attacks
- Legacy mode compatibility: auto-migrate to envelope encryption on password change

**Changed**
- `POST /api/auth/setup` returns recovery code list
- `GET /api/auth/status` now includes `hasRecovery` field

### @doc77/cli `0.2.0`

**Added**
- `doc77 config set-password` — outputs recovery codes
- `doc77 config change-password` — interactive password change
- `doc77 config reset-password` — recovery code password reset
- `doc77 config reset-password --force` — force reset (clears encrypted config)
- `doc77 config recovery-codes` — regenerate recovery codes

### Web UI `0.6.0`

**Added**
- Forgot password flow: login gate "Forgot password?" link → recovery code verification → new password setup
- Recovery code display dialog: shows 10 recovery codes after initial password setup, one-click copy
- Account settings enhancement: remaining recovery code count, regenerate button, new change-password API

---

## [2026-07-08]

### @doc77/core `0.2.5`

**Changed**
- Improved static file directory resolution: added 3 candidate paths (`dist/web/`, `src/web/`, `dist/../src/web/`), covers more deployment scenarios
- Added explicit `GET /` route, returns fallback HTML even when web directory is missing, avoids 404
- Removed cross-package import (`../../mcp/src/transaction/executor.js`), added `createQueueApproveHandler()` factory function export

**Fixed**
- Homepage 404 issue: `@doc77/core` resolved to old npm version in pnpm workspace, causing `express.static` not mounted

### @doc77/mcp `0.1.6`

**Changed**
- Internal deps changed to `workspace:^` protocol

### @doc77/ai `0.1.5`

**Changed**
- Internal deps changed to `workspace:^` protocol

### @doc77/cli `0.1.8`

**Changed**
- Register `/api/queue/approve` route (`createQueueApproveHandler` + `executeApprovedTasks`)
- Internal deps changed to `workspace:^` protocol

---

## [2026-07-07]

### @doc77/core `0.2.3`

**Fixed**
- Static file packaging: build script adds `cpSync('src/web','dist/web')`, ensuring web resources are included in published package
- Fixed DB connection detection crash in `/api/health` when `express.static` was missing

### @doc77/core `0.2.2`

**Fixed**
- Fixed `express.static` path fallback logic

---

## [2026-06-28]

### @doc77/core `0.2.1`

**Fixed**
- Express 5 type compatibility: `req.query.path` type adaptation

### @doc77/core `0.2.0`

**Added**
- Preview engine: Markdown, Mermaid, code highlighting, images, PDF rendering
- Filesystem abstraction layer: path validation, sensitive file detection
- Directory scan: file tree + cache

---

## [Initial Release]

### @doc77/core `0.1.0`
- Database layer (SQLite via sql.js)
- Project management (CRUD)
- Config management
- Express Server + API routes

### @doc77/mcp `0.1.0`
- MCP protocol implementation (stdio / SSE transport)
- Operation queue and approval flow
- Transaction system (Shadow Copy + Rollback)
- Session management

### @doc77/ai `0.1.0`
- AI Provider abstraction layer
- OpenAI-compatible adapter
- Agent core logic

### @doc77/cli `0.1.0`
- CLI command entry (`doc77 start|register|list|remove|...`)
- Web Dashboard startup

---

## Publishing Notes

- Use `bash scripts/publish.sh <package> [bump]` for selective publishing, not bulk publish
- `workspace:^` protocol ensures local packages are linked during development, auto-replaced with version numbers on publish

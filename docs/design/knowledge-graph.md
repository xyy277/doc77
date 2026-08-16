# 知识图谱设计（v1.2.0 链接基础设施 + v1.2.1 可视化/洞察）

> 语言规范：专业术语英文，其余中文（见根 CLAUDE.md）。

## 1. 背景与目标

对标 Notion 知识图谱（`[[双向链接]]` + Backlinks 区 + AI 建议相关页；Notion 原生无可视化图）。Doc77 定位本地优先、对话驱动，第一阶段做**链接基础设施**：

1. `[[wikilink]]` 提取全局化（不跟随 obsidian_mode 门控 —— 图谱是数据结构，渲染是显示细节）
2. 反向链接（backlinks）面板 + 相关文档推荐（co-citation 评分）
3. AI 问答注入图谱邻居上下文（N/K/T 预算）

**顺带修复**：非 obsidian 模式 wikilink 渲染成 `doc77-wikilink:` 死锚点的 bug（还原为字面文本）。

**用户决策**：链接基础设施优先；AI 问答用图谱上下文；个人 PKM 优先、预留团队能力（多项目聚合 = 查询层 `IN` 合并，表结构零改动）。

## 2. 架构

```
前端 preview.js（原生 JS，无新依赖）
  backlinks 面板 / related 推荐 / SSE 进度
        │ HTTP                      │ SSE (graph:index-progress)
  routes/graph.ts（createApp 内挂载，Electron 与 CLI 同源）
        │
  graph/  link-extractor（提取，纯函数）→ repository（写库）→ indexer（批处理）
          maintenance（事件挂点）→ related（co-citation）→ context（AI 注入）
        │
  v15 迁移：doc_meta + doc_links（better-sqlite3）
        │ 触发链
  保存挂点 · rename/delete · watcher.flush（外部变更兜底）· POST index · 启动 bootstrap
```

## 3. 数据层（v15）

- `doc_meta(project_id, file_path, title, aliases, tags, file_hash, file_mtime, file_size, indexed_at)` —— 节点属性；`file_hash`（sha256 前 16 位）与 FTS indexer 同构，增量短路
- `doc_links(project_id, from_path, to_path, link_type, anchor, status, display, ...)` —— 有向边；`status` ∈ resolved/broken（**死链入库**，to_path 存规范化目标 key，status 进 PK 防撞）；`link_type` ∈ wikilink/relative
- 反向链接 = `idx_doc_links_to` 聚合查询，无单独表
- **迁移只建表不重建**（v14 阻塞式 fullIndexSync 的教训）：启动后台逐项目重建，图谱缺失可降级显示

## 4. 提取层

- `link-extractor.ts`：`extractLinksFromContent(content, fromRelPath, resolver)` 纯函数 —— ① 剥离 fenced/inline code（防代码示例污染）② wikilink 扫描（`#锚点` 先 split，`|display` 分离）③ relative 链接（过滤外部 URL + 非 markdown 目标，`../` 越界拒绝）
- wikilink 解析复用 `resolveWikilinkIn`（wikilink.ts 抽出的纯函数，渲染期与提取期同一语义：`.doc77links` 别名 → 精确匹配 → 大小写不敏感 → 死链 null）
- `frontmatter.ts`：`extractDocMeta` —— title 复用 FTS `extractTitle` 语义；tags/aliases 轻量 YAML 子集解析（不跨包依赖 ai）
- **仅索引 markdown 家族文件**（.md/.mdx/.markdown，`isGraphDocument` 过滤）—— 代码文件（.ts/.js 等）不产生图谱节点

## 5. 触发链路（图谱是最终一致）

| 触发源 | 位置 | 行为 |
|---|---|---|
| REST 保存 | app.ts PUT /api/content（indexFile 旁） | 增量 `indexFileLinks`（hash 短路） |
| REST rename | app.ts PUT /api/tree/:id/rename | 边与 meta 路径跟随 + 重提取 |
| REST delete | app.ts DELETE /api/tree/:id | 清 meta+出链，入链置 broken；目录删除 → 标记脏 |
| watcher flush | watcher.ts flush（paths 逐个 .md） | 外部变更/MCP 写路径兜底（MCP 写不维护任何索引，此为统一覆盖点）；截断/目录事件 → 标记脏 |
| POST /api/graph/:id/index | routes/graph.ts | 后台全量重建，进度经 SSE `graph:index-progress` 广播 |
| 启动 bootstrap | electron/server.ts + cli/bin/doc77.ts | 逐项目后台全量重建（自愈） |

## 6. API

```
# 聚合（多项目，二阶段；注册于 :id 之前，顺序敏感）
GET  /api/graph?projects=1,2            — 多项目节点+边（聚合全量，project_id 进节点/边）
GET  /api/graph/stats?projects=         — 多项目统计（total + perProject）
GET  /api/graph/orphans?projects=&limit=&offset= — 孤立页列表（与 stats.orphans 同谓词，limit≤10000）
GET  /api/graph/broken?projects=&limit=&offset= — 死链列表（status='broken' 行，limit≤500）
# 单项目
GET  /api/graph/:id                     — 节点+边（?path= 子图 limit≤2000；?mode=full 全量，上限 20k 节点/200k 边 + truncated 标志）
GET  /api/graph/:id/backlinks?path=     — 入链（含 title，limit≤200）
GET  /api/graph/:id/related?path=&limit=— 相关文档（co-citation + 一跳兜底，≤20）
GET  /api/graph/:id/stats               — nodes/edges/broken/orphans
POST /api/graph/:id/index               — 全量重建（立即返回 indexing）
```

安全：path 走 `validatePath`（逃逸 403）；非法 :id/项目不存在 404；缺 `projects` 参数 400；查询只 join 表不触磁盘。

**孤儿/断链一致性**：`getGraphStats`（计数）、`queryOrphans`（列表）共享同一 `ORPHAN_PREDICATE_SQL`（无出链任意 status + 无 resolved 入链）——计数与列表永远一致。

**related 评分**：`score(B) = |out(A)∩out(B)| + |in(A)∩in(B)|`（共享引用数 ×1000 + 入链数 tie-break）；无共享引用的一跳直接邻居 score=1 兜底（被多人引用的中心节点，其相关文档就是直接引用者）。接口 `RelatedScorer` 可替换（三阶段 RAG 语义融合注入点）。

## 7. 前端

- `renderGraphPanel(path)`：文档卡片底部独立 DOM（**不拼进 d.content** —— tabDataCache 缓存 /api/content 响应）；异步 fetch backlinks + related
- 刷新时机：保存回调（doSave）、SSE `graph:index-progress`、SSE `file-tree:changed`（仅当前激活文档受影响时）
- i18n：`web.preview.graph.*`（en-US/zh-CN）

**二阶段：`/graph` 页面**（graph.html + graph.js，入口：dashboard 导航 + preview toolbar 🕸️ 按钮）：

- Canvas 渲染 + vendor 懒加载 d3-force（d3-dispatch/quadtree/timer/force 4 模块按序加载——d3-force UMD 不打包依赖，从全局 d3 命名空间读取；VENDOR_MAP/vendor.ts 双注册）——无 DOM 节点，5000 节点 <60fps 交互
- 节点大小 = 入链数（客户端由全量边精确计数），颜色 = 首标签（确定性 hash → 12 色调色板），孤立页淡化开关（与 orphans 列表同语义）
- 交互：滚轮锚点缩放、拖拽平移、拖节点（fx/fy）、点击打开 preview（`/preview.html?id=&path=`）、FTS 搜索定位（缩放居中 + 2s 高亮）
- 性能：DPR 上限 2、视口裁剪、标签仅 scale≥2 且 ≤400/帧、alpha 收敛后 sim.stop()；物理参数置顶常量
- 洞察侧栏：孤立页/死链列表（客户端分页 + 加载更多），断链行点击打开**源文档**编辑
- 多项目：`/graph?projects=1,2` 聚合视图，项目 tab 切换（含"全部"）；节点 id = `<project_id>:<path>` 防跨项目路径碰撞
- 降级：d3 加载失败 → 网格静态布局；图谱缺失 → 空态 + 重建索引按钮；SSE 索引/变更 → 1s 去抖重载
- i18n：`web.graph.*`（en-US/zh-CN）；测试：`__tests__/graph-viz.test.ts`（纯函数 vitest，无 jsdom）

## 8. AI 集成

- `collectGraphNeighbors(projectId, path, readContent, {maxDocs=3, maxCharsPerDoc=2000, maxTotalChars=6000})` → 注入文本
- 复用 `readProjectFileContent`（敏感文件拦截 + 路径沙箱 + 截断语义）
- 注入时机：仅 `context_file` 首次注入轮（noTools 轮）附加；请求参数 `context_graph_neighbors !== false` 时生效
- 与 RAG 的关系：图谱注入是结构性的（谁链接谁），RAG 是语义性的；三阶段合并去重

## 9. 性能

| 场景 | 成本 |
|---|---|
| 单文件增量 | 1-3ms（读 1 文件 + 正则提取 + 少量 DB 写） |
| 全量重建 10k 文件 | ~20-30s 后台（walkDir + 40 批/事务 + setTimeout(0) 让出，不冻结事件循环） |
| backlinks 查询 | <5ms（idx_doc_links_to） |
| related 聚合 | <50ms（内存 Set 交集） |
| 全量图接口（5000 节点/10k 边） | 实测 ~50ms（perf 回归断言 <2s） |
| orphans/broken 列表（20 万边表） | 实测 ~30ms 合计（断言 <200ms） |

## 10. 后续阶段

- **二阶段（已落地，feature/graph-viz）**：力导向可视化（`/graph` 页，Canvas + vendor 懒加载 d3-force）、全局图谱页（多项目，查询层 `IN` 合并零表结构改动）、孤立页/断链洞察 UI（orphans/broken 列表端点，与 stats 同谓词）
- **三阶段**：MCP 只读工具 graph_backlinks/graph_related、RAG 语义融合（RelatedScorer 注入点）、AI 建链（生成 wikilink 走既有保存挂点自动索引）、AI 对话展示图谱邻居建议链接（context 注入已有服务端基础，只缺前端展示）

## 11. 已知限制

- watcher 忽略隐藏文件 → `.doc77links` 别名变更不触发增量（手动 POST index 或全量重建自愈）
- 死链自愈仅在**全量重建**时发生（增量路径保留 broken 状态）
- 图谱是最终一致：无 SSE 客户端期间 watcher 不运行，变更靠启动/手动全量重建收敛

# 知识图谱设计（v1.2.0，链接基础设施 MVP）

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
GET  /api/graph/:id                     — 节点+边（?path= 子图，limit≤2000）
GET  /api/graph/:id/backlinks?path=     — 入链（含 title，limit≤200）
GET  /api/graph/:id/related?path=&limit=— 相关文档（co-citation + 一跳兜底，≤20）
GET  /api/graph/:id/stats               — nodes/edges/broken/orphans
POST /api/graph/:id/index               — 全量重建（立即返回 indexing）
```

安全：path 走 `validatePath`（逃逸 403）；非法 :id/项目不存在 404；查询只 join 表不触磁盘。

**related 评分**：`score(B) = |out(A)∩out(B)| + |in(A)∩in(B)|`（共享引用数 ×1000 + 入链数 tie-break）；无共享引用的一跳直接邻居 score=1 兜底（被多人引用的中心节点，其相关文档就是直接引用者）。接口 `RelatedScorer` 可替换（三阶段 RAG 语义融合注入点）。

## 7. 前端

- `renderGraphPanel(path)`：文档卡片底部独立 DOM（**不拼进 d.content** —— tabDataCache 缓存 /api/content 响应）；异步 fetch backlinks + related
- 刷新时机：保存回调（doSave）、SSE `graph:index-progress`、SSE `file-tree:changed`（仅当前激活文档受影响时）
- i18n：`web.preview.graph.*`（en-US/zh-CN）

## 8. AI 集成

- `collectGraphNeighbors(projectId, path, readContent, {maxDocs=3, maxCharsPerDoc=2000, maxTotalChars=6000})` → 注入文本
- 复用 `readProjectFileContent`（敏感文件拦截 + 路径沙箱 + 截断语义）
- 注入时机：仅 `context_file` 首次注入轮（noTools 轮）附加；请求参数 `context_graph_neighbors !== false` 时生效
- 与 RAG 的关系：图谱注入是结构性的（谁链接谁），RAG 是语义性的；三阶段合并去重

## 9. 性能

| 场景 | 成本 |
|---|---|
| 单文件增量 | 1-3ms（读 1 文件 + 正则提取 + 少量 DB 写） |
| 全量重建 10k 文件 | ~20-30s 后台（walkDir + 100 批/事务 + setTimeout(0) 让出，不冻结事件循环） |
| backlinks 查询 | <5ms（idx_doc_links_to） |
| related 聚合 | <50ms（内存 Set 交集） |

## 10. 后续阶段

- **二阶段**：力导向可视化（vendor 懒加载 d3-force 或手写 SVG/Canvas）、全局图谱页（多项目）、孤立页/断链洞察 UI（stats 已有数据）
- **三阶段**：MCP 只读工具 graph_backlinks/graph_related、RAG 语义融合（RelatedScorer 注入点）、AI 建链（生成 wikilink 走既有保存挂点自动索引）、多项目聚合图谱

## 11. 已知限制

- watcher 忽略隐藏文件 → `.doc77links` 别名变更不触发增量（手动 POST index 或全量重建自愈）
- 死链自愈仅在**全量重建**时发生（增量路径保留 broken 状态）
- 图谱是最终一致：无 SSE 客户端期间 watcher 不运行，变更靠启动/手动全量重建收敛

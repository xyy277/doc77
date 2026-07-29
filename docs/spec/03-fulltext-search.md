# 全文搜索 (FTS5) — 设计文档

> 日期: 2026-07-27 | 优先级: Q3-3 | 状态: 设计

## 一、背景与目标

Doc77 当前搜索仅支持**文件名匹配**（`searchInFiles` 遍历目录树），无法搜索文件内容。当项目包含数百个文档时，用户无法快速定位"哪篇文档提到了某个关键词"。

**目标**：
- 基于 SQLite FTS5 实现文件内容全文索引
- 支持中文分词（jieba 或 simple tokenizer）
- 搜索结果高亮匹配片段
- 增量索引（文件变更时仅更新变化部分）
- 搜索响应 < 200ms（10,000 文件规模）

**非目标**：
- 不做正则搜索（已有 `searchInFiles` 覆盖）
- 不做语义搜索（由 AI 模块覆盖）
- 不索引二进制文件（PDF/DOCX 内容提取为 Phase 2）

## 二、数据模型

### 2.1 FTS5 虚拟表

```sql
-- 文件内容索引
CREATE VIRTUAL TABLE IF NOT EXISTS file_content_fts USING fts5(
  project_id UNINDEXED,
  file_path UNINDEXED,
  title,
  content,
  tokenize='unicode61'  -- Phase 1; Phase 2 换 jieba
);

-- 索引元数据（跟踪同步状态）
CREATE TABLE IF NOT EXISTS search_index_meta (
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,         -- sha256(content) 前 16 位
  file_mtime TEXT NOT NULL,
  indexed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_search_meta_project ON search_index_meta(project_id);
```

### 2.2 索引范围

| 类型 | 是否索引 | 说明 |
|------|---------|------|
| `.md`, `.txt`, `.text` | ✅ | 全文索引 |
| `.ts`, `.js`, `.py` 等代码 | ✅ | 全文索引 |
| `.json`, `.yaml`, `.toml` | ✅ | 全文索引 |
| `.html`, `.xml` | ✅ | 去标签后索引文本 |
| `.pdf` | Phase 2 | 需 pdf-parse 提取文本 |
| `.docx` | Phase 2 | 需 mammoth 提取文本 |
| 图片/视频/二进制 | ❌ | 仅索引文件名 |
| > 5MB 文件 | ❌ | 跳过，避免性能问题 |
| `.doc77ignore` 匹配的 | ❌ | 复用现有忽略规则 |

## 三、索引引擎

### 3.1 架构

```
packages/core/src/search/
├── indexer.ts        # 索引构建与增量更新
├── tokenizer.ts      # 分词策略（unicode61 / jieba）
├── query.ts          # 搜索查询构建 + 高亮
└── worker.ts         # 后台索引 worker（避免阻塞主线程）
```

### 3.2 索引触发时机

| 触发 | 行为 |
|------|------|
| 项目注册 | 后台全量索引（进度条通知） |
| 文件保存（编辑/MCP 写入） | 增量更新单文件索引 |
| SSE file-changed 事件 | 增量更新 |
| 手动重建 | 设置页"重建索引"按钮 |
| 定时扫描 | 每 30min 检查 mtime 变化（可配置） |
| 项目删除 | 清除该项目所有索引 |

### 3.3 增量索引流程

```
onFileChanged(projectId, filePath):
  1. stat = fs.statSync(absPath)
  2. if stat.size > 5MB → skip
  3. content = fs.readFileSync(absPath, 'utf-8')
  4. hash = sha256(content).slice(0, 16)
  5. meta = SELECT * FROM search_index_meta WHERE project_id=? AND file_path=?
  6. if meta && meta.file_hash === hash → skip (unchanged)
  7. DELETE FROM file_content_fts WHERE project_id=? AND file_path=?
  8. INSERT INTO file_content_fts (project_id, file_path, title, content)
     VALUES (?, ?, extractTitle(content), content)
  9. UPSERT search_index_meta
```

### 3.4 全量索引（后台 Worker）

```
fullIndex(projectId):
  1. files = walkDir(projectRoot, { ignore: doc77ignore, maxSize: 5MB })
  2. textFiles = files.filter(isTextFile)
  3. for batch of chunk(textFiles, 100):
       - 批量读取 + 批量 INSERT（事务）
       - 每批完成后 yield（不阻塞 API 响应）
       - 更新进度：indexedCount / totalCount
  4. 清除 search_index_meta 中不存在于文件系统的记录
  5. emit SSE: { type: 'index-complete', projectId, count }
```

## 四、搜索 API

### 4.1 `GET /api/search/:projectId`

```
GET /api/search/:projectId?q=关键词&path=docs/&limit=20&offset=0

Response 200:
{
  "query": "关键词",
  "total": 42,
  "results": [
    {
      "file_path": "docs/guide.md",
      "title": "使用指南",
      "score": 12.5,
      "snippets": [
        "...这是包含 <mark>关键词</mark> 的上下文片段...",
        "...第二处 <mark>关键词</mark> 匹配..."
      ],
      "modified": "2026-07-20T10:00:00Z"
    }
  ],
  "indexStats": { "totalFiles": 1523, "indexedAt": "2026-07-27T08:00:00Z" }
}
```

### 4.2 搜索语法

| 语法 | 示例 | 说明 |
|------|------|------|
| 普通关键词 | `部署` | OR 匹配 |
| 引号精确 | `"docker compose"` | 短语匹配 |
| AND | `部署 AND docker` | 同时包含 |
| OR | `部署 OR 发布` | 任一包含 |
| NOT | `部署 NOT test` | 排除 |
| 前缀 | `deploy*` | 前缀匹配 |
| 路径限定 | `path:docs/ 架构` | 限定目录 |

### 4.3 全局搜索（跨项目）

```
GET /api/search?q=关键词&limit=20

Response: 按项目分组返回
{
  "query": "关键词",
  "groups": [
    { "project_id": 1, "project_name": "My Docs", "total": 15, "results": [...] },
    { "project_id": 3, "project_name": "Work", "total": 8, "results": [...] }
  ]
}
```

## 五、前端 UI

### 5.1 搜索入口

- **顶栏搜索框**（已有）：增强为实时搜索（300ms debounce）
- **快捷键** `Ctrl+K` / `Cmd+K`：打开全局搜索弹窗（类 Spotlight）

### 5.2 搜索结果 UI

```
┌─ 搜索弹窗 (Ctrl+K) ─────────────────────────────────────┐
│ 🔍 [输入关键词...                              ] [esc]   │
├──────────────────────────────────────────────────────────┤
│ 📁 My Docs (15 results)                                  │
│   📄 docs/guide.md — 使用指南                            │
│      ...包含 <mark>关键词</mark> 的片段...               │
│   📄 docs/api.md — API 文档                              │
│      ...另一处匹配...                                    │
│                                                          │
│ 📁 Work (8 results)                                      │
│   📄 readme.md                                           │
│      ...                                                 │
├──────────────────────────────────────────────────────────┤
│ ↑↓ 导航 │ Enter 打开 │ 1523 files indexed               │
└──────────────────────────────────────────────────────────┘
```

### 5.3 预览页内搜索

- 文件树上方搜索图标 → 展开项目内搜索面板
- 结果列表点击 → 直接打开对应文件并滚动到匹配位置

## 六、中文分词策略

### Phase 1：unicode61（零依赖）

- SQLite FTS5 内置 `unicode61` tokenizer
- 按 Unicode 分类分词，中文按单字切分
- 优点：零依赖、跨平台
- 缺点：中文搜索"数据库"会匹配到"数据"和"库"

### Phase 2：jieba 分词（可选增强）

- 使用 `nodejieba`（C++ addon）或 `@aspect-build/jieba`（WASM）
- 索引时预分词，空格连接存入 FTS5
- 配置项：`search.tokenizer = 'unicode61' | 'jieba'`
- jieba 不可用时自动降级 unicode61

## 七、性能预算

| 指标 | 目标 |
|------|------|
| 搜索响应时间（10K 文件） | < 200ms |
| 全量索引速度 | > 500 文件/秒 |
| 增量索引（单文件） | < 50ms |
| 索引存储开销 | 约为原始文件总大小的 30-50% |
| 内存占用（索引时） | < 100MB 峰值 |

## 八、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/core/src/search/indexer.ts` | 新增 | 索引引擎 |
| `packages/core/src/search/query.ts` | 新增 | 查询构建 + snippet 高亮 |
| `packages/core/src/search/tokenizer.ts` | 新增 | 分词策略抽象 |
| `packages/core/src/db/migrations.ts` | 修改 | 新增 FTS5 表 + meta 表 |
| `packages/core/src/server/app.ts` | 修改 | 注册搜索 API 路由 |
| `packages/core/src/web/js/search.js` | 新增 | 前端搜索 UI（Ctrl+K 弹窗） |
| `packages/core/src/web/css/app.css` | 修改 | 搜索弹窗样式 |
| `packages/core/__tests__/search.test.ts` | 新增 | 索引 + 搜索测试 |

## 九、验收标准

1. 注册项目 → 后台自动索引 → 进度可见
2. 搜索"部署" → 返回所有包含该词的文档 + 高亮片段
3. 编辑文件保存 → 立即反映在搜索结果中
4. 删除文件 → 搜索结果中消失
5. 10,000 文件项目搜索 < 200ms
6. Ctrl+K 弹窗 < 100ms 打开
7. 中文搜索可用（单字匹配模式）
8. 设置页可手动重建索引

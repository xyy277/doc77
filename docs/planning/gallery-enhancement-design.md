# Doc77 图片库增强 — 架构设计方案

## Context

Doc77 当前图片阅览功能仅支持单张图片查看（`<img>` tag + 简易 lightbox），没有缩略图、网格视图、视频支持或任何图片库级别组织能力。用户希望将 Doc77 作为 NAS 服务器使用，需要一个精美、高性能的图片/视频库。

本设计引入 `@doc77/gallery` package，作为 peer package 提供完整的媒体库能力。

## 技术决策汇总

| 维度 | 决策 |
|---|---|
| 媒体范围 | 图片 + 视频（分阶段） |
| Package 架构 | `@doc77/gallery` — 独立 peer package（方案 C），默认安装，可 opt-out |
| 缩略图 | 服务端 sharp 生成 WebP，双尺寸（320px grid + 1200px preview），磁盘缓存 |
| 交互入口 | 预览页内嵌画廊切换 + 独立 `gallery.html` 页面 |
| 性能 | 组合策略：API 分页 + Intersection Observer + `content-visibility: auto` + idle 预取 |
| 组织形式 | 文件夹浏览 + 时间线视图 + 相册/收藏集 + EXIF 日期分组 |
| 视频 Phase 1 | 客户端 `<video>` canvas 抓帧封面 + HTML5 player 播放 |
| 视频 Phase 2 | 可选：检测系统 ffmpeg 后自动开启转码 |
| EXIF | sharp `.metadata()` 提取 EXIF buffer + exif-reader 解析 |

---

## 一、Package 结构

### 1.1 依赖关系与安装策略

```
@doc77/gallery (新增)
  ├── dependencies: @doc77/core (workspace:^)
  ├── dependencies: sharp (npm, 缩略图引擎)
  ├── dependencies: exif-reader (npm, EXIF 解析，~20KB)
  └── 不依赖: @doc77/mcp, @doc77/ai

@doc77/cli
  dependencies:
    @doc77/core        (已有)
    @doc77/gallery     (默认安装 — 非 optional)
  peerDependencies:
    @doc77/mcp         (optional)
    @doc77/ai          (optional)
```

**安装策略**：

| 场景 | 行为 |
|---|---|
| `npm install -g doc77` | 默认安装 `@doc77/gallery`（含 sharp ~30-50MB） |
| **Electron 桌面版** | 始终包含 gallery，无需任何额外操作 |
| **精简安装（用户主动 opt-out）** | `npm install -g doc77 && npm uninstall -g @doc77/gallery` 或 `doc77 config set gallery.enabled false` |
| **sharp 编译失败** | Gallery 启动时静默降级为现有单图模式，不影响其他功能 |

CLI 启动时始终使用 `try/catch` 动态 import gallery，三态处理：

```typescript
// 1. 模块存在 + sharp ok → gallery 完全可用
// 2. 模块存在 + config gallery.enabled = false → 跳过注册，不加载
// 3. 模块不存在 / sharp 编译失败 → 静默降级，现有单图模式正常工作
```


### 1.2 目录结构

```
packages/gallery/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                    # 唯一公共入口
    ├── types.ts                    # 共享类型定义
    ├── thumbnail/
    │   ├── engine.ts               # ThumbnailEngine: sharp 缩略图生成管道
    │   ├── cache.ts                # ThumbnailCache: 磁盘缓存管理 + SQLite 记录
    │   └── video-cover.ts          # 视频封面帧生成 (Phase 1: client canvas)
    ├── exif/
    │   └── reader.ts               # EXIF 解析 (sharp metadata + exif-reader 组合)
    ├── album/
    │   ├── store.ts                # AlbumStore: 相册 CRUD (基于 core 的 getConnection)
    │   └── routes.ts               # Album REST 路由工厂
    ├── routes/
    │   ├── gallery.ts              # Gallery 列表 + 时间线路由
    │   ├── thumbnail.ts            # 缩略图服务路由
    │   └── register.ts             # registerGalleryRoutes(app, opts) 统一注册
    └── web/
        ├── gallery.html            # 独立图片库 SPA 页面
        └── js/
            ├── gallery-core.js     # 网格渲染、懒加载、选择模式（preview.html 也复用）
            ├── gallery-lightbox.js # 增强灯箱（替代现有 preview.js 中的简易版）
            └── gallery-album.js    # 相册管理 UI
```

### 1.3 构建与发布

```json
// package.json (关键字段)
{
  "name": "@doc77/gallery",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" } },
  "files": ["dist"],
  "dependencies": { "@doc77/core": "workspace:^", "sharp": "^0.33.0", "exif-reader": "^2.0.0" }
}
```

```
// tsup.config.ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['@doc77/core', 'sharp', 'exif-reader'],
});
```

---

## 二、数据模型

### 2.1 缩略图磁盘缓存

```
~/.doc77/thumbnails/
├── a1/
│   ├── a1b2c3d4..._grid.webp       # 320px 宽
│   ├── a1b2c3d4..._preview.webp    # 1200px 宽
│   └── a1b2c3d4..._video.jpg       # 视频封面
└── ...
```

- Key: `sha256(projectId + ":" + relativePath + ":" + mtime + ":" + size)` 的前 8 位 hex
- 同一文件在不同项目中指向同一路径时，各自生成缩略图（路径不同 → hash 不同）
- 缩略图大小预估：320px WebP ~15KB/张，1200px WebP ~80KB/张，1000 张照片总计约 100MB

### 2.2 SQLite 新表（Migration 在 core 的 migrations.ts 中执行）

```sql
-- 缩略图生成记录
CREATE TABLE IF NOT EXISTS thumbnail_cache (
  source_hash TEXT PRIMARY KEY,          -- sha256 hash
  source_path TEXT NOT NULL,             -- 原始文件相对路径
  source_size INTEGER NOT NULL,          -- 原始文件大小
  source_mtime TEXT NOT NULL,            -- 生成时的 mtime (ISO string)
  grid_path TEXT,                        -- grid 缩略图路径 (相对于 thumbnails dir)
  preview_path TEXT,                     -- preview 缩略图路径
  video_cover_path TEXT,                 -- 视频封面路径
  width INTEGER,                         -- 原始图片宽度
  height INTEGER,                        -- 原始图片高度
  exif_date TEXT,                        -- EXIF 拍摄日期 (ISO string, 可为 NULL)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_thumbnail_source_path ON thumbnail_cache(source_path);

-- 相册
CREATE TABLE IF NOT EXISTS gallery_albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  cover_source_hash TEXT,                -- 封面缩略图 hash
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 相册-文件关联
CREATE TABLE IF NOT EXISTS gallery_album_items (
  album_id INTEGER REFERENCES gallery_albums(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (album_id, project_id, file_path)
);
```

---

## 三、API 设计

### 3.1 端点列表

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/gallery/:projectId` | 分页媒体列表 |
| GET | `/api/gallery/timeline/:projectId` | 时间线聚合数据 |
| GET | `/api/thumbnails/:projectId` | 缩略图二进制 |
| GET | `/api/exif/:projectId` | 单文件 EXIF JSON |
| GET/POST | `/api/albums` | 列出/创建相册 |
| PUT/DELETE | `/api/albums/:albumId` | 更新/删除相册 |
| POST | `/api/albums/:albumId/items` | 添加文件到相册 |
| DELETE | `/api/albums/:albumId/items` | 从相册移除文件 |

### 3.2 关键端点详细

**`GET /api/gallery/:projectId?path=&sort=name|date|size&order=asc|desc&offset=0&limit=100&types=image,video`**

```json
{
  "entries": [
    {
      "name": "DSC_0001.JPG",
      "path": "Photos/2024/DSC_0001.JPG",
      "type": "image",
      "extension": ".jpg",
      "size": 5242880,
      "modified": "2024-03-15T10:30:00Z",
      "thumbnail_url": "/api/thumbnails/1?path=...&size=grid",
      "preview_url": "/api/thumbnails/1?path=...&size=preview",
      "raw_url": "/api/raw/1?path=...",
      "width": 6000,
      "height": 4000,
      "exif_date": "2024-03-15T10:30:00Z",
      "duration": null
    }
  ],
  "total": 452,
  "offset": 0,
  "limit": 100
}
```

实现：扫描目录 → 过滤媒体类型（根据 EXTENSION_MAP 中 image 类 + 视频扩展名）→ 对每个文件检查/生成缩略图缓存记录 → 排序 → 切片返回。首次浏览需要生成缩略图所以较慢，后续从 thumbnail_cache 表直接返回 URL。

**`GET /api/gallery/timeline/:projectId?path=`**

```json
{
  "groups": [
    { "label": "2024-03", "count": 45, "start_date": "2024-03-01", "end_date": "2024-03-31",
      "cover": { "thumbnail_url": "...", "preview_url": "..." } },
    { "label": "2024-02", "count": 32, ... }
  ]
}
```

实现：遍历 thumbnail_cache 中该 project 下所有有 exif_date 的条目 + 无 exif_date 的用 mtime fallback → 按月聚合 → 每月的第一张作为封面。

**`GET /api/thumbnails/:projectId?path=&size=grid|preview`**

- 检查 thumbnail_cache 中有无有效缓存（mtime 匹配）
- 有缓存 → `res.sendFile(cachedPath)`, `Cache-Control: public, max-age=604800`
- 无缓存 → sharp 生成 → 写缓存记录 → 返回
- 视频封面：若 source_hash 无 video_cover_path → 返回占位 SVG 或默认视频图标

**`GET /api/exif/:projectId?path=`**

```json
{
  "date": "2024-03-15T10:30:00Z",
  "camera": "Sony ILCE-7M4",
  "lens": "FE 24-70mm F2.8 GM II",
  "focal_length": "35mm",
  "aperture": "f/2.8",
  "shutter_speed": "1/250",
  "iso": 400,
  "gps": { "latitude": 31.2304, "longitude": 121.4737 },
  "dimensions": { "width": 6000, "height": 4000 },
  "file_size": 5242880
}
```

---

## 四、前端架构

### 4.1 gallery.html（独立图片库页面）

```
┌────────────────────────────────────────────────────────┐
│  Header: 项目选择器 │ 🔍 搜索 │ 视图切换 │ ⚙ 排序     │
├──────────────┬─────────────────────────────────────────┤
│              │                                         │
│  📁 文件夹   │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  │
│    Photos/   │  │ thumb│ │ thumb│ │ ▶vid │ │ thumb│  │
│    📅 2024-03│  │ name  │ │ name  │ │ name  │ │ name  │  │
│    📅 2024-02│  └──────┘ └──────┘ └──────┘ └──────┘  │
│  📅 时间线   │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┘  │
│  📁 相册1    │  │      │ │      │ │      │             │
│  📁 相册2    │  └──────┘ └──────┘ └──────┘             │
│              │                                         │
└──────────────┴─────────────────────────────────────────┘
```

- 侧边栏 3 个 tab 切换：文件夹树 / 时间线 / 相册列表
- CSS Grid: `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))`
- 每张卡片：缩略图（`object-fit: cover`）+ 文件名（溢出省略）+ 类型徽标
- 视频卡片：封面 + ▶ 播放图标 overlay + 时长 badge（若有）
- 点击 → lightbox（gallery-lightbox.js）
- Shift/Ctrl 多选 → 批量操作（加入相册、下载）
- 拖拽文件/文件夹到页面 → 上传（复用现有 temp-preview 机制）
- 响应式：手机端 `minmax(120px, 1fr)`，单列侧边栏折叠为底栏

### 4.2 preview.html 内嵌画廊

在现有文件树上方增加视图切换按钮：
```
[📋 列表] [📷 画廊]
```

切换到画廊时：
- 左侧文件树区域替换为 grid 组件
- 导航到某个目录 → grid 展示该目录下所有图片/视频
- 点击图片 → 复用 gallery-lightbox.js
- grid 组件从 gallery-core.js 引入（`gallery-core.js` 通过 `<script>` 标签在 preview.html 中加载，由 gallery webDir 提供）

### 4.3 前端文件依赖（纯原生 JS，零构建）

```
gallery.html:
  → /gallery/js/gallery-core.js     (网格、懒加载)
  → /gallery/js/gallery-lightbox.js (增强灯箱)
  → /gallery/js/gallery-album.js    (相册管理)
  → 公共依赖: app.css (主题变量)

preview.html:
  → /gallery/js/gallery-core.js     (复用网格组件)
  → /gallery/js/gallery-lightbox.js (复用灯箱，替代现有的 openImageLightbox)
  → 不再需要 preview.js 中的简易 lightbox 代码 (lines 2217-2296)
```

静态资源通过 Express 提供：
```typescript
// register.ts
app.use('/gallery', express.static(galleryWebDir));
```

### 4.4 enhanced lightbox 功能（gallery-lightbox.js）

在现有 lightbox 基础上增强：
- 现有功能保留：缩放（25%-500%）、箭头导航、键盘操作、sibling 切换
- **新增**：滑动/拖动切换（touch + mouse drag）、双指缩放（pinch zoom）
- **新增**：信息面板（按 `I` 切换，显示 EXIF + 直方图占位）
- **新增**：全屏模式（按 `F`，Fullscreen API）
- **新增**：下载按钮、分享按钮

---

## 五、缩略图生成管线

### 5.1 流程图

```
GET /api/thumbnails/:projectId?path=...&size=grid

  1. validatePath(projectPath, filePath) → absolutePath
  2. statSync(absolutePath) → { size, mtime }
  3. source_hash = sha256(projectId:relativePath:mtime:size).slice(0,16)  // hex
  4. SELECT * FROM thumbnail_cache WHERE source_hash = ?
     → HIT & mtime matches  → res.sendFile(cachedPath), Cache-Control: max-age=604800
     → MISS or STALE:
  5. sharp(absolutePath)
       .metadata()  → { width, height, format, exif }
       .resize(320, null, { fit: 'inside', withoutEnlargement: true })
       .webp({ quality: 80 })
       .toFile(cachePath)
  6. INSERT INTO thumbnail_cache (source_hash, source_path, source_size, source_mtime,
       grid_path, preview_path, width, height, exif_date)
  7. res.sendFile(cachePath)
```

### 5.2 性能策略

| 层级 | 策略 | 详情 |
|---|---|---|
| 存储 | sharp WebP 双尺寸 | 网格 320px (~15KB), 预览 1200px (~80KB), quality 80 |
| 传输 | API 分页 | offset/limit, 默认 100/页; Cache-Control: 7 天 |
| 渲染 | content-visibility: auto | 离屏网格项不渲染 layout |
| 可见性 | Intersection Observer | 仅加载进入视口的缩略图 |
| 预取 | requestIdleCallback | 空闲时预加载当前视口 ±2 行的缩略图 URL |
| 内存 | 懒卸载 | 离屏超过 3 视口高度的 DOM 节点移除，保留占位 |
| 防抖 | 快速滚动不发请求 | 300ms debounce，滚动停止后再加载可见区域 |

---

## 六、视频支持（分阶段）

### 6.1 Phase 1：封面缩略图 + HTML5 播放

- 视频文件在 gallery API 中类型标记为 `"video"`
- 视频封面：前端首次渲染视频卡片时，创建隐藏 `<video>` 元素，`currentTime = 1`，`canvas` 截图 → 上传为封面缓存（`POST /api/thumbnails/:projectId/video-cover`）
- 视频卡片上显示 ▶ overlay + 时长（若有 metadata）
- 点击 → lightbox 中嵌 `<video controls>` 替换 `<img>`
- 浏览器原生支持的格式（MP4/H.264, WebM/VP9）直接播放
- 不支持的格式（MKV, AVI）→ 显示提示「格式不支持，建议用外部播放器打开」

### 6.2 Phase 2（未来）：可选 ffmpeg 转码

- `registerGalleryRoutes()` 时检测 `ffmpeg` 命令是否可用
- 若可用 → 自动注册转码端点 `POST /api/gallery/transcode/:projectId`
- 按需将不兼容格式转为 MP4/H.264（720p, 2Mbps）
- 转码结果缓存到 `~/.doc77/transcode/`
- ffmpeg 不可用 → 不影响基础功能

---

## 七、集成点（CLI doc77.ts 改动）

Gallery 作为默认依赖，但启动时始终 try/catch 保护，确保降级安全：

```typescript
// 1. 模块检测
let galleryAvailable = false;
async function detectModules() {
  // ... existing ...
  try {
    const enabled = getConfig('gallery.enabled');
    if (enabled !== 'false') {
      await import('@doc77/gallery');
      galleryAvailable = true;
    }
  } catch { /* Gallery not installed, sharp missing, or platform incompatible */ }
}

// 2. 路由注册
if (galleryAvailable) {
  const { registerGalleryRoutes } = await import('@doc77/gallery');
  registerGalleryRoutes(app, {
    thumbnailsDir: path.join(os.homedir(), '.doc77', 'thumbnails'),
  });
}

// 3. 能力注入
setCapabilities({ ai: aiAvailable, mcp: mcpAvailable, translate: translateAvailable, gallery: galleryAvailable });
```

### CLI 配置

```json
// packages/cli/package.json
"dependencies": {
  "@doc77/core": "workspace:^",
  "@doc77/gallery": "workspace:^"
},
"peerDependencies": {
  "@doc77/ai": "workspace:^",
  "@doc77/mcp": "workspace:^"
}
```

- `@doc77/gallery` 从 peerDependencies/optional 移到 dependencies（默认安装）
- `@doc77/ai` 和 `@doc77/mcp` 保持 optional peer（需手动安装）
- Electron 包同样添加 `@doc77/gallery` 到 dependencies

---

## 八、入口与导航

用户从 Dashboard 到 Gallery 有三条路径：

### 路径 1：Dashboard 项目卡片入口（主力）

```
Dashboard (index.html)
  ┌──────────────────────┐
  │ 📂 My Photos         │
  │ /home/photos          │
  │ 450 files · 12.3 GB  │
  │ [📷 Gallery] [📂 Open]│  ← 新增按钮
  └──────────────────────┘
```

- 每个项目卡片上增加 `📷 Gallery` 按钮，点击跳转 `gallery.html?project=<id>`
- 实现：`dashboard.js` 渲染项目卡片时，检测 gallery 能力（`GET /api/capabilities` → `gallery: true`），有则显示按钮

### 路径 2：Dashboard 顶栏全局入口

- Dashboard 导航栏新增 Gallery 链接（在现有 Home / Settings 旁边）
- 若 gallery 可用 → 显示；不可用 → 隐藏
- 若用户未选择项目 → 进入 gallery 选择页（列出所有项目，选一个进入）
- 若已有项目上下文（如从 URL `?project=<id>` 进入）→ 直接进入该项目画廊

### 路径 3：Preview 页内嵌切换

- Preview 页左侧文件树上方增加 `[📋 列表] [📷 画廊]` 切换按钮
- 切换到画廊模式 → 当前目录内容以网格展示（复用 gallery-core.js）
- 目录树仍可见（不可折叠），方便快速切换目录

---

## 九、向后兼容

- Gallery 未安装 → 现有图片功能完全不受影响（`<img>` tag + 简易 lightbox）
- 数据库 migration 新增的表不影响现有表结构
- 现有 `/api/raw/:id` 端点不变，gallery 是增强而非替代
- 现有 preview.js lightbox 代码保留，直到 gallery-lightbox.js 验证可用后再移除

---

## 十、验证

1. **单元测试**：thumbnail engine (sharp pipeline)、cache 逻辑、EXIF reader、album store CRUD
2. **集成测试**：API 端点（gallery list 分页、timeline 聚合、thumbnail 生成/缓存命中）
3. **前端验证**：
   - `gallery.html` 独立页面：网格渲染、3 种侧边栏视图切换、lightbox 操作、多选
   - `preview.html` 内嵌：列表↔画廊切换、从网格打开灯箱
4. **性能验证**：1000 张图片目录，首次加载 + 缓存命中加载时间
5. **降级验证**：卸载 `@doc77/gallery`，确认现有图片功能正常工作

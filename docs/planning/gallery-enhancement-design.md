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

## 四、前端 UI 设计

> **权威 UI 参考文件**：`docs/design/gallery_ui.html`
>
> 实现时必须参考该文件中的完整 HTML/CSS/JS 代码，包括所有 Tailwind class、CSS 自定义属性、动画曲线、间距、阴影、颜色、交互状态。以下文档是对该 UI 设计稿的结构化描述，但**具体样式以设计稿源码为准**。

### 4.0 Design Tokens

> **参考**：`docs/design/gallery_ui.html` lines 16-42（tailwind.config 扩展色板）、lines 48-119（CSS 自定义属性与动画）

| Token | Value | Usage |
|---|---|---|
| Font | Inter (300/400/500/600/700), Google Fonts | 全局排版 |
| Icons | Phosphor Icons (`@phosphor-icons/web`) | 所有图标，替代现有 emoji |
| BG Primary | `#0f172a` (doc77-900) | 页面背景 |
| BG Secondary | `#0b1121` | 主内容区背景（略深于 sidebar） |
| BG Card | `doc77-800` | 卡片底色 |
| Border | `doc77-800` | 分割线、卡片边框 |
| Text Primary | `#f8fafc` | 标题、文件名 |
| Text Secondary | `doc77-300` | 导航项 |
| Text Muted | `doc77-400/500` | 元数据、辅助文本 |
| Accent | `#3b82f6` (blue-500) | 主操作按钮、选中态 |
| Shadow Soft | `0 4px 20px -2px rgba(0,0,0,0.05)` | 卡片默认 |
| Shadow Glow | `0 0 15px rgba(59,130,246,0.5)` | Primary 按钮 |
| Shadow Card Hover | `0 10px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.3)` | 卡片 hover |
| Transition Card | `transform 0.3s cubic-bezier(0.4,0,0.2,1), box-shadow 0.3s ease` | 卡片交互 |
| Transition Lightbox | `opacity 0.3s` | 灯箱开闭 |
| Transition Panel | `transform 0.3s` | 信息面板滑入 |

### 4.1 页面布局 (gallery.html)

> **参考**：`docs/design/gallery_ui.html` 完整 DOM 结构 (lines 122-357)

```
┌─ Header (h-14) ───────────────────────────────────────────────────────┐
│ [← Doc77] › My Photos › Gallery  │  🔍 Search... [esc] │ [Grid][List] │
│                                   │                      [≡][↑][☑]   │
├─ Sidebar (w-60) ──┬─ Main Content (flex-1, bg=#0b1121) ──────────────┤
│                    │                                                   │
│  NAV:              │  ┌─ Sticky Group Header ──────────────────────┐  │
│  🖼 Photos (active) │  │ March 2024          12 items          [⋯]  │  │
│  🕐 Timeline       │  ├────────────────────────────────────────────┤  │
│  🎬 Videos         │  │  Masonry Grid (responsive columns)         │  │
│  ⭐ Favorites      │  │  ┌────┐ ┌────┐ ┌──────┐ ┌────┐            │  │
│                    │  │  │    │ │    │ │      │ │    │            │  │
│  FOLDERS:          │  │  │    │ │    │ │      │ │    │            │  │
│  📁 Camera Roll    │  │  └────┘ └────┘ └──────┘ └────┘            │  │
│  📁 Screenshots    │  │  ┌──────┐ ┌────┐ ┌────┐ ┌──────┐          │  │
│  📁 Downloads      │  │  │ ▶vid │ │    │ │    │ │      │          │  │
│                    │  │  └──────┘ └────┘ └────┘ └──────┘          │  │
│  ALBUMS:           │  │  ...                                       │  │
│  🏔 Japan Trip  142│  ├────────────────────────────────────────────┤  │
│  🐱 Pets        58 │  │ February 2024         8 items        [⋯]  │  │
│  🖥 Wallpapers  24 │  │  ┌────┐ ┌──────┐ ┌────┐ ┌────┐            │  │
│                    │  │  │    │ │      │ │    │ │    │            │  │
│  ───────────────── │  │  └────┘ └──────┘ └────┘ └────┘            │  │
│  Storage:          │  │                                             │  │
│  ████░░░░ 25%      │  │  ⏳ Loading more memories...               │  │
│  12.3/50 GB        │  │                                             │  │
└────────────────────┴─┴───────────────────────────────────────────────┘
```

### 4.2 Header / App Bar

```
┌──────────────────────────────────────────────────────────────────────┐
│ [← Doc77]  ›  📁 My Photos  ›  Gallery                              │
│                                                                      │
│              ┌──────────────────────────────┐  ┌─────┬─────┐ ┌────┐ │
│              │ 🔍 Search photos, dates...   │  │ ▦ ▤ │  ≡  │ │ ☑  │ │
│              │                       [esc]  │  │Grid │Sort │ │Sel │ │
│              └──────────────────────────────┘  └─────┴─────┘ └────┘ │
│                                                ↑View   ↑Filter      │
│                                                Toggle               │
└──────────────────────────────────────────────────────────────────────┘
```

- **左侧**：返回按钮 + Doc77 Logo + 面包屑导航（项目名 › Gallery）
- **中间**：搜索框（`rounded-full`, 带键盘快捷键 hint `esc`，focus 时显示）
- **右侧**：
  - 视图切换：Grid / List 两个 icon button，选中态 `bg-doc77-700`，未选中 `text-doc77-400`
  - 分割线
  - Sort & Filter 按钮（有 active filter 时显示蓝色小圆点 badge）
  - Upload 按钮
  - Select 按钮（`bg-blue-600`, 带 glow shadow，进入选择模式后变为 Cancel）

### 4.3 侧边栏 (w-60, hidden on mobile)

**结构**（自上而下，可滚动，`no-scrollbar`）：

1. **Main Navigation**
   - Photos（默认 active：`bg-blue-500/10 text-blue-400`，右侧显示 "All" badge）
   - Timeline
   - Videos
   - Favorites（hover 时图标变黄 `group-hover:text-yellow-400`）

2. **Folders Section**
   - Header：「FOLDERS」（`text-xs uppercase tracking-wider`），可折叠（点击旋转 caret icon）
   - 列表项：文件夹图标（`ph-fill ph-folder text-yellow-500/80`）+ 名称
   - 左侧有竖线装饰（`border-l border-doc77-800`）

3. **Albums Section**
   - Header：「ALBUMS」+ ➕ 新建按钮
   - 列表项：彩色渐变封面方块（`w-6 h-6 rounded bg-gradient-to-br`）+ 名称 + 数量 badge
   - 示例配色：Japan Trip → purple→pink，Pets → green→emerald，Wallpapers → blue→indigo

4. **Storage Info Bar**（固定在底部，`border-t`）
   - 进度条：`h-1.5 rounded-full`，蓝色填充
   - 文本：`12.3 GB / 50 GB`

### 4.4 主内容区 — Masonry 网格

> **参考**：`docs/design/gallery_ui.html` lines 77-118（CSS，columns/masonry 实现）、lines 315-355（HTML 分组结构）、lines 536-602（JS createMediaCard 函数）

**分组标题**（sticky 吸顶）：
```
┌──────────────────────────────────────────────────────────────────┐
│ March 2024                  12 items                       [⋯]  │
│ (text-lg font-bold, 底部 border, backdrop-blur 半透明背景)       │
└──────────────────────────────────────────────────────────────────┘
```

**Masonry Layout**（CSS Columns 实现）：

```css
.masonry-grid       { columns: 2; column-gap: 1rem; }
@media (min-width: 640px)  { columns: 3; }
@media (min-width: 1024px) { columns: 4; }
@media (min-width: 1280px) { columns: 5; }
@media (min-width: 1536px) { columns: 6; }

.masonry-item       { break-inside: avoid; margin-bottom: 1rem; }
```

**卡片组件**（`.masonry-item.gallery-item`）：

```
┌──────────────────────────┐
│ ⊙                    🎬  │  ← 左上：选择 checkbox（hover 显示）
│                      0:45│  ← 右上：视频时长 badge（仅视频）
│                          │
│                          │  ← 图片：object-cover，hover 时 scale(1.05)
│                          │
│                          │
│  ┌──────────────────────┐│  ← 底部渐变 overlay（hover 显示）
│  │ IMG_8472.jpg         ││  ← 文件名（白色，text-xs，drop-shadow）
│  └──────────────────────┘│
└──────────────────────────┘
```

**卡片状态**：

| 状态 | 视觉变化 |
|---|---|
| 默认 | `rounded-lg border border-doc77-700/50 bg-doc77-800` |
| Hover | `translateY(-4px)` + 加强阴影 + 底部 overlay 淡入 + 图片 `scale(1.05)` + checkbox 显示 |
| 选中（select mode） | 蓝色半透明 overlay + `border-2 border-blue-500` + checkbox 常显蓝底白勾 |
| 视频卡片 | 右上角黑色半透明 badge：▶ play icon + 时长 |

### 4.5 选择模式 (Select Mode)

> **参考**：`docs/design/gallery_ui.html` lines 106-118（CSS 选中态）、lines 297-312（Selection Toolbar HTML）、lines 631-694（JS toggleSelectMode/updateSelectionUI）

**触发**：点击 Header 中 Select 按钮，或点击卡片上的 checkbox

**Selection Toolbar**（从顶部滑入，覆盖在内容区上方）：

```
┌─ Selection Toolbar (bg-blue-600, z-10) ──────────────────────────┐
│ [✕]  3 Selected  │  Select All  │  [+ Album] [↓] [Share] │ [🗑] │
│       (font-semibold text-lg)   │                             │
└──────────────────────────────────────────────────────────────────┘
```

- 动画：`transform -translate-y-full → translate-y-0`（`duration-300`）
- 批量操作：Add to Album / Download / Share / Delete（红色 hover）
- 点击 ✕ 或 Cancel 退出选择模式，清除所有选中
- **Select All**：选中当前范围内的所有媒体项

**选中态卡片**：
```css
.gallery-item.selected .img-wrapper::after {
  content: '';
  position: absolute; inset: 0;
  background: rgba(59, 130, 246, 0.2);     /* 蓝色半透明 */
  border: 2px solid #3b82f6;               /* 蓝色边框 */
  border-radius: 0.5rem;
}
```

### 4.6 Lightbox（灯箱）

> **参考**：`docs/design/gallery_ui.html` lines 360-486（完整 Lightbox HTML 结构）、lines 697-775（JS openLightbox/closeLightbox/navLightbox/toggleInfoPanel/keydown handler）

**整体**：`fixed inset-0 z-50 bg-black/95`，开闭时 `opacity 0→1` 过渡（300ms）

```
┌─ Lightbox Toolbar (顶部渐变黑→透明, absolute) ────────────────────┐
│ [←] IMG_8472.jpg          │ [☆] [🔍+] [↓] [ℹ]                   │
│     Mar 15, 2024 • 14:30  │  Favorite Zoom Download Info         │
├────────────────────────────┴──────────────────────────────────────┤
│                          ┌─────────┐                              │
│              [◀]         │  IMAGE  │         [▶]                 │
│            (left)        │         │        (right)              │
│                          └─────────┘                              │
│                    导航箭头 (hidden on mobile)                    │
├──────────────────────────────────────────────────────────────────┤
│  ← Info Panel (右侧滑入, w-80, bg-doc77-900) ──────────────────→ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ ℹ Details                                            [✕]   │ │
│  │─────────────────────────────────────────────────────────────│ │
│  │ FILE INFO                                                  │ │
│  │ ┌─────────────────────────────────────────────────────────┐ │ │
│  │ │ Name       DSC_0842.JPG                                 │ │ │
│  │ │ Date       Mar 15, 2024                                 │ │ │
│  │ │ Size       4.2 MB                                       │ │ │
│  │ │ Resolution 6000 x 4000                                  │ │ │
│  │ └─────────────────────────────────────────────────────────┘ │ │
│  │                                                             │ │
│  │ CAMERA EXIF                                                │ │
│  │ ┌─────────────────────────────────────────────────────────┐ │ │
│  │ │ 📷 Sony ILCE-7M4                                       │ │ │
│  │ │    FE 24-70mm F2.8 GM II                                │ │ │
│  │ │─────────────────────────────────────────────────────────│ │ │
│  │ │  ISO 400  │  Aperture f/2.8  │  Shutter 1/250s  │ 35mm │ │ │
│  │ └─────────────────────────────────────────────────────────┘ │ │
│  │                                                             │ │
│  │ LOCATION                                                   │ │
│  │ ┌─────────────────────────────────────────────────────────┐ │ │
│  │ │              📍 No GPS data                             │ │ │
│  │ │         (dot-grid placeholder background)               │ │ │
│  │ └─────────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**键盘快捷键**：

| 键 | 操作 |
|---|---|
| `Escape` | 关闭灯箱 |
| `←` / `→` | 前后导航（循环） |
| `I` | 切换 Info Panel |

**导航动画**：切换图片时，旧图 `opacity: 0.5, scale(0.98) + translateX(±20px)` → 150ms 后新图淡入归位。

### 4.7 preview.html 内嵌画廊

预览页视图切换沿用 gallery.html 的设计语言：

```
文件树上方:
  ┌──────────────────────┐
  │  [📋 List] [📷 Grid] │  ← 与 gallery.html Header 中一致的 toggle
  └──────────────────────┘

切换到 Grid 时：
  - 左侧区域变为 masonry grid（复用 gallery-core.js 的 createMediaCard 函数）
  - 当前目录的图片/视频按 date 分组（若当前目录无子目录，不分组直接网格）
  - 点击图片 → 打开同一 lightbox（复用 gallery-lightbox.js）
  - 选择模式也可用（无 Selection Toolbar，用 preview 自身 toolbar）
```

### 4.8 响应式行为

| 断点 | 行为 |
|---|---|
| `< md` (768px) | 侧边栏隐藏，底部 tab bar 替代；header 简化 |
| `md–lg` (768-1024px) | 侧边栏显示但可折叠；masonry 3-4 列 |
| `lg–xl` (1024-1280px) | 完整布局；masonry 4-5 列 |
| `> 2xl` (1536px+) | masonry 6 列，充分利用超宽屏 |

### 4.9 前端文件清单

```
gallery.html 依赖:
  → tailwindcss CDN (已沿用现有 preview.html 的 CDN 模式)
  → Phosphor Icons CDN (unpkg/@phosphor-icons/web)
  → Google Fonts: Inter
  → /gallery/js/gallery-core.js     (masonry 网格、卡片组件、懒加载、选择模式)
  → /gallery/js/gallery-lightbox.js (增强灯箱、EXIF 信息面板、键盘导航)
  → /gallery/js/gallery-album.js    (相册管理 UI)

preview.html 复用:
  → /gallery/js/gallery-core.js     (createMediaCard 函数)
  → /gallery/js/gallery-lightbox.js (替代现有 openImageLightbox)
```

### 4.10 与现有设计系统的关系

- **Phosphor Icons 替代 emoji**：gallery.html 使用 Phosphor Icons（矢量、统一风格），与现有 preview.html 的 emoji 图标体系并存。后续可逐步迁移。
- **Tailwind 沿用**：gallery.html 使用 Tailwind CDN（与 preview.html 一致），自定义 `doc77-*` 色板扩展。
- **Dark-only**：gallery.html 为深色主题专属设计，符合图片库"沉浸式浏览"的产品意图。Dashboard 和 Preview 页保持双主题不变。
- **app.css 共享**：公共变量（主题色、间距）从 app.css 引入，gallery 特有样式内联或 gallery.css。

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

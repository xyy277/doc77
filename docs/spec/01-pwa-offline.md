# PWA 化 + 离线缓存 — 设计文档

> 日期: 2026-07-27 | 优先级: Q3-1 | 状态: 设计

## 一、背景与目标

Doc77 当前移动端仅为"局域网 Web 伴侣"（mDNS + QR 连接），用户每次需扫码或输入 IP 访问，且断网后完全不可用。

**目标**：将 Doc77 Web 端升级为 PWA（Progressive Web App），实现：
- 手机/平板"添加到主屏幕"，获得类原生 App 体验
- Service Worker 离线缓存，已浏览文档断网可读
- Web Push 通知（审批提醒、同步状态）
- 无需安装任何 App，浏览器即入口

**非目标**：
- 不做原生 App（见 Spec 11 评估）
- 不做离线编辑（离线仅只读缓存）
- 不做后台同步（同步由服务端驱动）

## 二、技术方案

### 2.1 Web App Manifest

新增 `/manifest.json` 静态端点：

```json
{
  "name": "Doc77",
  "short_name": "Doc77",
  "description": "本地文档预览器",
  "start_url": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#0f172a",
  "theme_color": "#1e293b",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Dashboard", "url": "/", "icons": [{ "src": "/icons/icon-192.png", "sizes": "192x192" }] },
    { "name": "最近浏览", "url": "/?view=recent" }
  ]
}
```

### 2.2 Service Worker 策略

文件：`packages/core/src/web/sw.js`

| 资源类型 | 缓存策略 | 说明 |
|---------|---------|------|
| App Shell（HTML/CSS/JS） | Cache First + 后台更新 | 首屏秒开 |
| Vendor 资产（marked/mermaid/highlight） | Cache First（长期） | 已有 vendor 机制 |
| API 文档内容 | Stale While Revalidate | 离线可读上次缓存 |
| 缩略图 | Cache First + LRU（200 条上限） | 图片占空间 |
| 分享页 `/s/:token` | Network First | 时效性内容 |

**缓存配额管理**：
- 文档内容缓存上限：50MB（IndexedDB 存储）
- 缩略图缓存上限：100 条（超出 LRU 淘汰）
- 用户可在设置中清除离线缓存

### 2.3 离线阅读流程

```
用户在线时浏览文档
  → SW 拦截 /api/content/:id 响应
  → 存入 IndexedDB（key: projectId:path, value: {html, raw, mtime, cachedAt}）
  → 同时缓存关联资源（图片 base64 / 缩略图）

用户离线时打开 PWA
  → 请求 /api/content/:id
  → SW 检测 network 失败
  → 从 IndexedDB 读取缓存
  → 返回缓存 HTML + 顶部 banner "📴 离线模式 — 显示缓存版本 (2h 前)"
```

### 2.4 Web Push 通知（可选，Phase 2）

- 审批队列有新任务 → 推送通知到手机
- 同步完成/冲突 → 推送提醒
- 实现：VAPID key + `push` event + Notification API
- 前提：需用户授权通知权限

## 三、前端改动

### 3.1 注册 Service Worker

在 `index.html`、`preview.html`、`gallery.html` 的 `<head>` 中：

```html
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#1e293b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
```

```javascript
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
```

### 3.2 安装提示

- 监听 `beforeinstallprompt` 事件
- Dashboard 顶部显示"📱 安装 Doc77 到主屏幕"引导条（可关闭）
- iOS Safari 无法自动提示，显示图文引导

### 3.3 离线状态 UI

- `navigator.onLine` + SW `message` 事件检测在线状态
- 离线时：顶栏显示橙色 banner `📴 离线模式`
- 离线时：禁用写操作按钮（编辑、删除、同步），显示 tooltip "离线不可用"

## 四、服务端改动

### 4.1 新增端点

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/manifest.json` | 动态生成 manifest（注入当前 host/port） |
| GET | `/sw.js` | Service Worker 文件（`Service-Worker-Allowed: /`） |
| GET | `/icons/*` | PWA 图标集（192/512/maskable） |
| GET | `/api/offline/manifest` | 返回已缓存文档清单（用于同步缓存状态） |

### 4.2 缓存控制 Headers

```
App Shell:     Cache-Control: no-cache（SW 管理版本）
Vendor:        Cache-Control: public, max-age=31536000, immutable
API Content:   Cache-Control: private, max-age=300
Thumbnails:    Cache-Control: public, max-age=604800
```

## 五、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/core/src/web/sw.js` | 新增 | Service Worker 主逻辑 |
| `packages/core/src/web/manifest.json` | 新增 | PWA manifest 模板 |
| `packages/core/src/web/icons/` | 新增 | 图标集（从现有 logo 生成） |
| `packages/core/src/server/app.ts` | 修改 | 注册 manifest/sw/icons 路由 + 缓存 headers |
| `packages/core/src/web/index.html` | 修改 | 添加 manifest link + SW 注册 |
| `packages/core/src/web/preview.html` | 修改 | 同上 |
| `packages/core/src/gallery/src/web/gallery.html` | 修改 | 同上 |
| `packages/core/src/web/js/common.js` | 修改 | 离线检测 + 安装提示逻辑 |
| `packages/core/src/web/css/app.css` | 修改 | 离线 banner 样式 |

## 六、验收标准

1. Chrome/Edge 地址栏出现"安装"图标，点击可安装到桌面/主屏幕
2. iOS Safari "添加到主屏幕"后以 standalone 模式打开（无地址栏）
3. 在线浏览 3 篇文档 → 关闭网络 → 刷新 → 仍可查看缓存内容
4. 离线时顶部显示橙色"离线模式" banner
5. 离线时编辑/删除按钮灰显不可点击
6. 恢复网络后自动切换回在线模式，banner 消失
7. Lighthouse PWA 审计 ≥ 90 分
8. 首屏加载（在线）不因 SW 注册变慢（< 100ms 额外开销）

## 七、隐私与安全

- SW 仅缓存当前用户有权限访问的内容
- 缓存数据存于浏览器 IndexedDB，清除浏览器数据即删除
- 不缓存敏感文件（复用 `isSensitiveFile` 过滤）
- manifest.json 不包含任何用户数据

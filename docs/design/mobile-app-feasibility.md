# Doc77 移动端 App 可行性分析

## 文档版本：v1.0
## 日期：2026-07-09
## 状态：技术预研阶段，尚未进入开发

---

## 一、结论摘要

**推荐方案：原生壳 + WebView 内核（混合方案）**

- 预览引擎的核心资产（Markdown、Mermaid、代码高亮）直接复用，PDF/HTML 使用浏览器原生渲染，零重写
- 原生层只做 WebView 做不到的事：本地文件系统访问、系统文件选择器、分享
- 与 Web 响应式 UI 改造共享同一套前端代码
- 双端（iOS + Android）成本可控

---

## 二、方案概述

```
┌──────────────────────────────────────────┐
│              原生 App 壳                  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │        WebView (全屏渲染)          │  │
│  │                                    │  │
│  │   ┌────────────────────────────┐   │  │
│  │   │   Doc77 移动端前端 UI       │   │  │
│  │   │   • Markdown 渲染 (marked)  │   │  │
│  │   │   • Mermaid 图表 (mermaid)  │   │  │
│  │   │   • PDF 预览 (原生)         │   │  │
│  │   │   • 代码高亮 (highlight.js) │   │  │
│  │   │   • 图片查看                │   │  │
│  │   └────────────────────────────┘   │  │
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  原生 Bridge 层 (Capacitor API)    │  │
│  │  • 文件系统访问 (Filesystem API)   │  │
│  │  • 文件选择器 (File Picker)        │  │
│  │  • 系统分享 (Share API)            │  │
│  │  • 本地存储 (Preferences API)      │  │
│  │  • 状态栏 / Safe Area 适配         │  │
│  └────────────────────────────────────┘  │
│                                          │
└──────────────────────────────────────────┘
```

### 核心原则

1. **预览逻辑完全复用** — marked、Mermaid.js、浏览器原生 PDF、highlight.js 在 WebView 中运行，与 Web 版共享同一套前端代码
2. **原生层极薄** — 只做 WebView 无法做的事（文件系统、系统 UI），不重复实现渲染
3. **离线优先** — 静态资源打包进 App，无网络也能浏览已注册的本地文档
4. **纯预览定位** — 不做 MCP 服务端、不做 AI 对话、不做写入操作

---

## 三、技术选型对比

### 3.1 WebView 容器方案

| 方案 | 双端支持 | 文件系统访问 | 包体积 | 社区成熟度 | 推荐 |
|---|---|---|---|---|---|
| **Capacitor** | ✅ iOS + Android | 内置 Filesystem API | ~3-5MB | ⭐⭐⭐⭐⭐ | ✅ 推荐 |
| Tauri Mobile | ✅ (v2 实验性) | Rust 桥接 | ~2-3MB | ⭐⭐ | 待观察 |
| 手工 WKWebView + Android WebView | 各自实现 | 需手写 Bridge | 最小 | N/A | 灵活但工作量大 |

### 3.2 推荐：Capacitor

**理由：**
- Ionic 团队维护，社区活跃，与 Cordova 同源但更现代
- 内置 Filesystem、Preferences、Share、FilePicker 等插件，开箱即用
- 单一 JS Bridge API，iOS 和 Android 原生层自动适配
- 支持将 Web 静态资源打包进 App（离线可用）
- 与现有前端技术栈（HTML + CSS + JS）无缝衔接
- TypeScript 类型支持良好

**不推荐的方案：**
- **React Native / Flutter** — 需要重写整套渲染引擎，Mermaid 无成熟替代
- **PWA** — iOS 对 File System Access API 支持不完整，无法浏览任意本地目录

---

## 四、能力矩阵（纯预览 App）

| 能力 | Web 版 | App 版 | 实现方式 |
|---|---|---|---|
| 注册本地目录 | ✅ | ✅ | Capacitor FilePicker + Filesystem API |
| 目录树浏览 | ✅ | ✅ | WebView 内渲染，原生提供文件列表 |
| Markdown 渲染 | ✅ | ✅ | 复用 marked，WebView 内渲染 |
| Mermaid 图表 | ✅ | ✅ | 复用 Mermaid.js，WebView 内渲染 |
| PDF 预览 | ✅ | ✅ | 复用 浏览器原生 PDF，WebView 内渲染 |
| 代码高亮 | ✅ | ✅ | 复用 highlight.js |
| 图片预览 | ✅ | ✅ | WebView 原生支持 |
| 外部编辑器跳转 | ✅ | ❌ | 移动端无等价协议，降级为系统分享 |
| 文档搜索 | ✅ | ✅ | WebView 内实现 |
| MCP 服务 | ✅ | ❌ | App 不做服务端 |
| AI 对话 | ✅ | ❌ | App 不做 AI 模块 |
| 写入操作 | ✅ | ❌ | App 纯预览，只读 |

---

## 五、工程结构建议

移动 App 作为**独立 Git 仓库**管理，与 doc77 monorepo 平行：

```
doc77/                          # 现有 monorepo（不变）
├── packages/core/              # 预览引擎 + Web 前端
├── packages/mcp/               # MCP 服务层
├── packages/ai/                # AI 模块
└── packages/cli/               # CLI

doc77-app/                      # 新建独立仓库
├── android/                    # Android 原生项目（Capacitor 生成）
├── ios/                        # iOS 原生项目（Capacitor 生成）
├── www/                        # 前端资源（从 doc77 移动端 UI 构建产出）
├── capacitor.config.ts         # Capacitor 配置
├── package.json
└── README.md
```

**前端代码共享策略：**

```
packages/core/src/web/
├── desktop/                    # 桌面端 UI（当前已有）
│   ├── index.html
│   ├── preview.html
│   └── js/
└── mobile/                     # 移动端 UI（后续开发）
    ├── index.html
    ├── preview.html
    └── js/
```

- 移动端 UI 同时服务于 Web 响应式访问（A 线）和 App 内置 WebView（B 线）
- 一套移动端前端代码，两个部署目标
- 共享渲染核心逻辑（marked、Mermaid 等），仅 UI 布局不同

---

## 六、技术风险与成本估算

### 6.1 风险点

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| Mermaid.js 在移动 WebView 性能 | 中 | 大型图表（>50 节点）可能卡顿，需限制渲染规模或使用静态 SVG fallback |
| PDF 大文件内存 | 中 | 移动端内存有限，>50MB PDF 需分页懒加载，超出阈值提示用户 |
| 文件系统权限（Android 11+ scoped storage） | 低 | Capacitor Filesystem 已适配，但需处理权限请求流程 |
| iOS WKWebView 限制 | 低 | 无法使用 IndexedDB 超过 50MB，需用 Capacitor Preferences 替代 |
| 包体积 | 低 | 静态资源压缩后预计 < 15MB（不含 PDF worker） |

### 6.2 开发成本估算

| 阶段 | 内容 | 预估 |
|---|---|---|
| 环境搭建 | Capacitor 项目初始化，iOS/Android 工程配置 | 1-2 天 |
| 原生壳开发 | 文件选择器、文件系统访问、权限管理、Safe Area | 3-5 天 |
| 前端适配 | 移动端 UI 开发（与 Web 响应式共享） | 另计，见 Web 端 UI 改造计划 |
| 集成联调 | WebView Bridge 通信、离线资源加载、性能调优 | 3-5 天 |
| 测试 | 双端真机测试、边界场景 | 3-5 天 |
| 发布 | App Store + Google Play 上架 | 2-3 天 |

**原生壳总成本：约 10-20 人天**（不含移动端 UI 设计开发）

---

## 七、待决策项

以下问题留待正式启动 App 开发时讨论：

1. **最低系统版本** — iOS 15+? Android 10+?
2. **是否需要 App Store 上架** — 还是仅内部分发（Android APK 直接安装 + iOS TestFlight）？
3. **文档数据存储** — App 内的项目注册信息如何持久化？是否需要 SQLite（Capacitor 社区有 sqlite 插件）？
4. **App 内是否允许注册任意本地目录** — iOS 文件系统沙箱限制，用户可选范围受限
5. **主题与品牌** — App 的视觉风格是否与桌面端统一？

---

## 八、参考资料

- [Capacitor Documentation](https://capacitorjs.com/docs)
- [Capacitor Filesystem API](https://capacitorjs.com/docs/apis/filesystem)
- [Capacitor File Picker](https://capacitorjs.com/docs/apis/file-picker)
- [WKWebView Limitations](https://webkit.org/blog/)

---

> **本文档为预研结论，不做实施计划。App 开发启动时，新建 doc77-app 仓库后再深入设计。**

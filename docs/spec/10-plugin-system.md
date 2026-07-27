# 插件系统雏形 — 设计文档

> 日期: 2026-07-27 | 优先级: Q1-2027-2 | 状态: 设计

## 一、背景与目标

Doc77 功能日趋丰富（预览/编辑/Gallery/AI/同步），但所有功能都内建于代码中。用户有不同需求组合：
- 有人只需预览 + 同步，不需要 AI
- 有人想支持特殊格式（如 .ipynb、.drawio）
- 社区可能贡献新渲染器、新同步适配器、新主题

**目标**：设计轻量插件系统，允许：
- 第三方扩展预览格式（自定义渲染器）
- 第三方同步适配器（如 Dropbox、OneDrive）
- 自定义主题
- MCP 工具扩展
- 未来：插件市场

**设计约束**：
- 轻量优先 — 不引入重型插件框架
- 安全沙箱 — 插件不能访问任意文件系统
- 向后兼容 — 现有功能不受影响
- 可选加载 — 不用的插件零开销

## 二、插件类型

| 类型 | 能力 | 示例 |
|------|------|------|
| **renderer** | 注册新文件格式的预览渲染器 | Jupyter Notebook、Draw.io、PlantUML 增强 |
| **adapter** | 注册新同步适配器 | Dropbox、OneDrive、Google Drive |
| **theme** | 自定义 UI 主题 | 暗色/亮色/高对比/自定义配色 |
| **tool** | 注册新 MCP 工具 | 自定义文件操作、外部 API 集成 |
| **widget** | Dashboard/预览页自定义组件 | 天气、时钟、统计图表 |

## 三、插件规范

### 3.1 目录结构

```
~/.doc77/plugins/
├── my-renderer/
│   ├── plugin.json        # 插件清单
│   ├── index.js           # 入口（ESM）
│   ├── renderer.js        # 渲染逻辑
│   └── style.css          # 可选样式
├── dropbox-sync/
│   ├── plugin.json
│   ├── index.js
│   └── adapter.js
└── solarized-theme/
    ├── plugin.json
    └── theme.css
```

### 3.2 plugin.json 清单

```json
{
  "name": "jupyter-renderer",
  "version": "1.0.0",
  "displayName": "Jupyter Notebook 预览",
  "description": "在 Doc77 中预览 .ipynb 文件",
  "author": "community",
  "type": "renderer",
  "entry": "index.js",
  "doc77": {
    "minVersion": "1.1.0",
    "permissions": ["read-files"]
  },
  "renderer": {
    "extensions": [".ipynb"],
    "mimeTypes": ["application/x-ipynb+json"],
    "priority": 10
  }
}
```

### 3.3 插件接口

```typescript
// 渲染器插件
interface RendererPlugin {
  /** 判断是否可渲染 */
  canRender(filePath: string, mimeType: string): boolean;

  /** 渲染为 HTML */
  render(content: string | Buffer, options: RenderOptions): Promise<RenderResult>;

  /** 可选：客户端 JS（浏览器端执行） */
  clientScript?(): string;

  /** 可选：客户端 CSS */
  clientStyle?(): string;
}

interface RenderResult {
  html: string;
  scripts?: string[];    // 需要加载的 JS
  styles?: string[];     // 需要加载的 CSS
  toc?: TocEntry[];      // 大纲
}

// 同步适配器插件
interface AdapterPlugin {
  readonly name: string;
  readonly displayName: string;
  readonly configSchema: JSONSchema;  // 配置表单 schema

  testConnection(config: any): Promise<ConnectionResult>;
  pull(ctx: SyncContext): Promise<PullResult>;
  push(ctx: SyncContext): Promise<PushResult>;
  listRemote(config: any): Promise<RemoteFileEntry[]>;
}

// 主题插件
interface ThemePlugin {
  readonly name: string;
  readonly displayName: string;
  css: string;                    // 主题 CSS 变量覆盖
  preview?: string;               // 预览缩略图 URL
  darkMode: boolean;              // 是否为暗色主题
}
```

## 四、插件加载器

### 4.1 发现与加载

```typescript
// packages/core/src/plugin/loader.ts
class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();

  async discover(): Promise<void> {
    const pluginDir = path.join(homedir, '.doc77', 'plugins');
    if (!await exists(pluginDir)) return;

    const dirs = await readdir(pluginDir);
    for (const dir of dirs) {
      const manifestPath = path.join(pluginDir, dir, 'plugin.json');
      if (!await exists(manifestPath)) continue;

      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
      // 版本兼容性检查
      if (!semver.satisfies(VERSION, `>=${manifest.doc77.minVersion}`)) {
        log.warn(`Plugin ${manifest.name} requires doc77 >= ${manifest.doc77.minVersion}`);
        continue;
      }
      this.plugins.set(manifest.name, { manifest, dir, loaded: false });
    }
  }

  async loadPlugin(name: string): Promise<any> {
    const plugin = this.plugins.get(name);
    if (!plugin || plugin.loaded) return plugin?.instance;

    // 动态 import（ESM）
    const entryPath = path.join(plugin.dir, plugin.manifest.entry);
    const module = await import(pathToFileURL(entryPath).href);
    plugin.instance = module.default || module;
    plugin.loaded = true;
    return plugin.instance;
  }

  getRenderers(): RendererPlugin[] { /* ... */ }
  getAdapters(): AdapterPlugin[] { /* ... */ }
  getThemes(): ThemePlugin[] { /* ... */ }
}
```

### 4.2 权限系统

```typescript
type PluginPermission =
  | 'read-files'       // 读取项目文件
  | 'write-files'      // 写入文件（需审批）
  | 'network'          // 网络请求（同步适配器）
  | 'ai'              // 调用 AI 模块
  | 'clipboard'       // 剪贴板访问
  | 'notifications';   // 发送通知

// 插件声明所需权限，用户安装时确认
// 运行时通过 Proxy 沙箱限制未授权 API
```

### 4.3 安全沙箱

```
Phase 1（MVP）: 信任模型
  - 插件在 Node.js 主进程运行
  - 仅通过 permissions 声明做软限制
  - 适合社区早期、插件数量少

Phase 2: Worker 隔离
  - 插件在 Worker Thread 中运行
  - 通过 MessagePort 与主进程通信
  - 主进程代理所有 I/O（文件/网络）
  - 插件无法直接 require('fs')

Phase 3: WASM 沙箱（远期）
  - 插件编译为 WASM
  - 完全隔离，仅暴露 WASI 接口
```

## 五、插件管理 UI

### 5.1 设置页 — 插件面板

```
┌─ 插件管理 ─────────────────────────────────────────────┐
│                                                         │
│  已安装 (3)                                             │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 📓 Jupyter Notebook 预览  v1.0.0   [✓ 启用]    │   │
│  │    预览 .ipynb 文件                             │   │
│  │    权限: 读取文件                               │   │
│  │                          [配置] [禁用] [卸载]   │   │
│  ├─────────────────────────────────────────────────┤   │
│  │ 🔄 Dropbox Sync  v0.2.1          [✓ 启用]      │   │
│  │    同步到 Dropbox                               │   │
│  │    权限: 读取文件, 网络                         │   │
│  │                          [配置] [禁用] [卸载]   │   │
│  ├─────────────────────────────────────────────────┤   │
│  │ 🎨 Solarized Dark  v1.0.0        [✓ 启用]      │   │
│  │    护眼暗色主题                                 │   │
│  │                          [预览] [禁用] [卸载]   │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  [从目录安装]  [浏览插件市场 (Coming Soon)]             │
└─────────────────────────────────────────────────────────┘
```

### 5.2 安装方式

| 方式 | 说明 |
|------|------|
| 手动目录 | 将插件文件夹放入 `~/.doc77/plugins/` |
| CLI | `doc77 plugin install ./my-plugin/` |
| URL（Phase 2） | `doc77 plugin install https://github.com/user/plugin` |
| 市场（Phase 3） | Web UI 浏览 + 一键安装 |

## 六、CLI 命令

```bash
doc77 plugin list              # 列出已安装插件
doc77 plugin install <path>    # 安装插件
doc77 plugin uninstall <name>  # 卸载插件
doc77 plugin enable <name>     # 启用
doc77 plugin disable <name>    # 禁用
doc77 plugin info <name>       # 查看详情
```

## 七、内置功能迁移路径

现有功能**不立即迁移**为插件，但架构上预留接口：

| 现有功能 | 未来插件化 | 时间 |
|---------|-----------|------|
| Gallery | `@doc77/gallery` 已是独立包 → 可视为"内置插件" | 已完成 |
| 翻译 | 可迁移为 renderer 插件 | 远期 |
| 同步适配器 | 第三方可通过 adapter 插件扩展 | 本 spec |
| 主题 | 内置 dark/light + 社区主题插件 | 本 spec |

## 八、API

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/plugins` | 已安装插件列表 |
| POST | `/api/plugins/install` | 安装插件（上传 zip 或指定路径） |
| DELETE | `/api/plugins/:name` | 卸载插件 |
| PUT | `/api/plugins/:name/toggle` | 启用/禁用 |
| GET | `/api/plugins/:name/config-schema` | 获取配置 schema |
| PUT | `/api/plugins/:name/config` | 更新插件配置 |

## 九、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/core/src/plugin/loader.ts` | 新增 | 插件发现与加载 |
| `packages/core/src/plugin/types.ts` | 新增 | 插件接口定义 |
| `packages/core/src/plugin/sandbox.ts` | 新增 | 权限沙箱 |
| `packages/core/src/plugin/registry.ts` | 新增 | 渲染器/适配器注册表 |
| `packages/core/src/server/app.ts` | 修改 | 插件 API + 渲染器分发集成 |
| `packages/core/src/web/js/plugins.js` | 新增 | 插件管理 UI |
| `packages/cli/src/bin/doc77.ts` | 修改 | plugin 命令 |
| `packages/core/__tests__/plugin.test.ts` | 新增 | 插件加载测试 |

## 十、验收标准

1. 创建示例渲染器插件（.csv 表格预览）→ 安装 → .csv 文件以表格渲染
2. 创建示例主题插件 → 安装 → 设置页可切换主题
3. 禁用插件 → 对应格式回退到默认渲染（代码高亮）
4. 插件权限：未声明 network 的插件无法发起网络请求
5. 插件崩溃不影响主进程（try/catch 隔离）
6. CLI `doc77 plugin list` 正确显示
7. 无插件时零性能开销（空目录扫描 < 1ms）

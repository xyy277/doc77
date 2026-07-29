# Electron 原生体验增强 — 设计文档

> 日期: 2026-07-27 | 优先级: Q4-4 | 状态: 设计

## 一、背景与目标

Doc77 Electron 桌面版（v1.0.8）当前仅为"浏览器壳"——内嵌 Web 页面 + 基本窗口管理。缺乏桌面应用应有的原生体验。

**目标**：将 Electron 版从"套壳浏览器"提升为"原生桌面应用"体验：
- 系统托盘常驻 + 快捷操作
- 全局快捷键唤起
- 文件关联（双击 .md 用 Doc77 打开）
- 右键菜单集成（Windows Explorer / macOS Finder）
- 原生通知（审批提醒、同步完成）
- 窗口状态记忆
- 自动更新优化

## 二、系统托盘

### 2.1 托盘图标与菜单

```
托盘图标: Doc77 Logo (16x16 / 32x32)
  - 正常: 彩色 logo
  - 同步中: logo + 旋转箭头 overlay
  - 有冲突: logo + 红色角标

右键菜单:
┌─────────────────────────────┐
│ Doc77 v1.0.9               │
│ ─────────────────────────── │
│ 📂 打开 Dashboard           │
│ 📄 最近文件          ▶     │  ← 子菜单: 最近 5 个文件
│ ─────────────────────────── │
│ 🔄 同步状态: 已同步 5min前  │
│ ⚡ 快速同步                 │
│ ─────────────────────────── │
│ 👁 显示/隐藏窗口            │
│ ⚙ 设置                     │
│ ─────────────────────────── │
│ 退出 Doc77                  │
└─────────────────────────────┘
```

### 2.2 托盘行为

| 操作 | 行为 |
|------|------|
| 单击托盘 | 显示/隐藏主窗口 |
| 双击托盘 | 打开 Dashboard |
| 关闭窗口（X） | 最小化到托盘（可配置为真正退出） |
| 退出托盘 | 完全退出（stop server + kill process） |

### 2.3 实现

```typescript
// packages/electron/src/tray.ts
import { Tray, Menu, nativeImage } from 'electron';

export function createTray(mainWindow: BrowserWindow): Tray {
  const icon = nativeImage.createFromPath(getIconPath());
  const tray = new Tray(icon.resize({ width: 16, height: 16 }));

  tray.setToolTip('Doc77');
  tray.on('click', () => mainWindow.show());
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.loadURL(`${serverUrl}/`);
  });

  updateTrayMenu(tray, mainWindow);
  return tray;
}
```

## 三、全局快捷键

| 快捷键 | 操作 | 可配置 |
|--------|------|--------|
| `Ctrl+Shift+D` / `Cmd+Shift+D` | 唤起/隐藏 Doc77 窗口 | ✅ |
| `Ctrl+Shift+F` / `Cmd+Shift+F` | 全局搜索弹窗 | ✅ |
| `Ctrl+Shift+S` / `Cmd+Shift+S` | 快速同步 | ✅ |

```typescript
// packages/electron/src/shortcuts.ts
import { globalShortcut } from 'electron';

export function registerShortcuts(mainWindow: BrowserWindow) {
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  globalShortcut.register('CommandOrControl+Shift+F', () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('trigger-search');
  });
}
```

## 四、文件关联

### 4.1 支持格式

```json
// electron-builder 配置 (package.json build 段)
{
  "fileAssociations": [
    { "ext": "md", "name": "Markdown Document", "role": "Viewer" },
    { "ext": "mdx", "name": "MDX Document", "role": "Viewer" },
    { "ext": "txt", "name": "Text File", "role": "Viewer" },
    { "ext": "pdf", "name": "PDF Document", "role": "Viewer" }
  ]
}
```

### 4.2 打开文件流程

```
用户双击 readme.md
  → OS 启动 Doc77（或激活已运行实例）
  → Electron 收到 open-file 事件（macOS）/ 命令行参数（Windows）
  → 解析文件路径
  → 查找文件所属已注册项目
    → 找到 → 直接打开预览: /preview?id=X&path=docs/readme.md
    → 未找到 → 提示"是否注册该目录为项目？"
```

### 4.3 单实例锁

```typescript
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Windows: 从 commandLine 解析文件路径
    const filePath = commandLine.find(arg => arg.endsWith('.md'));
    if (filePath) openFileInPreview(filePath);
    mainWindow.show();
    mainWindow.focus();
  });
}

// macOS
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openFileInPreview(filePath);
});
```

## 五、原生通知

### 5.1 通知场景

| 场景 | 标题 | 内容 | 操作 |
|------|------|------|------|
| 审批请求 | Doc77 审批 | "AI 请求修改 3 个文件" | 点击 → 打开审批页 |
| 同步完成 | Doc77 同步 | "已同步 5 个文件 (2.1s)" | 点击 → 打开同步面板 |
| 同步冲突 | Doc77 冲突 | "2 个文件有冲突需解决" | 点击 → 打开冲突解决 |
| 分享到期 | Doc77 分享 | "分享链接即将过期 (1h)" | 点击 → 续期/查看 |

### 5.2 实现

```typescript
import { Notification } from 'electron';

function notify(title: string, body: string, onClick?: () => void) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: getIconPath() });
  if (onClick) n.on('click', onClick);
  n.show();
}
```

## 六、窗口状态记忆

```typescript
// 保存窗口位置/大小
interface WindowState {
  x: number; y: number;
  width: number; height: number;
  maximized: boolean;
}

// 存储到 ~/.doc77/window-state.json
// 启动时恢复上次状态
// 多显示器：检测保存的坐标是否仍在可见屏幕内
```

## 七、右键菜单集成（Windows）

### 7.1 注册表（Windows）

```
HKEY_CLASSES_ROOT\*\shell\Doc77\
  (Default) = "用 Doc77 预览"
  icon = "C:\Program Files\Doc77\doc77.exe,0"
  command = "C:\Program Files\Doc77\doc77.exe" "%1"

HKEY_CLASSES_ROOT\Directory\shell\Doc77\
  (Default) = "用 Doc77 打开此文件夹"
  command = "C:\Program Files\Doc77\doc77.exe" --open-dir "%1"
```

### 7.2 macOS Finder Extension（可选，Phase 2）

- 通过 Electron 的 `app.setAsDefaultProtocolClient` 注册
- 或提供 Finder Sync Extension（需额外 Xcode 项目）

## 八、自动更新优化

### 8.1 当前状态

已有 `electron-updater` 基本集成。增强：

| 项 | 改进 |
|----|------|
| 更新检查 | 启动时 + 每 4h 静默检查 |
| 下载 | 后台下载，不阻塞使用 |
| 安装 | 下载完成后提示"重启更新"（非强制） |
| 回滚 | 更新失败自动回退到上一版本 |
| 通知 | 托盘气泡"Doc77 v1.1.0 已就绪，重启更新" |
| 设置 | 可关闭自动更新 / 仅通知不下载 |

### 8.2 更新 UI

```
┌─ 更新就绪 ─────────────────────────────────┐
│                                             │
│  Doc77 v1.1.0 已下载完成                    │
│                                             │
│  新功能:                                    │
│  • 全文搜索                                 │
│  • Git 同步                                 │
│  • PWA 离线支持                             │
│                                             │
│  [稍后提醒]  [重启更新]                     │
└─────────────────────────────────────────────┘
```

## 九、启动优化

| 优化 | 说明 |
|------|------|
| 开机自启（可选） | `app.setLoginItemSettings({ openAtLogin: true })` |
| 启动到托盘 | 开机启动时不显示窗口，仅托盘图标 |
| 预热 | 窗口隐藏时预启动 server，点击托盘秒开 |
| Splash Screen | 启动时显示轻量 splash（避免白屏） |

## 十、文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `packages/electron/src/tray.ts` | 新增 | 系统托盘 |
| `packages/electron/src/shortcuts.ts` | 新增 | 全局快捷键 |
| `packages/electron/src/file-assoc.ts` | 新增 | 文件关联处理 |
| `packages/electron/src/notifications.ts` | 新增 | 原生通知 |
| `packages/electron/src/window-state.ts` | 新增 | 窗口状态记忆 |
| `packages/electron/src/updater.ts` | 修改 | 更新流程优化 |
| `packages/electron/src/main.ts` | 修改 | 集成以上模块 |
| `packages/electron/package.json` | 修改 | electron-builder 文件关联配置 |

## 十一、验收标准

1. 托盘图标显示 → 右键菜单完整 → 单击显示/隐藏
2. 关闭窗口 → 最小化到托盘（非退出）
3. Ctrl+Shift+D → 全局唤起/隐藏
4. 双击 .md 文件 → Doc77 打开并预览该文件
5. 审批请求 → 系统通知弹出 → 点击跳转审批页
6. 重启后窗口位置/大小恢复
7. 更新下载完成 → 通知 → 点击重启更新
8. 开机自启 → 仅托盘图标，不弹窗

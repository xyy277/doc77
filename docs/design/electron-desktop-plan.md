# Doc77 Electron 桌面版 — 详细实施方案

> 创建: 2026-07-10 | 状态: 待启动

## 战略: 双版本

| 版本 | 用户 | 安装方式 |
|---|---|---|
| **idoc77** (CLI) | 技术用户 | `npm i -g idoc77` |
| **Doc77 Desktop** (Electron) | 非技术用户 | 双击安装包 |

---

## 一、包结构

```
packages/electron/
├── package.json
├── tsconfig.json
├── electron-builder.yml        # 打包: .exe/.dmg/.AppImage
├── assets/
│   ├── icon.png                # 应用图标 (用 favicon.svg 转换 512x512)
│   └── tray.png                # 托盘图标 (favicon 16x16)
├── src/
│   ├── main.ts                 # Electron 主进程入口
│   ├── preload.ts              # contextBridge: window.doc77.*
│   ├── server.ts               # 启动/管理 Express server 子进程
│   └── tray.ts                 # 系统托盘逻辑
└── dist/                       # 构建产物
```

---

## 二、main.ts 启动流程

### 完整启动序列

```
1. app.whenReady()
2.   解析 CLI 入口路径:
     ├─ 开发: require.resolve('@doc77/cli/dist/bin/doc77.js')
     └─ 生产: path.join(process.resourcesPath, 'cli', 'dist', 'bin', 'doc77.js')
       (electron-builder extraResources 解出 CLI 文件)
3.   findAvailablePort(3099) → 循环找可用端口
4.   spawn(process.execPath, [cliEntry, 'start', '--port', String(port)], {
       env: { ...process.env, DOC77_ELECTRON: '1' },
       stdio: 'pipe'
     })
5.   监听 stdout 直到 'Dashboard:' → 创建 BrowserWindow
6.   初始化系统托盘
7.   监听 app 'before-quit' → child.kill()
```

### 端口探测

```typescript
function findAvailablePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    for (let port = start; port < start + 100; port++) {
      const server = net.createServer();
      server.listen(port, '127.0.0.1');
      server.on('listening', () => { server.close(); resolve(port); });
      server.on('error', () => { /* occupied, try next */ });
    }
    reject(new Error('No available port in range'));
  });
}
```

### CLI 路径（dev + production 兼容）

```typescript
function getCliEntryPath(): string {
  try {
    return require.resolve('@doc77/cli/dist/bin/doc77.js'); // dev
  } catch {
    return path.join(process.resourcesPath, 'cli', 'dist', 'bin', 'doc77.js'); // prod
  }
}
```

### 子进程管理

```typescript
child.stdout.on('data', (chunk) => {
  if (chunk.includes('Dashboard:')) resolve(); // 服务就绪
});
child.on('exit', (code) => {
  if (code !== 0 && !shuttingDown) {
    dialog.showErrorBox('服务异常', `Doc77 服务意外退出 (code ${code})`);
  }
});
```

---

## 三、preload.ts — 桥接层

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('doc77', {
  openNativeDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  getPort: () => ipcRenderer.invoke('getPort'),
  platform: process.platform,
});
```

**main.ts 注册 IPC handler：**
```typescript
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: '选择项目目录',
  });
  return result.canceled ? null : result.filePaths[0];
  // 返回: "D:\\agent\\ai-agent-code\\scout_dynamic_v3" ✅ 真实绝对路径
});
```

---

## 四、Web UI 自适应

### dashboard.js `openDirDialog()` 最终版

```javascript
async function openDirDialog(forEditId) {
  var btn = event.target;
  var origHTML = btn.innerHTML;
  btn.innerHTML = '⏳';
  btn.disabled = true;
  _dirPickTarget = forEditId;

  // Strategy 1: Electron 原生对话框（返回真实路径，秒开）
  if (window.doc77?.openNativeDialog) {
    try {
      var path = await window.doc77.openNativeDialog();
      if (path) { fillPath(forEditId, path); btn.innerHTML = origHTML; btn.disabled = false; return; }
    } catch(e) {}
  }

  // Strategy 2: 服务端文件浏览器（Web 版本，始终可用）
  showServerFileBrowser(forEditId);
  btn.innerHTML = origHTML;
  btn.disabled = false;
}
```

> 彻底移除 `showDirectoryPicker` + 指纹匹配。`/api/find-folder` 端点保留备用，但前端不再调用。

---

## 五、系统托盘

```typescript
// 菜单项:
//   📁 打开 Doc77 — 显示/聚焦 BrowserWindow
//   ⏸  暂停服务 — 停止 server
//   ➖ 分隔线
//   ❌ 退出 Doc77 — 杀 server，退出应用
//
// 左键点击托盘图标 → 切换显示/隐藏窗口
// 右键 → 弹出菜单
```

---

## 六、Electron 专属功能

| 功能 | 实现 |
|---|---|
| 原生文件夹选择 | `dialog.showOpenDialog()` |
| 开机自启 | `app.setLoginItemSettings({ openAtLogin: true })` |
| 通知 | `new Notification({ title, body })` |
| 最小化到托盘 | 窗口关闭 → `event.preventDefault(); win.hide()` |
| 单实例锁 | `app.requestSingleInstanceLock()` |
| AI/MCP 安装 | 设置页一键安装 → `/api/electron/install` → 内嵌 npm |
| 端口冲突处理 | `findAvailablePort()` 自动探测 + 错误对话框 |

### AI/MCP 安装流程

桌面版默认不捆绑 AI/MCP。设置页点击"安装 AI 模块" → `/api/electron/install` → 主进程用内嵌 npm 执行安装。

```typescript
app.post('/api/electron/install', async (req, res) => {
  const { module } = req.body;
  const npmCli = path.join(process.resourcesPath, 'app.asar.unpacked',
    'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    execSync(`node "${npmCli}" install @doc77/${module}@latest`,
      { cwd: app.getPath('userData') });
    res.json({ ok: true, message: `@doc77/${module} 安装完成，重启生效` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

### 设置页 UI

```javascript
if (!window.__doc77_caps_ai) {
  c.innerHTML = '<div class="text-center py-8 text-slate-500 text-sm">' +
    'AI 模块未安装<br>' +
    (window.doc77 ?
      '<button onclick="installModule(\'ai\')" class="mt-3 ...">📦 一键安装 AI 模块</button>'
      : '<code class="text-xs mt-2 inline-block">doc77 i ai</code>') +
    '</div>';
  return;
}
```

---

## 七、打包分发

```json
// packages/electron/package.json — 核心依赖
"dependencies": {
  "@doc77/cli": "^0.4.5",
  "npm": "^10.0.0"   // 内嵌 npm，供 AI/MCP 安装
}
```

```yaml
# electron-builder.yml
appId: com.doc77.desktop
productName: Doc77
directories:
  output: release

asarUnpack:
  - "node_modules/@doc77/cli/**"
  - "node_modules/@doc77/core/**"
  - "node_modules/npm/**"

extraResources:
  - from: "node_modules/@doc77/cli/dist"
    to: "cli/dist"

files:
  - "dist/**/*"
  - "node_modules/**/*"
  - "!node_modules/.cache"

win:
  target: nsis
  icon: assets/icon.png
mac:
  target: dmg
  category: public.app-category.productivity
linux:
  target: AppImage
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

---

## 八、Web UI 改动清单

### dashboard.js
1. `openDirDialog()` 重写 — 优先 Electron 对话框
2. 保留 `showServerFileBrowser()` 不变
3. 删除 `showMatchPicker()`
4. 保留 `isLocalMode()`

### common.js
5. AI tab 根据 `window.doc77` 判断安装方式

### 保留（不删）
- `POST /api/find-folder`
- `POST /api/dialog/open-directory`

---

## 九、发布渠道

| 渠道 | 内容 | 用户 |
|---|---|---|
| GitHub Releases | .exe / .dmg / .AppImage | GUI 用户 |
| idoc77 | `npm i -g idoc77`（不变） | 技术用户 |

---

## 十、实施顺序

1. 创建 `packages/electron/` 骨架 + main/preload/server/tray
2. Web UI 增加 Electron 检测 + 原生对话框 + 安装按钮
3. `npm run electron:dev` 本地验证
4. electron-builder 打包测试（Windows .exe 优先）
5. GitHub Release 发布

---

## 十一、不做什么

- ❌ 不内嵌编辑功能
- ❌ 不改 core/mcp/ai 包
- ❌ 不引入 React/Vue
- ❌ 第一版不做 auto-update

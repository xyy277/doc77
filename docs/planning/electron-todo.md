# Doc77 Electron 桌面版 — 实施 TODO

> 创建: 2026-07-10 | 状态: 待启动

## Phase 0: 前置准备

- [ ] P0.1 从 favicon.svg 生成 icon.png + tray.png: `npx svgexport favicon.svg icon.png 512:512`
- [ ] P0.2 初始化 `packages/electron/` 骨架: package.json + tsconfig.main.json + tsconfig.preload.json

## Phase 1: Electron 核心

- [ ] P1.1 `src/main.ts` — 启动流程: 端口探测 → spawn server → BrowserWindow
- [ ] P1.2 `src/server.ts` — getCliEntryPath (dev+prod) + spawn + stdout 监听
- [ ] P1.3 `src/preload.ts` — contextBridge 暴露 openNativeDialog + platform
- [ ] P1.4 `src/tray.ts` — 系统托盘 + 菜单 + 窗口切换
- [ ] P1.5 IPC handler: `dialog:openDirectory` → 返回真实绝对路径
- [ ] P1.6 单实例锁 + 开机自启 + 窗口关闭最小化到托盘

## Phase 2: Web UI 自适应

- [ ] P2.1 dashboard.js: 重写 `openDirDialog()`，优先 Electron 对话框
- [ ] P2.2 dashboard.js: 删除 `showMatchPicker()`、移除 `showDirectoryPicker` 调用链
- [ ] P2.3 common.js: AI tab 未安装时根据 `window.doc77` 显示按钮或 CLI 提示
- [ ] P2.4 所有 HTML: 检测 `window.doc77` 环境标识
- [ ] P2.5 /api/electron/install 端点（curl+tar 安装 AI/MCP，无条件注册在 Electron 环境）

## Phase 3: 打包 & 分发

- [ ] P3.1 electron-builder.yml 配置（asarUnpack + extraResources）
- [ ] P3.2 Windows .exe 打包 → 本地安装测试
- [ ] P3.3 macOS .dmg 打包（可选）
- [ ] P3.4 Linux .AppImage 打包（可选）
- [ ] P3.5 GitHub Release 发布脚本 + CI 自动构建

## Phase 4: 打磨（后续）

- [ ] P4.1 electron-updater 自动更新（需要代码签名证书）
- [ ] P4.2 通知功能（审批任务到达时弹系统通知）
- [ ] P4.3 Windows 安装向导美化（NSIS 定制页面）
- [ ] P4.4 性能优化：server 启动白屏时间 < 2s

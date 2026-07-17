# @doc77/electron

Doc77 Desktop — 本地文档预览器 Electron 桌面版。

## Download

| 平台 | 下载 |
|---|---|
| Windows | [📦 Doc77-Setup.exe](https://github.com/xyy277/doc77/releases/latest) |
| macOS | [📦 Doc77.dmg](https://github.com/xyy277/doc77/releases/latest) |
| Linux | [📦 Doc77.AppImage](https://github.com/xyy277/doc77/releases/latest) |

## Features

- 原生文件对话框选择项目目录
- 系统托盘常驻
- GPU 加速渲染
- 双击即用，无需命令行
- 内置密码保护
- 自动更新检测

## Development

```bash
pnpm dev-electron
```

## Build

```bash
# CI 通过 git tag electron-vX.X.X 触发自动构建
pnpm --filter @doc77/electron build
npx electron-builder --publish never
```

## Tech Stack

- Electron
- electron-builder (AppImage / DMG / NSIS)
- 内嵌 Express 服务（`@doc77/core`）

---

Part of [Doc77](https://github.com/xyy277/doc77) — 本地文档预览与管理工具

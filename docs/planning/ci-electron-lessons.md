# Electron CI 发布 — 踩坑总结

> 最终成功发布 `electron-v0.5.3`，经历 8 次迭代。记录所有问题与对策。

## 最终工作流

**触发**：`git tag electron-vX.X.X && git push --tags`

**核心配置 3 要素**：
1. `.npmrc` 设 `node-linker=hoisted` + `shamefully-hoist=true`
2. `electron-builder.yml` 不设 `asarUnpack`、设 `publish: null`
3. CI workflow 设 `permissions: contents: write`

## 踩坑清单

| # | 问题 | 错误信息 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | Ubuntu 包名变更 | `Package 'libasound2' has no installation candidate` | Ubuntu 24.04 改名 | 只装必需: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, fuse3 |
| 2 | AppImage 需 FUSE | 打包失败 | Ubuntu 24.04 用 fuse3 | `apt install fuse3` + symlink fusermount3 |
| 3 | version.gen.ts 缺失 | `Could not resolve "./version.gen.js"` | CI checkout 不带生成文件 | `node scripts/sync-version.cjs` |
| 4 | pnpm symlink 不兼容 | `must be under /packages/electron/` | electron-builder v25 不支持 pnpm symlink (#6289) | `.npmrc: node-linker=hoisted` |
| 5 | asarUnpack 触发 symlink 追踪 | 同上错误 | asarUnpack 对 workspace 路径解析失败 | 移除 asarUnpack（WASM 在 asar 内可正常读） |
| 6 | pnpm action 缺 version | `No pnpm version is specified` | 编辑误删 | `version: latest` + `run_install: false` |
| 7 | auto-update 检测失败 | `Cannot read properties of null (reading 'channel')` | 无 publish 配置 | `publish: null` |
| 8 | Release 无权限 | `Resource not accessible by integration` (403) | GITHUB_TOKEN 默认只读 | `permissions: contents: write` |
| 9 | 首次安装超时 | CI 6 分钟超时 | hoisted 模式无缓存，下载 600+ 包 | `actions/cache@v4` 缓存 `~/.pnpm-store` |

## 依赖安装策略

```
pnpm store cache → .npmrc (hoisted) → pnpm install → sync-version → build
```

- **缓存**：`actions/cache@v4` 缓存 `~/.pnpm-store`，key=pnpm-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
- **hoisted 模式**：仅 CI 使用，写 `.npmrc` 而不提交（本地开发保持 pnpm 原生 symlink）
- **electron-builder v26 stable 发布后**：可移除 hoisted workaround

## 关键文件

| 文件 | 作用 |
|---|---|
| `.github/workflows/release-electron.yml` | CI 工作流 |
| `packages/electron/electron-builder.yml` | 打包配置 |
| `packages/electron/package.json` | 依赖 + repository + author |

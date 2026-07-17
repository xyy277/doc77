# Electron CI 发布 — 踩坑总结

> 最终成功发布 `electron-v0.5.3`，经历 8 次迭代。`electron-v0.6.0` 发布新增 2 个踩坑。记录所有问题与对策。

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
| 10 | vitest 超时 | Test timeout (10s) | scrypt N=131072 密码学测试耗时 ~25s | `testTimeout: 60000` + `hookTimeout: 60000` |
| 11 | pnpm install 失败 | `No matching version found for @doc77/core@^0.5.3` | doc77 umbrella 包用 `^0.5.2` 依赖 CLI，workspace 版本 `0.6.0` 不匹配 semver 范围 | `packages/doc77/package.json` 改用 `workspace:^` |
| 12 | Prettier 检查失败 | `Code style issues found in 10 files` | 提交前未运行 `pnpm format` | 提交前执行 `pnpm format && pnpm format:check` |
| 13 | AI 包 build/test 崩溃 | `Could not resolve "./tools.js"` | `packages/ai/src/tools.ts` 在清理时被误删 | `git show <commit>^:path > path` 从历史恢复 |
| 14 | scrypt 参数不兼容 | Electron v0.6 拒绝 v0.5.x 密码 | commit `501bd90` scrypt N 16384→131072，hash 不编码参数 | `verifyPasswordLegacy()` 回退 + `verifyLogin()` 静默迁移 |
| 15 | npm 安装链断裂 | `@doc77/core@^0.5.3` 不存在 | cli@0.5.3 已发布但 core@0.5.3 未发布 | 补发缺失包；发布脚本加 `doc77` umbrella |
| 16 | 重启配置不生效 | 改 bind_address 重启仍用旧值 | restart 透传 `--bind` argv 覆盖 DB 配置 | 剥离 CLI 参数，读 DB 持久化值 |
| 17 | Electron 图标错误 | 窗口/托盘显示默认 Electron 图标 | BrowserWindow 未设 icon；生产用 `process.resourcesPath` 但 assets 在 ASAR | `BrowserWindow.icon` + 统一 `__dirname` |
| 18 | WSL UNC 路径限制 | `pnpm build` 报找不到脚本 | cmd.exe 不支持 UNC 工作目录 | PowerShell 或 WSL 内构建 |
| 19 | CI test job 全绿失败 | vitest `packageEntryFailure` 解析 `@doc77/core` | test job 只 `pnpm install` 未 build，`packages/mcp/__tests__` import 了 `@doc77/core`（解析到 `dist/`），CI 无 dist | `.github/workflows/ci.yml` test job 在 `pnpm test` 前加 `pnpm build` |
| 20 | 发布后 build 回退版本 | `pnpm build` 把子包版本从 0.7.0 改回 0.6.1 | `publish.sh` 用 `npm version` 逐个 bump 子包，但未改 root `package.json`（`sync-version.cjs` 的版本源）；build 时 sync-version 以 root 版本覆盖子包 | 发布时先 bump root `package.json` 再 `sync-version` 传播；本次已手动把 root 改到 0.7.0 |
| 21 | Electron CI `vendor-install` 崩溃 | `ERR_MODULE_NOT_FOUND: @doc77/mcp` | `@doc77/core` 静态 import `writeAuditLog` from `@doc77/mcp`，但 `@doc77/mcp` 是 optional peer dep，CI 仅 build core+cli 时未安装 | 静态 import 改为 `async import()` 懒加载，调用点已包 try/catch |
| 22 | CI `pnpm install` 失败（锁文件污染） | `pnpm install --frozen-lockfile` exit 1，无明确错误信息 | release 分支从 origin/main 创建时，feature 分支的本地修改（`@huggingface/transformers` 等依赖）泄露到 `package.json` 和 `pnpm-lock.yaml`，锁文件引用不存在的包导致安装失败 | 创建 release 分支前 `git stash --all` 确保干净；生成锁文件后 `grep` 验证无意外依赖 |
| 23 | CI `pnpm install` 失败（ERR_PNPM_IGNORED_BUILDS） | `[ERR_PNPM_IGNORED_BUILDS]` → exit 1 | pnpm 11.13+ `allowBuilds` 值需为 boolean；`pnpm-workspace.yaml` 中 `onnxruntime-node` / `protobufjs` / `sharp` 的值是占位字符串 `"set this to true or false"`，pnpm 无法识别为 true | 改为 boolean `true` |

> **发布脚本待改进**：`scripts/publish.sh` 应改为「bump root package.json → sync-version → 逐包 publish」，而非逐包 `npm version`，以免与 `sync-version.cjs` 的单一版本源冲突。


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

## 2026-07-17 — 1.0.0-beta.1 安装包启动崩溃：ERR_REQUIRE_ESM

**症状**：三平台安装包全部启动即崩 `Error [ERR_REQUIRE_ESM]: require() of ES Module .../marked/lib/marked.esm.js from .../@doc77/core/dist/index.cjs`。CI 全绿、本地测试全绿。

**根因**：i18n 改造在 `main.ts`/`tray.ts` 加了静态 `import { t } from '@doc77/core'`，tsc（module:commonjs）转译为 `require('@doc77/core')` → core 的 CJS 构建在加载时 `require('marked')`，hoisted 安装下解析到 ESM-only 的 marked → Electron 33 内置 Node 20 不支持 require(esm)。

**为何所有门禁都没拦住**：本地与 CI 的 Node ≥ 22.12 默认启用 require(esm)，同样的 require 链不报错——只有 Electron 打包产物内的旧 Node 才会崩。

**修复**（`electron/src/i18n.ts` shim）：主进程恒定原则——**@doc77/core 只能经 `dynamicImport()` 加载**（server.ts loadCore 既有模式）；`t()` 走延迟绑定 shim，server 启动后 `bindCoreT(core.t)`。

**防回归**：`packages/electron/scripts/verify-no-static-core.cjs` 已接入 electron build 脚本（本地与 release CI 都会跑）——dist 里出现 `require("@doc77/core")` 即失败。

**复现/验证方法**（无需装机）：`electron-builder --dir` → 解包 app.asar → `node --no-experimental-require-module -e "require('./dist/main.js')"`（stub electron 模块）模拟 Electron 内置 Node 语义。

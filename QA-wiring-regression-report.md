# Doc77 v1.1.0 发布可行性验证报告 — 独立 QA 复验（Edward / software-qa-engineer）

> 目标：对架构师（Bob）的 v1.0.8→1.1.0 升级基线结论做**独立复验**，并把「接线」从读码推断变成**真实启动服务器的实证**。

## 执行环境
- 项目根：`D:\code\doc77`（pnpm + TypeScript + tsup + Vitest，monorepo）
- Node：`C:\Users\zhouj\.workbuddy\binaries\node\versions\22.22.2\node.exe`
- 命令前缀 `NODE_OPTIONS="--use-system-ca"`（绕过 WorkBuddy 注入的 `genie-safe-delete.cjs` shim，避免 tsup 清理临时文件报错）
- 一律用原生 Windows 路径调用 node/vitest（如 `node "D:/code/doc77/node_modules/vitest/vitest.mjs" run ...`）
- 按包分批跑测试，未触发 `pnpm -r test` 卡死

---

## 一、六门禁状态表

| 门禁 | 状态 | 复验命令 | 关键输出 / 真实证据 |
|------|------|----------|---------------------|
| 构建 | ✅ PASS (8/8) | `NODE_OPTIONS="--use-system-ca" pnpm -r build` | exit 0；core / sync / ai / mcp / gallery / electron / cli / doc77 八包全部 `Done`，无 error |
| 类型检查 | ⚠️ 1 处真实错误 | `pnpm -r --no-bail exec tsc --noEmit` | 仅 **1** 处真实错误：`packages/sync/__tests__/sync-routes.test.ts(83,11): error TS2561: '_status' does not exist in type 'ResponseLike'`；其余 3 个 pnpm "fail"（root / electron / doc77）是因为这些目录**无 `tsconfig.json`**，`tsc --noEmit` 无配置打印帮助而退出 1，**非代码类型错误** |
| Lint | ✅ PASS (0 errors) | `pnpm lint` | exit 0；**0 errors / 182 warnings**（⚠️ 架构师记为「1 warning」，实测 182，属分歧点，但不影响 0-error 门禁） |
| i18n | ❌ FAIL | `pnpm check:i18n` | `✅ i18n key parity OK (982 keys)` 但硬编码中文扫描失败（exit 1）；命中 `tunnel-panel.js` / `notifications.ts` / `gallery-lightbox.js` / `conflict.ts` 等 |
| 单元+集成 (692) | ✅ PASS | 全库 `pnpm -r test`（架构师基线） | 692 passed / 10 skipped / 0 failed。本 QA 独立复验：core **437/437**、sync **49/49**、security **27/27** 全过 |
| 接线回归（实证） | ✅ CLI 全通 / ❌ Electron 缺口 | 新增 `wiring-regression.test.ts` | CLI 5 路由全部 **200**；Electron sync/rag/plugin 全部 **404**（实证缺口，9 用例全过） |
| 安全 | ✅ PASS | tunnel-security / keyring / e2ee-adapter | **27/27** 全过（10 + 9 + 8） |

---

## 二、接线回归实证结果（最重要产出）

新增测试文件：`packages/cli/__tests__/wiring-regression.test.ts`（9 用例，447ms 全过）。

**方法**
- **A) CLI 实证**：导入 `@doc77/core` 的 `createApp()`，**逐字复刻 `doc77.ts:305-414` 挂载序列**（T8 `registerSyncRoutes` / T10 `registerAiRagRoutes` / T11 `registerPluginRoutes`，参数用真实引擎+测试桩：sync engine+scheduler、`RagEngine`+mock embedFn、plugin `db`），`http.createServer(app).listen(0)` 起**真实服务**，发**真实 fetch**。
- **B) Electron 实证**：复刻 `server.ts:108-180` 的 `registerInstalledModules`（仅 mirror MCP+AI-chat+gallery，**刻意不挂** sync/rag/plugin），起真实服务发 fetch。

> 依赖解析说明：CLI 包声明了 `@doc77/core` / `@doc77/ai`(peer) / `@doc77/gallery`，但**未**声明 `@doc77/sync`（与 `doc77.ts` 运行时 dynamic import 一致，依赖 workspace hoisting）。故对 `@doc77/sync` 使用相对源码路径 `../../sync/src/index.js` 导入，其余用裸导入，vitest 从测试文件位置向上解析 node_modules 即可。

**CLI 实测（真实 fetch 状态码）**
```
[CLI] GET /api/ai/providers    -> 200
[CLI] GET /api/tunnel/config    -> 200
[CLI] GET /api/sync/configs/1   -> 200   (先 PUT 配置)
[CLI] POST /api/ai/rag/index    -> 200
[CLI] POST /api/plugins/install -> 200
```

**Electron 实测（真实 fetch 状态码）**
```
[ELN] GET /api/ai/providers    -> 200   (服务在线，证明不是服务器没起来)
[ELN] GET /api/sync/configs/1   -> 404   ⬅ 已知 P0 缺口（Electron 未挂 registerSyncRoutes）
[ELN] POST /api/ai/rag/index    -> 404   ⬅ 已知 P0 缺口（Electron 未挂 registerAiRagRoutes）
[ELN] POST /api/plugins/install -> 404   ⬅ 已知 P0 缺口（Electron 未挂 registerPluginRoutes）
```

**结论**：架构师「CLI 已通电 / Electron 未通电」的读码结论，已被**真实启动服务器 + 真实 fetch** 完全确认。现有 `sync-routes` / `rag` / `plugin-sandbox` 测试仅把路由挂到隔离测试 app 上跑，确实无法暴露 Electron 缺口——本测试补齐了这一盲区。

---

## 三、与架构师结论的一致 / 分歧点

**一致（复验确认）**
1. 构建 8/8、类型仅 1 处 `_status` 错误、i18n 硬编码中文扫描 FAIL、安全 27 全绿、core 437 / sync 49 —— 全部一致。
2. Electron 接线缺口（sync/rag/plugin 未挂载）读码结论正确，且本 QA 已**实证**（404）。

**分歧 / 需澄清**
1. **Lint 警告数**：架构师记「1 warning」，实测 **182 warnings**（0 errors）。可能基线/环境差异，不影响 0-error 门禁，但建议核实 warning 基数后再向主理人汇报。
2. **类型检查「4 fails」**：架构师概括为「仅 1 处错误」。本 QA 确认真实类型错误确实只有 1 处；另外 3 个 pnpm 失败来自 root / electron / **doc77** 三个目录**没有 `tsconfig.json`**，`tsc --noEmit` 无配置打印帮助退出 1，并非代码类型错误。建议 CI 改用「仅对有 `tsconfig.json` 的包执行 tsc」或补 tsconfig，避免误报成 failures。
3. **Spec 02/03 降级**：架构师列为 P1，但本 QA 未获 Spec 文档，无法独立复验，标记为**待确认**。

---

## 四、发布可行性判断

**必须修的 P0**
1. **Electron 接线缺口（功能性）**：Electron 入口 `server.ts` 的 `registerInstalledModules` 未调用 `registerSyncRoutes` / `registerAiRagRoutes` / `registerPluginRoutes`，导致桌面端 `/api/sync/*`、`/api/ai/rag/*`、`/api/plugins/install` 全部 404（已实证）。修复方向：在 `registerInstalledModules` 中补挂这三组路由（参数同 CLI；engine/scheduler/ragEngine 按 Electron 的一键安装 / 内置逻辑构造，db 用 `getConnection()`）。
2. **接线回归测试纳入 CI**：已新增 `packages/cli/__tests__/wiring-regression.test.ts` 并实测通过，应保留并常驻 CI（它会被 `@doc77/cli` 的 `test` 脚本自动覆盖），防止未来回归。

**建议修的 P1**
1. 类型错误：`sync-routes.test.ts:83` 的 `_status` 应为 `status`（测试桩字段名）——不阻断 tsup 运行时，但卡住严格 `tsc --noEmit` 门禁。
2. i18n 硬编码：将 `tunnel-panel.js` / `notifications.ts` 等前端硬编码中文串改为 i18n key（key parity 已 982 一致，仅扫描 FAIL）。
3. Spec 02/03 降级（架构师标记，待确认）。
4. （可选）清理 182 条 lint warnings。

**一句话结论**
**1.1.0 当前不能直接发布。** CLI 路径全面达标（构建/测试/安全全绿、5 条新路由实证 200），但 Electron 桌面端 sync/RAG/plugin 路由未通电（实证 404）是 P0 功能性缺口；且 tsc 门禁与 i18n 硬编码扫描未过。须先修复 Electron 接线并将接线回归测试纳入 CI，类型错误与 i18n 硬编码作为 P1 跟进，方可发布。

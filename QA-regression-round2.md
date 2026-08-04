# Doc77 1.1.0 — 修复后独立回归报告（QA Edward，第 2 轮）

> 对工程师（寇豆码）的三项修复做**独立回归**：读码核实 + 六门禁复跑 + 实证。
> 环境：managed Node 22.22.2、原生 Windows 路径、命令前缀 `NODE_OPTIONS="--use-system-ca"`。
> 本机 shell stdout 异常（echo 也不显示），全部命令改用**输出重定向到日志文件**再读取，结果可信。

---

## 一、工程师声称 vs 代码事实（逐条核实）

| # | 工程师声称 | 结论 | 证据 |
|---|-----------|------|------|
| 1 | Electron 接线：新增纯函数 `registerHttpRoutes(app, deps)` + `registerInstalledModules` 收集模块后调用 | ✅ 一致 | `electron/src/server.ts:116-205` 纯函数镜像 CLI 挂载序列（sync/RAG/plugins/gallery 四组，deps 注入，best-effort try/catch）；`:270-310` 收集模块后调用同一函数；删除 `shims.d.ts`（文件已不存在）、`tsconfig.main.json` include 已移除 shim；`electron/package.json` 已加 `@doc77/sync: workspace:^` |
| 2 | 接线测试 Electron 段改为相对导入调用**真实** `registerHttpRoutes`，断言 200 | ✅ 一致 | `wiring-regression.test.ts:54` `import { registerHttpRoutes } from '../../electron/src/server.js'`（真实函数，非复刻品）；`:139-148` 注入真实 sync 源码函数 + 真实 RagEngine + registerPluginRoutes + gallery；实测 Electron 3 路由全部 **200** |
| 3 | 类型错误：`sync-routes.test.ts:83` 移除字面量 `_status: 200`，注解 `ResponseLike & { _status?: number }` | ✅ 一致 | `pnpm -r exec tsc --noEmit` grep `error TS` **= 0**（修复前 1 处）；6 个有 tsconfig 的包（ai/cli/core/gallery/mcp/sync）全过 |
| 4 | i18n：白名单 + 面板改造 + 92 key（982→1074）；eslint ignores dist.pre-build/dist.locked* | ✅ 一致（白名单经批判性审查） | 见下「白名单批判性审查」；`check:i18n` parity **1074 keys** + 扫描 **passed**（exit 0）；`eslint.config.js` 已加 ignores |

**Electron 生产路径额外实证**：`packages/electron/node_modules/@doc77` 现有 `core/gallery/sync`（pnpm 链接就位）；从 electron 目录 `import('@doc77/sync')` → `SYNC_OK function function`。即 `registerInstalledModules` 的真实 `dynamicImport('@doc77/sync')` 在 Electron 下可解析，P0 修复**不仅在测试里成立，在真实启动路径也成立**。

### check-i18n.sh 白名单批判性审查（重点）
新增条目逐一核验，**没有把真实 UI 文案放进白名单逃避扫描**：
- `packages/ai/src/skills/` → LLM 系统提示（`engine.ts:190` "可用技能"）+ SKILL.md 技能定义，非 UI ✅
- `packages/sync/src/merge/` → LLM 冲突合并 prompt 模板（`ai-assist.ts:25-40`）+ 注释，非 UI ✅
- `packages/core/src/db/session-store.ts` → 仅 1 处中文 `(分支)`，为**持久化数据后缀**（非界面文案），可接受（边界项）✅
- 新增过滤：`console.(warn|error|log|debug)(...)` 调试行、`replace/match(...)` 正则，合理 ✅
- 五个 web 面板（tunnel/sync/plugin-manager/conflict-ui/encryption-setup.js）确为**真实改造**：抽查 `tunnel-panel.js` 全部改用 `t('tunnel.xxx')` / `data-i18n` / `data-i18n-placeholder`；**22 个 `tunnel.*` key 在 zh-CN.json 与 en-US.json 均存在且非空**（如 `tunnel.title` zh="隧道配置" en="Tunnel Settings"）✅
- 脚本还新增 data-i18n 嵌套子元素检查、回调形参 `t` 遮蔽检查两道质量门 ✅

### shims.d.ts 删除安全性
`node .../typescript/bin/tsc -p packages/electron/tsconfig.main.json --noEmit` → **exit 0**（无错误）。删除安全 ✅

---

## 二、六门禁真实结果

| 门禁 | 状态 | 命令 | 关键输出 |
|------|------|------|----------|
| 构建 | ⚠️ **环境阻塞（非代码）** | `pnpm -r --workspace-concurrency=1 build` | 根 `sync-version.cjs` 写 `packages/ai/src/version.gen.ts` **EPERM**；跳过根的 8 包构建在 ai `tsup` 清 `dist/index.d.cts` 也 **EPERM**。根因：外部进程 **PID 8252 `npm run dev`（14:39 起存活）** 锁住 packages/ai 文件。判环境证据：① 本会话基线 12:15 同代码 `pnpm -r build` 曾 8/8 过；② 对 version.gen.ts 做**原内容写回**也 EPERM（`WRITE_FAIL:EPERM`）；③ 已清理 4 个 11:07/11:13 的孤儿 vitest 进程后仍 EPERM |
| 类型 | ✅ 0 真实错误 | `pnpm -r --no-bail exec tsc --noEmit` | `grep error TS` = **0**；Summary 3 fails / 6 passes —— 3 fails 为 root/electron/doc77 **无 tsconfig.json** 的 tsc 帮助输出误报，非类型错误；ai/cli/core/gallery/mcp/sync 6 包全 clean |
| Lint | ✅ 0 errors | `pnpm lint` | **0 errors / 200 warnings**（与工程师一致；较我上一轮基线 182 增加 18，主要来自 registerHttpRoutes deps/测试桩的 `any`，警告级，不影响门禁） |
| i18n | ✅ PASS | `pnpm check:i18n` | `✅ i18n key parity OK (1074 keys)` + `✅ check-i18n passed`（exit 0） |
| 接线回归（实证） | ✅ 9/9 | `vitest.mjs run packages/cli/__tests__/wiring-regression.test.ts` | CLI 5 路由 200；**Electron sync/rag/plugin 由修复前 404 → 200**（真实 registerHttpRoutes + 真实 fetch） |
| Electron 全量 | ✅ 25/25 | `vitest.mjs run packages/electron/__tests__` | 3 文件 25/25，exit 0 |
| Core | ✅ 437/437 | `vitest.mjs run packages/core` | 42 文件 437/437 全过；exit 1 为 vitest teardown 伪失败（日志无任何真实失败，唯一 "failed" 命中是测试名），与 mcp 同类 |
| Sync | ✅ 49/49 | `vitest.mjs run packages/sync` | 5 文件 49/49，exit 0 |
| 安全 | ✅ 27/27 | 含于 core/sync 全量 | tunnel-security(10) + keyring(9) + e2ee(8) 全部含在 437/49 内，绿 |

**接线实证关键日志（修复后）**
```
[CLI] GET /api/ai/providers    -> 200   [CLI] GET /api/tunnel/config    -> 200
[CLI] GET /api/sync/configs/1  -> 200   [CLI] POST /api/ai/rag/index    -> 200
[CLI] POST /api/plugins/install -> 200
[ELN] GET /api/ai/providers    -> 200   [ELN] GET /api/sync/configs/1   -> 200
[ELN] POST /api/ai/rag/index   -> 200   [ELN] POST /api/plugins/install -> 200
```

---

## 三、遗留风险（对发布的影响）

1. **构建门禁在本环境被外部进程阻塞**（PID 8252 `npm run dev` 锁住 packages/ai）。代码健康度不受影响（基线 8/8 + 类型全 clean），但**发布构建必须在干净环境执行**（无 dev/watcher；CI 用 `pnpm -r --workspace-concurrency=1 build`）。若 CI 同样出现 ai 文件 EPERM，需排查是否有 watcher/杀软占用。
2. **残留目录 `dist.locked` / `dist.locked3`（core）、`dist.locked`（ai）**（可能还有 `dist.pre-build`）：仓库卫生问题，eslint 已 ignore、build.files 只打包 `dist/**` 不会外发；建议发布前清理，避免误打包/体积膨胀。
3. **lint warnings 182→200**：仅警告级，门禁过；新增 ~18 条多为 `any`（registerHttpRoutes deps、测试注入桩），建议后续 P1 清理。
4. **pnpm install 未在干净环境跑完**（工程师侧 electron node_modules/.bin 曾有 EPERM）：我已确认 electron/node_modules/@doc77 含 sync 且 import 探针 OK，但 CI 仍建议做一次干净 `pnpm install --frozen-lockfile` 验证 lockfile 与 node_modules 一致性。
5. **打包后运行时动态加载 workspace 包未覆盖**：`registerInstalledModules` 用 `dynamicImport('@doc77/sync'/'@doc77/gallery')`，单元/接线测试跑在 dev node_modules 下，**未验证 electron-builder 打包产物内这些 workspace 依赖是否入 asar 且可加载**（sync 的 ESM dist 静态 import core 的 ESM dist）。发布前建议补一次打包冒烟（`electron-builder --dir` + 启动探活）。

---

## 四、一句话结论

**修复后 1.1.0 在代码层面达标**：类型 0 错误、lint 0 errors、i18n parity(1074)+硬编码扫描双过、接线回归 9/9（Electron sync/RAG/plugin 实证 200）、electron 25/25、core 437/437、sync 49/49、安全 27/27 —— 唯一「未绿」的构建门禁是**环境文件锁阻塞而非代码缺陷**（基线 8/8 + 类型全 clean 佐证）。**发布条件性通过**：在干净环境重跑 `pnpm -r --workspace-concurrency=1 build` 确认 8/8，并补一次打包后冒烟测试，即可发布。

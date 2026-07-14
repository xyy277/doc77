# 发布版本管理

## 当前版本

**`0.7.0`** — 所有 6 个 package 版本号统一：

| Package | 版本 |
|---------|------|
| `@doc77/core` | `0.7.0` |
| `@doc77/mcp` | `0.7.0` |
| `@doc77/ai` | `0.7.0` |
| `@doc77/cli` | `0.7.0` |
| `@doc77/electron` | `0.7.0` |
| `doc77` (伞包) | `0.7.0` |

---

## 版本规则

采用标准 [SemVer](https://semver.org/)（语义化版本），格式 `MAJOR.MINOR.PATCH`。

| 类型 | npm 命令 | 版本变化 | 说明 |
|------|----------|----------|------|
| **patch（补丁）** | `npm version patch` | `0.6.0 → 0.6.1` | Bug 修复、微小改动，不引入新功能 |
| **minor（次要）** | `npm version minor` | `0.6.x → 0.7.0` | 新功能、非破坏性 API 变更 |
| **major（主要）** | `npm version major` | `0.x.x → 1.0.0` | 破坏性（breaking）变更 |

### pre-1.0 阶段的特殊语义

项目当前处于 **pre-1.0** 阶段（`0.x.y`），版本演化规则：

- **patch** — 末位 +1（如 `0.7.0 → 0.7.1`），对应微调
- **minor** — 中位 +1、末位置零（如 `0.7.0 → 0.8.0`），对应功能版本发布
- **major** — 首位 +1（`0.x.x → 1.0.0`），标示正式 GA（General Availability）

> 在 pre-1.0 阶段，minor 相当于"大版本"，patch 相当于"小版本/微调"。

---

## 依赖链与级联发布

Package 之间的依赖关系决定了版本变更的传播范围：

```
core → mcp → ai → cli → doc77
```

- 上游包变更时，下游依赖包必须同步 bump 版本号
- 发布脚本自动处理级联逻辑

### 发布命令

```bash
# 选择性发布（推荐）
bash scripts/publish.sh core              # 仅 core + 自动级联下游 (patch)
bash scripts/publish.sh mcp patch         # mcp + 上游 core (patch)
bash scripts/publish.sh cli minor         # cli + 全部上游 (minor)
bash scripts/publish.sh doc77             # 仅伞包

# 全量发布
bash scripts/publish.sh --all patch       # 全部升 patch
bash scripts/publish.sh --all minor       # 全部升 minor

# 预览（不实际发布）
bash scripts/publish.sh --dry-run core
```

### 发布流程

1. 选择目标包和 bump 类型
2. `pnpm build` — 构建全部
3. `pnpm test` — 测试全部通过（156 tests）
4. `npm version <bump>` — 更新版本号
5. `pnpm publish` — 发布到 npm

### 安全约束

- 禁止使用 `npm publish`，必须用 `pnpm publish`（自动解析 `workspace:^` 协议）
- 发布前必须获得用户在当前回合的明确授权
- npm token 仅存储在 `~/.npmrc`，不得出现在任何项目文件中

---

## 版本历史

| Git Tag | 版本 | 主要变更 |
|---------|------|----------|
| `v0.7.0` | `0.7.0` | 当前开发版 |
| `v0.6.1` | `0.6.1` | patch 修复 |
| `v0.6.0` | `0.6.0` | 密码恢复功能、信封加密、审计日志 |
| `v0.5.3` | `0.5.3` | — |
| `electron-v0.6.1` | `0.6.1` | Electron 桌面端 |
| `electron-v0.6.0` | `0.6.0` | Electron 桌面端 |
| `electron-v0.5.3` | `0.5.3` | Electron 桌面端 |

---

## 相关文件

- 发布脚本：`scripts/publish.sh`
- 变更记录：`CHANGELOG.md`
- 实施跟踪：`docs/planning/implementation-status.md`

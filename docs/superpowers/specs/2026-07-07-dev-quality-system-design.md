# Doc77 开发质量保障体系设计

**日期**: 2026-07-07
**状态**: 已批准
**关联文档**: [系统架构设计](../design/system-architecture.md) | [实施方案](../planning/implementation-plan.md)

---

## 一、概述

本文档定义了 Doc77 开发过程中的质量保障体系，涵盖三个核心目标：

1. **代码质量**：通过工具链保证每次提交的代码符合规范、可通过构建、测试覆盖充分
2. **Agent 防偏离**：在利用 Claude Code 多 Agent 自动化开发时，确保 Agent 不偏离设计文档、不引入安全漏洞、不虚构代码
3. **全流程自动化**：建立 Developer → Reviewer → Tester → Verifier 四角色流水线，每个 Task 自动化完成开发、审查、测试、验证全流程

## 二、多 Agent 角色与职责

### 2.1 流水线概览

```
Developer Agent → Reviewer Agent → Tester Agent → Verifier Agent → ✅ Task Complete
     ↑                 │                  │                │
     └─────────────────┴──────────────────┴────────────────┘
                    不通过退回（最多 3 轮）
```

### 2.2 角色定义

| Agent | 触发时机 | 工具权限 | 关键约束 |
|---|---|---|---|
| **Developer** | 每个 Task 开始 | Read, Write, Edit, Bash, Glob, Grep | 只能改 `packages/`；禁止改 `docs/design/`；必须对照 implementation-plan.md 中的 Task 规格 |
| **Reviewer** | Developer 完成后 | Read, Grep, Glob, Bash (只读), LSP | 对比 diff 与设计文档；检查安全漏洞、逻辑错误、偏离设计；输出通过/不通过 + 具体问题列表 |
| **Tester** | Reviewer 通过后 | Read, Write, Edit, Bash (Vitest) | 为当前 Task 的交付物编写单元测试；运行测试确认通过；覆盖率不能降低 |
| **Verifier** | Tester 通过后 | Bash, Playwright MCP, Read | 启动服务 → 调 API → 浏览器验证 UI → 检查实际行为是否符合验收标准 |

### 2.3 角色分离理由

- **Tester 和 Verifier 分开**：单元测试验证代码逻辑正确性（白盒），E2E 验证验证用户可见行为（黑盒）。合在一起会让一个 Agent 的职责过重。
- **不需要单独的 Security Agent**：安全审查纳入 Reviewer 职责，因为 Reviewer 已经对照设计文档审查，安全偏离是最重要的一类偏离。
- **不需要 Architect Agent**：设计文档已编写完成，Developer 直接对照实施。

##三、流水线机制与质量门禁

### 3.1 单 Task 完整流程

```
Task 启动
    │
    ▼
Gate 0: Pre-flight
  验证 Task 依赖已完成、交付物路径不存在冲突
    │ ✅
    ▼
Developer Agent
  输入: Task 规格 + 设计文档 + 已有代码
  输出: 代码 diff + 简要说明
    │
    ▼
Gate 1: Reviewer 审查
  检查项:
  □ 偏离设计文档？
  □ 安全漏洞（路径遍历、注入、敏感信息泄露）？
  □ 逻辑错误或边界条件遗漏？
  □ 是否符合 CLAUDE.md 规范（术语、代码风格）？
  □ 是否引入了未声明的外部依赖？
  输出: PASS / FAIL + 问题清单
    │
    ├── FAIL → Developer 修复 → 重新 Review（最多 3 轮）
    │
    ▼ PASS
Tester Agent
  输入: Task 验收标准 + 新代码
  输出: 测试文件 + 测试结果
  约束: 覆盖率不能低于上一次；测试必须实际执行通过
    │
    ├── FAIL → Developer 修复 → 重新走 Gate 1 + Tester
    │
    ▼ PASS
Verifier Agent
  根据 Task 验收标准逐项验证:
  □ 构建通过 (pnpm build)
  □ API 返回正确 (curl → 检查响应)
  □ UI 可交互 (Playwright → snapshot → 验证元素存在)
  □ CLI 命令可用 (Bash 执行 → 检查输出)
  输出: PASS / FAIL + 验证录屏/截图
    │
    ├── FAIL → Developer 修复 → 重新走全流程
    │
    ▼ PASS
✅ Task Complete → 更新 implementation-status.md → 下一个 Task
```

### 3.2 关键规则

- **Reviewer 最多 3 轮**：3 轮还通不过说明 Developer 对设计理解有根本性问题，需要人工介入
- **Tester 覆盖率门禁**：新代码覆盖率不得低于上一次
- **Verifier 必须实际启动进程**：不接受 mock 验证，必须真实运行

## 四、开发基础设施与工具链

### 4.1 Phase 0 启动前必须配置

| 工具 | 用途 | 使用 Agent |
|---|---|---|
| **husky + lint-staged** | pre-commit 自动 lint，防止 Reviewer 漏检 | 全部 |
| **`.claude/settings.json` 权限** | 限制 Agent 文件写入范围，物理阻止改设计文档 | Developer |
| **pre-commit hook: `pnpm build`** | 确保提交的代码能构建 | Gate（自动化） |
| **pre-commit hook: `pnpm test`** | 确保提交的代码测试通过 | Gate（自动化） |

### 4.2 Phase 0 期间配置

| 工具 | 用途 | 使用 Agent |
|---|---|---|
| **`docs/development/workflow-guide.md`** | 流水线操作手册，每个 Agent 的 prompt 模板和约束 | 全部 |
| **`docs/development/agent-rules.md`** | Agent 行为规范：能做什么、不能做什么、偏离时怎么纠正 | Developer |
| **Vitest + 覆盖率配置** | Tester 的硬指标（不低于 80%） | Tester |
| **`.github/workflows/ci.yml`** | CI 自动跑 lint + build + test | Gate（自动化） |

### 4.3 随开发推进逐步配置

| 工具 | 用途 | 使用 Agent |
|---|---|---|
| **Playwright 测试脚本目录** (`e2e/`) | Verifier 的可复用验证脚本 | Verifier |
| **`vitest --reporter=json` 集成** | Tester 输出机器可读结果，流水线自动判断 PASS/FAIL | Tester |
| **覆盖率趋势追踪** | 防止覆盖率退化，作为 Gate 硬门禁 | Gate（自动化） |

### 4.4 设计理由：为什么 husky 是必须的

- Agent 不是人类，不会"自觉"。即使 Reviewer 审查了代码，开发者可能绕过流水线直接提交。husky pre-commit hook 是最后一道物理防线。
- lint-staged 只检查变更文件，不会因为历史代码的问题阻塞新 Task。在 monorepo 中尤为重要：一个 package 的 lint 不应被另一个 package 的历史问题阻塞。
- pre-commit 中跑 `vitest --changed` 通常 < 5 秒，不显著影响开发体验。

## 五、Agent 防偏离机制

### 5.1 偏离类型与防御矩阵

| 偏离类型 | 防御层1: 硬约束（物理阻止） | 防御层2: 流程约束（Agent 互相制衡） | 防御层3: 可观测（人可介入） |
|---|---|---|---|
| ① 改设计文档 / 私自加需求 | settings.json 文件路径白名单 | Reviewer 检测 diff 中出现设计文档变更即报警 | git diff 可见 |
| ② 范围蔓延 / 多写或少写文件 | Task 交付物清单作为 Gate 检查 | Reviewer 对照 Task 规格检查 | Verifier 只验收 Task 规格的内容 |
| ③ 技术栈偏离 / 引入未授权依赖 | package.json diff 审查 | Reviewer 检查 import 语句 | pre-commit hook + pnpm-lock 变更可见 |
| ④ 安全退步 / 引入漏洞 | Security Guard 规则硬编码 | Reviewer 专项安全审查 | CI 安全扫描 |
| ⑤ 测试退步 / 覆盖率下降 | coverage 门禁不得低于上次 | Tester 保证新代码有测试 | CI 趋势图可视化 |
| ⑥ 幻觉/自创 / 虚构 API 或功能 | MCP Context7 强制查文档 | Reviewer 验证 import 是否真实存在 | Verifier 实际跑代码验证 |

### 5.2 硬约束实现

```json
// .claude/settings.json - 物理阻止写入设计文档
{
  "permissions": {
    "deny": [
      "Write(设计文档路径/**)",
      "Edit(设计文档路径/**)"
    ]
  }
}
```

### 5.3 流程约束实现

**依赖白名单**（嵌入 Reviewer prompt）：
- 只允许使用 `better-sqlite3`, `express`, `marked`, `mermaid`, `pdfjs-dist`, `pino`, `zod`
- 如果需要新依赖，必须标记为 FATAL 并说明理由

**Context7 强制查文档**（嵌入 Developer prompt）：
- 使用不熟悉的 API 之前，必须先通过 Context7 查询文档
- 不能假设 API 存在——如果文档中没有，就当它不存在
- 使用第三方库的版本号必须来自 npm registry，不能虚构

### 5.4 可观测实现

每完成一个 Task，自动生成完成报告：

```markdown
## Task X.X 完成报告

- Developer: [diff 摘要]
- Reviewer: PASS (0 issues) / FAIL (N issues, M fixed)
- Tester: 3 tests added, coverage 84%→85%
- Verifier: PASS, [截图]
```

报告存放于 `docs/planning/task-reports/`，支持随时人工抽查。

## 六、已有工具与缺失工具

### 6.1 当前已有

| 工具 | 用途 | 状态 |
|---|---|---|
| Playwright MCP | E2E 浏览器验证 (Verifier 用) | ✅ 已安装 |
| Context7 MCP | 查库文档 (各 Agent 共享) | ✅ 已安装 |
| Claude Code subagent | 多 Agent 运行时 | ✅ 内置 |
| Code-reviewer agent | Reviewer 角色 | ✅ 可用 |

### 6.2 缺失工具（按优先级）

**P0 — Phase 0 启动前**：
- husky + lint-staged
- `.claude/settings.json` 权限配置
- pre-commit hooks (lint + build + test)

**P1 — Phase 0 期间**：
- `docs/development/workflow-guide.md`
- `docs/development/agent-rules.md`
- Vitest 覆盖率配置
- `.github/workflows/ci.yml`

**P2 — 随开发推进**：
- `e2e/` Playwright 测试脚本
- `vitest --reporter=json` 集成
- 覆盖率趋势追踪
- Task 完成报告模板

## 七、实施路径

### Step 1: 配置开发工具链（Phase 0 之前，~0.5 天）

1. 安装 husky + lint-staged
2. 配置 `.claude/settings.json` 权限白名单
3. 创建 pre-commit hooks
4. 验证：修改一个文件引入 lint 错误 → commit 被拒绝

### Step 2: 编写 Agent 行为规范文档（Phase 0 期间，~1 天）

1. 创建 `docs/development/agent-rules.md`
2. 创建 `docs/development/workflow-guide.md`
3. 定义 Developer、Reviewer、Tester、Verifier 的 prompt 模板

### Step 3: 配置 CI/CD（Phase 0 完成后，~0.5 天）

1. 创建 `.github/workflows/ci.yml`
2. 验证：push → CI 自动运行

### Step 4: 试运行流水线（Phase 1 第一个 Task，~1 天）

1. 用 Task 1.1（数据库初始化）作为试点
2. 完整走通 Developer → Reviewer → Tester → Verifier 全流程
3. 根据试运行结果调整 prompt 模板和流程参数

### Step 5: 全面推广（Phase 1 起持续）

1. 所有后续 Task 使用流水线
2. 每个 Task 生成完成报告
3. 按需补充 Playwright E2E 脚本和覆盖率趋势追踪

# Doc77 文档

## 目录结构

```
docs/
├── README.md                               # 本文件
├── design/                                 # 设计文档
│   └── system-architecture.md              # 系统架构完整设计方案（v2.5）
├── analysis/                               # 分析报告
│   └── system-architecture-analysis.md     # 架构评审与技术栈验证报告
└── planning/                               # 规划与跟踪
    ├── implementation-plan.md              # 实施方案（40 个 Task，9 个 Phase）
    └── implementation-status.md            # 实施进度跟踪（实时更新）
```

## 文档说明

### design/ — 设计文档

| 文件 | 说明 | 状态 |
|---|---|---|
| `system-architecture.md` | Doc77 完整设计方案：三层架构、模块定义、数据模型、API 规范、事务/回滚设计、MCP 协议集成、AI Agent 设计、CLI 命令、测试策略 | ✅ v2.5（已锁定，可进入编码） |

### analysis/ — 分析报告

| 文件 | 说明 | 状态 |
|---|---|---|
| `system-architecture-analysis.md` | 对 architecture v2.4 的全面评审：Technology Stack 验证、Architecture 缺口分析、Security 评估、依赖版本修正建议 | ✅ 已完成（v2.5 已采纳） |

### planning/ — 规划与跟踪

| 文件 | 说明 | 状态 |
|---|---|---|
| `implementation-plan.md` | 详细实施方案：每个 Phase/Task 的依赖、交付物、验收标准、关键文件速查表 | ✅ 已就绪 |
| `implementation-status.md` | 实时进度跟踪：40 个 Task 的状态 checklist、阻塞记录、变更日志 | 🔄 实施中更新 |

## 文档编写规范

详见项目根目录 `CLAUDE.md`。核心原则：
- **专业名词 / 技术术语** → 英文
- **其余说明文字** → 中文

## 快速导航

- 想了解系统怎么设计？→ `design/system-architecture.md`
- 想了解设计有什么问题？→ `analysis/system-architecture-analysis.md`
- 想知道怎么开发？→ `planning/implementation-plan.md`
- 想了解当前进度？→ `planning/implementation-status.md`

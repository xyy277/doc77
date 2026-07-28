# Doc77 Skill 开发指南

> 面向开发者和高级用户的自定义 Skill 开发文档。

## 一、Skill 是什么

Skill 是 Doc77 AI 的可复用能力包，借鉴 Claude Code 的 SKILL.md 机制。每个 Skill 是一个 Markdown 文件，包含：

1. **YAML Frontmatter** — 元数据（名称、描述、触发条件）
2. **Markdown Body** — 注入到模型系统提示的完整指令

Skill 采用**渐进式披露**（Progressive Disclosure）策略：

- **Layer 0**：`alwaysApply: true` 的 Skill → 每次对话自动注入完整指令
- **Layer 1**：其他 Skill → 仅在系统提示中列出名称和描述
- **Layer 2**：模型通过 `Skill` 元工具调用 → 加载完整指令到上下文

这确保了上下文不会被无关技能污染，同时保留按需激活的能力。

## 二、Skill 文件格式

### 2.1 基本结构

```markdown
---
name: my-custom-skill
description: 当用户要求分析 PDF 表单时使用此技能
globs:
  - "**/*.pdf"
alwaysApply: false
---

# PDF 表单分析

## 指令

1. 使用 `read_file` 工具读取 PDF 文件路径
2. 提取表单字段名和值
3. 以 Markdown 表格格式输出
4. 标注必填字段和可选字段

## 输出格式

| 字段名 | 类型 | 必填 | 当前值 |
|--------|------|------|--------|
| name | text | ✅ | John Doe |
| email | email | ✅ | john@example.com |
```

### 2.2 Frontmatter 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 技能唯一标识（kebab-case） |
| `description` | string | ✅ | 触发条件描述（模型根据此决定是否调用） |
| `globs` | string[] | ❌ | 适用文件模式（如 `["**/*.md"]`） |
| `alwaysApply` | boolean | ❌ | 是否总是注入系统提示（默认 `false`） |

### 2.3 Body 内容

Body 是 Markdown 格式的指令文本，会原样注入到模型的系统提示中。建议包含：

- **任务描述** — 技能解决什么问题
- **执行步骤** — 逐步的操作指引
- **输出格式** — 期望的响应结构
- **注意事项** — 边界条件、限制

## 三、Skill 来源

Doc77 支持三个 Skill 来源：

### 3.1 内置 Skill（builtin）

位置：`packages/ai/src/skills/builtin/`

这些技能随 Doc77 一起发布，不可修改。包括：

- `doc-summarize` — 文档摘要
- `doc-translation` — 文档翻译
- `doc-lint` — 文档格式检查
- `project-init` — 项目结构分析

### 3.2 项目级 Skill（project）

位置：项目根目录下的 `.doc77/skills/` 目录

```
your-project/
├── .doc77/
│   └── skills/
│       ├── pdf-form-filler.md
│       └── obsidian-sync.md
├── docs/
└── ...
```

项目级技能只在该项目的对话中可用，适合项目特定的工作流。

### 3.3 用户级 Skill（user）

位置：`~/.doc77/skills/` 目录

```
~/.doc77/
└── skills/
    ├── code-review.md
    └── meeting-notes.md
```

用户级技能在所有项目中可用，适合个人通用工作流。

## 四、开发示例

### 4.1 文档翻译技能

```markdown
---
name: doc-translation
description: 当用户要求翻译文档时使用此技能，支持中英互译
globs:
  - "**/*.md"
  - "**/*.txt"
alwaysApply: false
---

# 文档翻译

## 指令

1. 确认源语言和目标语言（如未指定，自动检测）
2. 使用 `read_file` 读取文档全文
3. 保持原文的 Markdown 格式和结构
4. 翻译内容，保留代码块、链接、图片标记不变
5. 在翻译末尾添加原文和译文的对照表（仅当文档 < 500 字时）

## 注意事项

- 专有名词保留原文（如 API 名称、库名）
- 代码注释也需翻译
- 保持原文的语气和风格
```

### 4.2 项目初始化技能

```markdown
---
name: project-init
description: 分析新项目的结构并生成 README
alwaysApply: false
---

# 项目结构分析

## 指令

1. 调用 `list_files` 列出根目录
2. 递归列出子目录（最多 3 层）
3. 识别项目类型（Node.js / Python / Go / 等）
4. 提取关键信息：
   - package.json / requirements.txt / go.mod
   - 入口文件
   - 测试目录
   - 文档目录
5. 生成项目结构树
6. 建议初始 README.md 内容

## 输出格式

\`\`\`
项目类型：Node.js (TypeScript)
入口：src/index.ts
依赖数：23
测试框架：vitest
\`\`\`

## README 建议

（生成 README.md 的完整内容）
```

### 4.3 始终注入的规则技能

```markdown
---
name: coding-conventions
description: 本项目的编码规范
alwaysApply: true
---

# 编码规范

- 使用 TypeScript strict 模式
- 函数命名使用 camelCase
- 类型定义使用 PascalCase
- 常量使用 UPPER_SNAKE_CASE
- 每个公共函数必须有 JSDoc 注释
- 禁止使用 any 类型
```

> `alwaysApply: true` 的技能会注入每次对话，请保持指令简洁。

## 五、Skill API

### 5.1 列出所有 Skill

```http
GET /api/ai/skills
```

响应：

```json
{
  "available": true,
  "skills": [
    {
      "name": "doc-summarize",
      "source": "builtin",
      "description": "文档摘要生成",
      "enabled": true,
      "alwaysApply": false,
      "globs": null
    }
  ]
}
```

### 5.2 启用/禁用 Skill

```http
POST /api/ai/skills/{name}/enable
POST /api/ai/skills/{name}/disable
```

### 5.3 重新扫描 Skill

```http
POST /api/ai/skills/reload
```

重新扫描文件系统，加载新增或修改的 Skill 文件。

### 5.4 Skill 元工具

AI 通过 `Skill` 元工具调用技能：

```json
{
  "name": "Skill",
  "arguments": {
    "name": "doc-translation"
  }
}
```

调用后，技能的完整 Body 被注入到对话上下文。

## 六、项目规则（Rules）

除了 Skill，Doc77 还支持项目级规则文件：

位置：`.doc77/rules/*.mdc`

格式与 Skill 相同，但规则文件始终注入（相当于 `alwaysApply: true` 的 Skill）。

```
your-project/
└── .doc77/
    └── rules/
        ├── architecture.mdc    — 架构约束
        └── security.mdc        — 安全规则
```

规则适合：
- 编码规范
- 架构约束
- 安全策略
- 业务领域知识

## 七、调试与测试

### 7.1 查看技能加载状态

在工作台点击 **⚡** 打开技能抽屉，查看所有已加载的技能及其状态。

### 7.2 验证 Frontmatter

Skill 文件的 YAML frontmatter 必须正确解析。如果解析失败，技能会被静默跳过。可以在服务器日志中查看加载错误。

### 7.3 测试技能触发

1. 在对话中描述与技能 `description` 匹配的任务
2. 观察模型是否调用 `Skill` 元工具
3. 检查技能指令是否出现在后续回复中

> 注意：本地小模型可能不支持 `tool_calls`，导致无法触发非 `alwaysApply` 的技能。建议使用 7B 以上模型。

## 八、最佳实践

1. **描述要具体** — `description` 决定模型何时调用技能，避免模糊描述
2. **指令要简洁** — Body 内容消耗 token，保持精炼
3. **globs 要准确** — 限制适用文件范围，避免不必要加载
4. **alwaysApply 慎用** — 仅用于必须每次生效的规则
5. **项目级优先** — 项目特定技能放 `.doc77/skills/`，通用技能放 `~/.doc77/skills/`
6. **版本管理** — 项目级 Skill 应纳入 Git 版本控制

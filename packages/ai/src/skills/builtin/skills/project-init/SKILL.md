---
name: project-init
description: >-
  项目初始化向导。帮助新项目创建标准目录结构、配置文件、文档模板。
  适用于新建项目或标准化现有项目结构的场景。
always_apply: false
---

# 项目初始化技能

## 标准目录结构
根据项目类型创建以下结构：

### 文档项目
```
project-root/
├── README.md           # 项目说明
├── docs/               # 文档目录
│   ├── guide/          # 使用指南
│   ├── api/            # API 文档
│   └── changelog/      # 更新日志
├── .doc77/
│   └── rules/          # 项目规则
└── templates/          # 文档模板
```

### 代码项目
```
project-root/
├── README.md
├── docs/
├── src/
├── tests/
├── .doc77/
│   └── rules/
└── package.json / Cargo.toml / pyproject.toml
```

## 初始化步骤
1. 检测项目类型（通过已有文件判断）
2. 创建缺失的标准目录
3. 生成 README.md 模板（项目名、简介、安装、使用）
4. 创建 .doc77/rules/ 目录
5. 生成默认规则文件（编码风格、文档规范）

## README 模板
```markdown
# 项目名称

简要描述项目用途。

## 安装

## 使用方法

## 配置

## 贡献指南

## 许可证
```

## 注意事项
- 不覆盖已存在的文件
- 保持现有目录结构不变，仅添加缺失部分
- 询问用户确认后再执行写入操作

#!/usr/bin/env bash
#
# Doc77 npm 选择性发布脚本
#
# 用法:
#   bash scripts/publish.sh core                  # 仅发布 core (patch)
#   bash scripts/publish.sh core mcp              # 发布 core + mcp (patch)
#   bash scripts/publish.sh cli minor             # 发布 cli (minor bump)
#   bash scripts/publish.sh --all patch           # 发布全部 (patch)
#   bash scripts/publish.sh --dry-run core        # 预览，不实际发布
#
# 依赖链规则（core 变更时自动级联下游）:
#   core → mcp → ai → cli
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# === 依赖关系 ===
# 格式: "pkg:dep1,dep2,..."
declare -A DEPS_OF=(               # 谁依赖谁（反转依赖：下游 → 上游）
  [core]=""
  [mcp]="core"
  [ai]="core,mcp"
  [cli]="core,mcp,ai"
)
declare -A DOWNSTREAM=(            # 谁被谁依赖（上游 → 下游）
  [core]="mcp,ai,cli"
  [mcp]="ai,cli"
  [ai]="cli"
  [cli]=""
)
PUBLISH_ORDER=(core mcp ai cli)   # 拓扑序

# === 参数解析 ===
DRY_RUN=false
BUMP="patch"
declare -a TARGETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --all)     TARGETS=("${PUBLISH_ORDER[@]}"); shift ;;
    --bump)    BUMP="$2"; shift 2 ;;
    patch|minor|major) BUMP="$1"; shift ;;
    core|mcp|ai|cli)   TARGETS+=("$1"); shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "Usage: bash scripts/publish.sh [--all|--dry-run] [--bump patch|minor|major] [core] [mcp] [ai] [cli]"
  echo ""
  echo "Examples:"
  echo "  bash scripts/publish.sh core              # 仅发布 core"
  echo "  bash scripts/publish.sh mcp patch         # 发布 mcp (自动含 core)"
  echo "  bash scripts/publish.sh cli minor         # 发布 cli (minor)"
  echo "  bash scripts/publish.sh --all patch       # 全部发布"
  echo "  bash scripts/publish.sh --dry-run core    # 预览"
  exit 1
fi

# === 解析依赖链: 上游包变更 → 下游包也需要 bump 版本号 ===
declare -A NEED_BUMP=()
declare -A NEED_PUBLISH=()

# 标记用户指定要发布的包
for pkg in "${TARGETS[@]}"; do
  NEED_PUBLISH["$pkg"]=1
  # 标记上游依赖需要 bump 版本号
  for dep in ${DEPS_OF[$pkg]//,/ }; do
    [[ -n "$dep" ]] && NEED_BUMP["$dep"]=1
  done
done

# 级联: 如果上游需要发布，下游也发布（因为依赖版本变了）
for pkg in "${PUBLISH_ORDER[@]}"; do
  if [[ -n "${NEED_PUBLISH[$pkg]:-}" ]]; then
    for down in ${DOWNSTREAM[$pkg]//,/ }; do
      [[ -n "$down" ]] && NEED_PUBLISH["$down"]=1
    done
  fi
done

# 构建最终发布列表（拓扑序）
declare -a PUBLISH_LIST=()
for pkg in "${PUBLISH_ORDER[@]}"; do
  if [[ -n "${NEED_PUBLISH[$pkg]:-}" ]]; then
    PUBLISH_LIST+=("$pkg")
  fi
done

# === 预览 ===
echo "=========================================="
echo "  Doc77 选择性发布"
echo "=========================================="
echo "  Bump 类型 : $BUMP"
echo "  Dry run   : $DRY_RUN"
echo "  发布队列  : ${PUBLISH_LIST[*]:-(none)}"
echo "=========================================="
echo ""

if $DRY_RUN; then
  echo "[DRY RUN] 不会实际发布"
  for pkg in "${PUBLISH_LIST[@]}"; do
    local_ver=$(node -p "require('./packages/$pkg/package.json').version")
    echo "  $pkg: $local_ver → $(node -pe "const v=require('./packages/$pkg/package.json').version.split('.');v[2]=parseInt(v[2])+1;v.join('.')")"
  done
  exit 0
fi

# === 发布前检查 ===
echo "==> 构建所有包..."
pnpm build

echo ""
echo "==> 运行测试..."
pnpm test || { echo "[ERROR] 测试失败，取消发布"; exit 1; }

# === 按顺序发布 ===
for pkg in "${PUBLISH_LIST[@]}"; do
  echo ""
  echo "=========================================="
  echo "  > 发布 @doc77/$pkg"
  echo "=========================================="

  cd "$ROOT/packages/$pkg"

  # Bump version
  new_ver=$(npm version "$BUMP" --no-git-tag-version 2>&1)
  echo "  版本: $(node -p "require('./package.json').version")"

  # Publish
  if [[ "$pkg" == "cli" ]]; then
    pnpm publish --no-git-checks
  else
    pnpm publish --access public --no-git-checks
  fi

  echo "  ✅ @doc77/$pkg 发布完成"
done

# === 汇总 ===
echo ""
echo "=========================================="
echo "  发布完成"
echo "=========================================="
for pkg in "${PUBLISH_ORDER[@]}"; do
  local_ver=$(node -p "require('./packages/$pkg/package.json').version")
  echo "  @doc77/$pkg : $local_ver"
done
echo ""
echo "  建议: 更新 CHANGELOG.md 记录本次变更"

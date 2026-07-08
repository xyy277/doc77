#!/usr/bin/env bash
# Doc77 npm 发布脚本
# 使用方法: bash scripts/publish.sh [patch|minor|major]
# 前置条件: npm login (先执行 npm login --registry https://registry.npmjs.org)

set -euo pipefail

BUMP="${1:-patch}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Bumping version: $BUMP"
echo "==> Building all packages..."
pnpm build

echo "==> Running tests..."
pnpm test

echo ""
echo "==> Publishing packages in dependency order..."

# 1. @doc77/core (无内部依赖)
echo ""
echo "--- @doc77/core ---"
cd packages/core
npm version "$BUMP" --no-git-tag-version
pnpm publish --access public --no-git-checks
cd "$ROOT_DIR"

# 2. @doc77/mcp (依赖 core)
echo ""
echo "--- @doc77/mcp ---"
cd packages/mcp
npm version "$BUMP" --no-git-tag-version
pnpm publish --access public --no-git-checks
cd "$ROOT_DIR"

# 3. @doc77/ai (依赖 core + mcp)
echo ""
echo "--- @doc77/ai ---"
cd packages/ai
npm version "$BUMP" --no-git-tag-version
pnpm publish --access public --no-git-checks
cd "$ROOT_DIR"

# 4. doc77 CLI (依赖全部)
echo ""
echo "--- doc77 ---"
cd packages/cli
npm version "$BUMP" --no-git-tag-version
pnpm publish --no-git-checks
cd "$ROOT_DIR"

echo ""
echo "==> Published! Versions:"
echo "  @doc77/core: $(node -p "require('./packages/core/package.json').version")"
echo "  @doc77/mcp:  $(node -p "require('./packages/mcp/package.json').version")"
echo "  @doc77/ai:   $(node -p "require('./packages/ai/package.json').version")"
echo "  doc77:       $(node -p "require('./packages/cli/package.json').version")"
echo ""
echo "==> Done. Users can now run: npm install -g doc77"

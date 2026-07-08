#!/usr/bin/env bash
# Doc77 便携包构建脚本
# 生成包含 Node 运行时的独立发布包，用户无需安装 Node.js
# 使用方法: bash scripts/build-portable.sh [linux|macos|windows]
# 输出: release/doc77-{version}-{platform}.tar.gz (或 .zip for Windows)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PLATFORM="${1:-linux}"
VERSION=$(node -p "require('./packages/cli/package.json').version")
RELEASE_DIR="release/doc77-${VERSION}-${PLATFORM}"
NODE_VERSION="v24.15.0"  # Match current dev Node version

echo "==> Building Doc77 v${VERSION} portable for ${PLATFORM}"

# 1. Clean and build
echo "==> Building packages..."
rm -rf "$RELEASE_DIR"
pnpm build

# 2. Create release directory
mkdir -p "$RELEASE_DIR"/{bin,dist,node_modules}

# 3. Download Node.js binary for target platform
echo "==> Downloading Node.js ${NODE_VERSION} for ${PLATFORM}..."
case "$PLATFORM" in
  linux)
    NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
    NODE_ARCHIVE="node.tar.xz"
    ;;
  macos)
    NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-arm64.tar.gz"
    NODE_ARCHIVE="node.tar.gz"
    ;;
  windows)
    NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip"
    NODE_ARCHIVE="node.zip"
    ;;
  *)
    echo "Unknown platform: $PLATFORM (use: linux, macos, windows)"
    exit 1
    ;;
esac

NODE_DOWNLOAD_DIR="/tmp/doc77-node-${PLATFORM}"
if [ ! -f "$NODE_DOWNLOAD_DIR/node-${NODE_VERSION}-${PLATFORM}-x64/bin/node" ] && [ ! -f "$NODE_DOWNLOAD_DIR/node.exe" ]; then
  mkdir -p "$NODE_DOWNLOAD_DIR"
  curl -fsSL "$NODE_URL" -o "$NODE_DOWNLOAD_DIR/$NODE_ARCHIVE"
  if [[ "$NODE_ARCHIVE" == *.tar.xz ]]; then
    tar -xJf "$NODE_DOWNLOAD_DIR/$NODE_ARCHIVE" -C "$NODE_DOWNLOAD_DIR"
  elif [[ "$NODE_ARCHIVE" == *.tar.gz ]]; then
    tar -xzf "$NODE_DOWNLOAD_DIR/$NODE_ARCHIVE" -C "$NODE_DOWNLOAD_DIR"
  else
    unzip -qo "$NODE_DOWNLOAD_DIR/$NODE_ARCHIVE" -d "$NODE_DOWNLOAD_DIR"
  fi
  rm "$NODE_DOWNLOAD_DIR/$NODE_ARCHIVE"
fi

# 4. Copy Node binary
echo "==> Copying Node runtime..."
if [ "$PLATFORM" = "windows" ]; then
  NODE_BIN_DIR=$(find "$NODE_DOWNLOAD_DIR" -name "node.exe" -exec dirname {} \; | head -1)
  cp "$NODE_BIN_DIR/node.exe" "$RELEASE_DIR/bin/"
  # Copy DLL if exists
  cp "$NODE_BIN_DIR"/*.dll "$RELEASE_DIR/bin/" 2>/dev/null || true
else
  NODE_BIN_DIR=$(find "$NODE_DOWNLOAD_DIR" -name "node" -type f -exec dirname {} \; | head -1)
  cp "$NODE_BIN_DIR/node" "$RELEASE_DIR/bin/"
fi

# 5. Copy built packages (dist only)
echo "==> Copying packages..."
for pkg in core mcp ai cli; do
  mkdir -p "$RELEASE_DIR/dist/packages/$pkg"
  cp -r "packages/$pkg/dist" "$RELEASE_DIR/dist/packages/$pkg/"
  cp "packages/$pkg/package.json" "$RELEASE_DIR/dist/packages/$pkg/"
done

# 6. Copy production node_modules
echo "==> Copying production dependencies..."
# Use pnpm to get production-only deps
pnpm deploy --filter doc77 --prod "$RELEASE_DIR/node_modules" 2>/dev/null || {
  echo "  pnpm deploy not available, copying all node_modules..."
  cp -r node_modules "$RELEASE_DIR/"
}

# 7. Create package.json at release root
cat > "$RELEASE_DIR/package.json" << PKGJSON
{
  "name": "doc77-portable",
  "version": "$VERSION",
  "description": "Doc77 — 默认安全、对话驱动的智能本地文档管理 Agent (便携版)",
  "type": "module"
}
PKGJSON

# 8. Create launcher script
if [ "$PLATFORM" = "windows" ]; then
  cat > "$RELEASE_DIR/doc77.bat" << 'BAT'
@echo off
set "DIR=%~dp0"
"%DIR%bin\node.exe" --experimental-specifier-resolution=node "%DIR%dist/packages/cli/dist/bin/doc77.js" %*
BAT
else
  cat > "$RELEASE_DIR/doc77" << 'SH'
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/bin/node" "$DIR/dist/packages/cli/dist/bin/doc77.js" "$@"
SH
  chmod +x "$RELEASE_DIR/doc77"
fi

# 9. Create README
cat > "$RELEASE_DIR/README.txt" << README
Doc77 v${VERSION} — 便携版 (${PLATFORM})

使用方法:
  Linux/macOS:  ./doc77 --help
  Windows:      doc77.bat --help

此版本包含 Node.js 运行时，无需额外安装。
所有数据存储在 ~/.doc77/ 目录。

更多文档: https://github.com/xyy277/doc77
README

# 10. Package
echo "==> Creating archive..."
case "$PLATFORM" in
  linux)
    tar -czf "release/doc77-${VERSION}-linux-x64.tar.gz" -C release "doc77-${VERSION}-${PLATFORM}"
    echo "   → release/doc77-${VERSION}-linux-x64.tar.gz"
    ;;
  macos)
    tar -czf "release/doc77-${VERSION}-darwin-arm64.tar.gz" -C release "doc77-${VERSION}-${PLATFORM}"
    echo "   → release/doc77-${VERSION}-darwin-arm64.tar.gz"
    ;;
  windows)
    cd release && zip -qr "doc77-${VERSION}-win-x64.zip" "doc77-${VERSION}-${PLATFORM}" && cd ..
    echo "   → release/doc77-${VERSION}-win-x64.zip"
    ;;
esac

echo ""
echo "==> Done! Portable build ready in release/"
ls -lh release/doc77-${VERSION}-*.{tar.gz,zip} 2>/dev/null || true

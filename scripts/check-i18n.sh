#!/usr/bin/env bash
# i18n 覆盖率检查：
#  1) packages/*/src 内不得存在非注释硬编码中文（白名单除外）
#  2) zh-CN.json 与 en-US.json 的 key 集合必须一致
# 用法: bash scripts/check-i18n.sh [path...]   # 无参 = 全仓扫描 + key 校验
set -uo pipefail
cd "$(dirname "$0")/.."

WHITELIST='packages/core/src/translate/models\.ts|packages/core/src/i18n/locales/|__tests__|\.test\.ts'
TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(packages/*/src)
fi

FAIL=0
HITS=$(grep -rnP '[一-龥]' "${TARGETS[@]}" \
        --include='*.ts' --include='*.js' --include='*.html' 2>/dev/null \
      | grep -Ev "$WHITELIST" \
      | grep -Ev ':[0-9]+:[[:space:]]*(//|\*|/\*|#|--|<!--)' \
      | grep -Ev 'replace\([^)]*一-鿿' || true)
if [ -n "$HITS" ]; then
  echo "❌ 发现未提取的硬编码中文（非注释）:"
  echo "$HITS"
  FAIL=1
fi

if [ $# -eq 0 ]; then
  node scripts/check-i18n-keys.mjs || FAIL=1
fi

if [ $FAIL -eq 0 ]; then
  echo "✅ check-i18n passed"
fi
exit $FAIL

#!/usr/bin/env bash
# i18n 覆盖率检查：
#  1) packages/*/src 内不得存在非注释硬编码中文（白名单除外）
#  2) zh-CN.json 与 en-US.json 的 key 集合必须一致
# 用法: bash scripts/check-i18n.sh [path...]   # 无参 = 全仓扫描 + key 校验
set -uo pipefail
cd "$(dirname "$0")/.."

WHITELIST='packages/core/src/translate/models\.ts|packages/core/src/i18n/locales/|__tests__|\.test\.ts|doc77_logo_design\.html'
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

  # 3) data-i18n 元素内不得直接嵌套子元素（applyI18n 用 textContent 替换会摧毁子节点）
  NESTED=$(grep -rnP 'data-i18n="[^"]+"[^>]*>[^<]*<(span|b|i|em|strong|code|a|button|div)\b' \
            packages/core/src/web --include='*.html' 2>/dev/null || true)
  if [ -n "$NESTED" ]; then
    echo "❌ data-i18n 元素内嵌套了子元素（textContent 替换会摧毁它们，请把 data-i18n 移到内层纯文本节点）:"
    echo "$NESTED"
    FAIL=1
  fi

  # 4) 前端 JS 禁止用 t 作为回调形参（会遮蔽全局 t()，运行时 TypeError）
  SHADOW=$(grep -rnP 'function\s*\(\s*t\s*[,)]' packages/core/src/web --include='*.js' 2>/dev/null || true)
  if [ -n "$SHADOW" ]; then
    echo "❌ 回调形参命名为 t 会遮蔽全局 i18n t()，请换名（tab/task/tag 等）:"
    echo "$SHADOW"
    FAIL=1
  fi
fi

if [ $FAIL -eq 0 ]; then
  echo "✅ check-i18n passed"
fi
exit $FAIL

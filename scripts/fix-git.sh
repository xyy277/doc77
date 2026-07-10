#!/bin/bash
cd /home/zhoujj/code/doc77
# Remove any scripts with tokens
rm -f scripts/pub-bugfix.sh scripts/clean-git.sh scripts/do-publish.sh scripts/pub-fix.sh scripts/release-fix.sh scripts/git-push.sh scripts/install-sqljs.sh scripts/restart.sh

# Squash back to clean commit (f5a332c was last clean push)
git reset --soft f5a332c
git add -A
git commit -m "fix: 修复7个代码审查Bug + sql.js迁移 + 平台感知路径

B1[CRITICAL] finally块修复
B2[HIGH] health端点保护
B3[MEDIUM] initDatabase竞态守卫
B4[MEDIUM] write.ts复用queue/enqueue
B5[LOW] update路径resolveProjectPath
B6[LOW] CLI init加loadDefaults
B7[LOW] changes用getRowsModified

better-sqlite3→sql.js(纯WASM,无编译依赖)
resolveProjectPath平台感知(Windows/WSL/Linux)
141 tests pass

Co-Authored-By: Claude <noreply@anthropic.com>"

git push origin main

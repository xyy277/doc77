#!/bin/bash
cd /home/zhoujj/code/doc77
rm -f scripts/do-publish.sh scripts/pub-fix.sh scripts/release-fix.sh scripts/git-push.sh scripts/install-sqljs.sh scripts/restart.sh
git add -A
git commit --amend -m "fix: 静态文件打包进dist + 路径fallback"
git push origin main

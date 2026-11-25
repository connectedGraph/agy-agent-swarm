#!/usr/bin/env bash
# 构建自包含的 Next.js standalone 产物：dist/standalone/server.js
set -euo pipefail
cd "$(dirname "$0")/.."

# 旧产物若不先删掉，会被构建期追踪当成项目文件再打一份进去
rm -rf dist/standalone

echo "==> next build (standalone)"
pnpm build

echo "==> 组装 dist/standalone"
mkdir -p dist
cp -a .next/standalone dist/standalone
cp -a .next/static dist/standalone/.next/static
if [ -d public ]; then cp -a public dist/standalone/public; fi

# serverExternalPackages 的追踪只带 package.json，不带包内容；
# 直接用仓库的 node_modules（相对软链），运行时与 next start 一致
rm -rf dist/standalone/node_modules
ln -s ../../node_modules dist/standalone/node_modules

echo "完成：$(pwd)/dist/standalone/server.js"
echo "启动：PORT=3100 HOSTNAME=127.0.0.1 SWARM_APP_ROOT=$(pwd) node dist/standalone/server.js"

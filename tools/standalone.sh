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

# pnpm 的外部包只有 .pnpm 里的实体，Next 没建顶层软链；
# 补上之后产物离开仓库目录也能解析 serverExternalPackages
pi_dir="$(cd .next/standalone/node_modules/.pnpm && ls -d '@earendil-works+pi-coding-agent@'* 2>/dev/null | head -1 || true)"
if [ -n "${pi_dir}" ]; then
  mkdir -p dist/standalone/node_modules/@earendil-works
  ln -sfn "../.pnpm/${pi_dir}/node_modules/@earendil-works/pi-coding-agent" \
    dist/standalone/node_modules/@earendil-works/pi-coding-agent
fi

echo "完成：$(pwd)/dist/standalone/server.js"
echo "启动：PORT=3100 HOSTNAME=127.0.0.1 SWARM_APP_ROOT=$(pwd) node dist/standalone/server.js"

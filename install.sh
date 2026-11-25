#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 检查运行时"
command -v node >/dev/null || { echo "缺少 node"; exit 1; }
command -v pnpm >/dev/null || { echo "缺少 pnpm"; exit 1; }
node -e 'const v=+process.versions.node.split(".")[0]; if(v<20){console.error("需要 Node 20+");process.exit(1)}'

echo "==> 安装依赖"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "==> 检查 agy"
AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy}"
if [ -x "$AGY_BIN" ]; then
  echo "    agy: $($AGY_BIN --version 2>/dev/null | head -1)"
else
  echo "    警告：未找到 $AGY_BIN，装好 Antigravity CLI 后设置 AGY_BIN"
fi

echo "==> 检查沙箱"
BWRAP_BIN="${BWRAP_BIN:-/usr/bin/bwrap}"
if [ "${SWARM_SANDBOX:-bwrap}" = "off" ]; then
  echo "    SWARM_SANDBOX=off，跳过 bubblewrap"
elif [ -x "$BWRAP_BIN" ]; then
  echo "    bubblewrap: $($BWRAP_BIN --version 2>/dev/null | head -1)"
else
  echo "    警告：未找到 $BWRAP_BIN，执行代理会直接运行（无文件系统隔离）"
fi

echo "==> 检查编排器模型"
PI_MODELS="$HOME/.pi/agent/models.json"
if [ -f "$PI_MODELS" ] && grep -q '127.0.0.1:8787' "$PI_MODELS"; then
  echo "    pi 已配置 8787 网关"
else
  echo "    警告：~/.pi/agent/models.json 里没有 8787 provider，编排器会起不来"
fi

echo
echo "完成。"
echo "  控制台: pnpm dev     (http://localhost:3100)"
echo "  网关:   pnpm gateway (http://127.0.0.1:9000)"

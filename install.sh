#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-}"

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

echo "==> 安装命令行"
chmod +x bin/swarm.mjs
mkdir -p "$HOME/.local/bin"
ln -sfn "$PWD/bin/swarm.mjs" "$HOME/.local/bin/swarm"
echo "    ~/.local/bin/swarm -> $PWD/bin/swarm.mjs"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "    警告：$HOME/.local/bin 不在 PATH，命令行需要在 PATH 里才能直接调用 swarm" ;;
esac

echo
if [ "$MODE" = "--service" ]; then
  echo "==> 构建 standalone 产物"
  ./tools/standalone.sh

  echo "==> 安装并启用 systemd user 单元"
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cp deploy/agy-agent-swarm.service "$UNIT_DIR/agy-agent-swarm.service"
  systemctl --user daemon-reload
  systemctl --user enable agy-agent-swarm.service
  systemctl --user restart agy-agent-swarm.service
  sleep 2
  systemctl --user --no-pager --lines=0 status agy-agent-swarm.service || true
  echo
  echo "完成。控制台: http://127.0.0.1:3100"
  echo "  命令行: swarm status / swarm chat"
  echo "  日志: journalctl --user -u agy-agent-swarm -f"
  exit 0
fi

echo "完成。"
echo "  控制台: pnpm dev     (http://localhost:3100)"
echo "  命令行: swarm tasks / swarm chat (服务没起来时会自动启动)"
echo "  常驻:   ./install.sh --service  (standalone 构建 + systemd user 单元)"
echo "  网关:   pnpm gateway (http://127.0.0.1:9000)"

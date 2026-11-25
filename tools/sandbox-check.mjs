// 沙箱自检：在 bubblewrap 里拉起 agy acp，完成 initialize + session/new 后退出。
// 不调用模型，不消耗 token。用法：node tools/sandbox-check.mjs
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "";
const AGY = process.env.AGY_BIN || join(HOME, ".local/bin/agy");
const BWRAP = process.env.BWRAP_BIN || "/usr/bin/bwrap";
const cwd = process.cwd();

if (!existsSync(BWRAP)) {
  console.error(`找不到 ${BWRAP}；安装 bubblewrap 或设置 BWRAP_BIN`);
  process.exit(1);
}
if (!existsSync(AGY)) {
  console.error(`找不到 ${AGY}；设置 AGY_BIN`);
  process.exit(1);
}

const rwHome = [
  ".cache/antigravity",
  ".config/antigravity",
  ".gemini",
  ".local/share/antigravity-tools",
  ".local/share/com.lbjlaq.antigravity-tools",
  ".local/state",
]
  .map((p) => join(HOME, p))
  .filter((p) => existsSync(p))
  .map((p) => realpathSync(p));

const real = realpathSync(cwd);
const args = [
  "--ro-bind",
  "/",
  "/",
  ...["/data", "/sys"].filter((p) => existsSync(p)).flatMap((p) => ["--ro-bind", p, p]),
  "--dev-bind",
  "/dev",
  "/dev",
  "--proc",
  "/proc",
  "--tmpfs",
  "/tmp",
  "--bind",
  real,
  real,
  ...rwHome.flatMap((p) => ["--bind", p, p]),
  "--die-with-parent",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--share-net",
  AGY,
  "acp",
  "--dangerously-skip-permissions",
];

const child = spawn(BWRAP, args, {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LANG: "C.UTF-8" },
});

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1) {
      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    } else if (msg.id === 2) {
      if (msg.result?.sessionId) {
        console.log("sandbox ok · session", msg.result.sessionId);
        child.kill("SIGTERM");
        process.exit(0);
      }
      console.error("session/new 失败：", JSON.stringify(msg.error || msg));
      process.exit(1);
    } else if (msg.id && msg.method) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(String(d).slice(0, 400)));
child.on("error", (e) => {
  console.error("启动失败：", e.message);
  process.exit(1);
});
child.on("exit", (code) => {
  console.error(`agy 提前退出（code=${code}）`);
  process.exit(1);
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "sandbox-check", version: "0" },
  },
});

setTimeout(() => {
  console.error("超时：20s 内没有完成 ACP 握手");
  child.kill("SIGKILL");
  process.exit(2);
}, 20_000);

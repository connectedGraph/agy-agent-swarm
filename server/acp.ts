import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface AgyTaskOptions {
  prompt: string;
  cwd: string;
  agentId?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  onText?: (delta: string, full: string) => void;
  onUpdate?: (update: any) => void;
}

export interface AgyTaskResult {
  text: string;
  usage: Record<string, number> | null;
  stopReason: string | null;
  elapsedMs: number;
  error?: string;
}

const AGY_BIN = process.env.AGY_BIN || `${process.env.HOME}/.local/bin/agy`;
const BWRAP_BIN = process.env.BWRAP_BIN || "/usr/bin/bwrap";
const SANDBOX_MODE = process.env.SWARM_SANDBOX || "bwrap";

// agy 在会话过程中需要写的目录；其余路径在沙箱里一律只读
const RW_HOME = [
  ".cache/antigravity",
  ".config/antigravity",
  ".gemini",
  ".local/share/antigravity-tools",
  ".local/share/com.lbjlaq.antigravity-tools",
  ".local/state",
];

/* bubblewrap 沙箱：根文件系统只读，只有 worktree 与 agy 自己的状态目录可写。
   网络保持共享（模型 API 需要），PID/IPC/UTS 隔离。 */
function spawnSpec(cwd: string, extraArgs: string[]) {
  const agyArgs = ["acp", "--dangerously-skip-permissions", ...extraArgs];
  if (SANDBOX_MODE === "off" || !existsSync(/*turbopackIgnore: true*/ BWRAP_BIN)) {
    return { cmd: AGY_BIN, args: agyArgs };
  }
  try {
    const real = realpathSync(/*turbopackIgnore: true*/ cwd);
    const args = [
      "--ro-bind",
      "/",
      "/",
      ...["/data", "/sys"]
        .filter((p) => existsSync(/*turbopackIgnore: true*/ p))
        .flatMap((p) => ["--ro-bind", p, p]),
      "--dev-bind",
      "/dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
    ];
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const runUser = uid === null ? null : `/run/user/${uid}`;
    if (runUser && existsSync(/*turbopackIgnore: true*/ runUser)) args.push("--bind", runUser, runUser);
    args.push("--bind", real, real);
    const binds = new Set<string>();
    for (const rel of RW_HOME) {
      const p = join(/*turbopackIgnore: true*/ process.env.HOME || "", rel);
      if (existsSync(/*turbopackIgnore: true*/ p)) binds.add(realpathSync(/*turbopackIgnore: true*/ p));
    }
    for (const p of binds) args.push("--bind", p, p);
    args.push(
      "--die-with-parent",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--share-net",
      AGY_BIN,
      ...agyArgs,
    );
    return { cmd: BWRAP_BIN, args };
  } catch {
    return { cmd: AGY_BIN, args: agyArgs };
  }
}

export function runAgyTask(opts: AgyTaskOptions): Promise<AgyTaskResult> {
  const {
    prompt,
    cwd,
    agentId,
    extraArgs = [],
    env = {},
    timeoutMs = 600_000,
    onText,
    onUpdate,
  } = opts;

  return new Promise((resolve) => {
    const spec = spawnSpec(cwd, extraArgs);
    const child = spawn(/*turbopackIgnore: true*/ spec.cmd, spec.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LANG: "C.UTF-8", AGENT_ID: agentId || "", ...env },
    });

    let nextId = 1;
    const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
    let text = "";
    let usage: Record<string, number> | null = null;
    let stopReason: string | null = null;
    const t0 = Date.now();
    let settled = false;

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      child.kill("SIGTERM");
      resolve({ text, usage, stopReason, elapsedMs: Date.now() - t0, error });
    };

    const hardTimer = setTimeout(() => finish(`timeout after ${timeoutMs}ms`), timeoutMs);

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");

    const request = (method: string, params: unknown) => {
      const id = nextId++;
      const p = new Promise((res, rej) => {
        pending.set(id, { res, rej });
        setTimeout(() => {
          if (pending.delete(id)) rej(new Error(`timeout ${method}`));
        }, timeoutMs);
      });
      send({ jsonrpc: "2.0", id, method, params });
      return p as Promise<any>;
    };

    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && msg.method) {
          if (msg.method === "session/request_permission") {
            const opt =
              (msg.params?.options || []).find((o: any) => (o.kind || "").startsWith("allow")) ||
              msg.params?.options?.[0];
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: { outcome: { outcome: "selected", optionId: opt?.optionId } },
            });
          } else {
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } });
          }
          continue;
        }
        if (msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            p.res(msg);
          }
          continue;
        }
        const update = msg.params?.update;
        if (update) {
          onUpdate?.(update);
          if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
            text += update.content.text;
            onText?.(update.content.text, text);
          }
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", (e) => finish(String(e)));
    child.on("exit", (code) => {
      if (!settled) finish(`agy exited early (code=${code})`);
    });

    (async () => {
      try {
        await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "agy-agent-swarm", version: "0.1.0" },
        });
        const ns = await request("session/new", { cwd, mcpServers: [] });
        const sessionId = ns.result?.sessionId;
        const pr = await request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        stopReason = pr.result?.stopReason ?? null;
        usage = pr.result?.usage ?? null;
        finish();
      } catch (e: any) {
        finish(e?.message || String(e));
      }
    })();
  });
}

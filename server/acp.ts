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
  // 任务级取消：中止后先 SIGTERM，2 秒仍未退出则 SIGKILL
  signal?: AbortSignal;
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

/* bubblewrap 沙箱参数：根文件系统只读，只有 worktree 与 agy 自己的状态目录可写。
   网络保持共享（模型 API 需要），PID/IPC/UTS 隔离。
   返回的数组已经包含隔离开关，调用方在后面接上要执行的命令即可。
   返回 null 表示应直接执行（SWARM_SANDBOX=off / 找不到 bwrap / 路径不可解析）。 */
export function sandboxBinds(cwd: string): string[] | null {
  if (SANDBOX_MODE === "off" || !existsSync(/*turbopackIgnore: true*/ BWRAP_BIN)) return null;
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
    // 工作区是唯一可写的项目路径（与 agy 一致）
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
    );
    return args;
  } catch {
    return null;
  }
}

function spawnSpec(cwd: string, extraArgs: string[]) {
  const agyArgs = ["acp", "--dangerously-skip-permissions", ...extraArgs];
  const sandbox = sandboxBinds(cwd);
  if (!sandbox) return { cmd: AGY_BIN, args: agyArgs };
  return { cmd: BWRAP_BIN, args: [...sandbox, AGY_BIN, ...agyArgs] };
}

/* ---------------- 沙箱内执行任意命令（自动检查 / 契约 verify） ---------------- */

export interface SandboxRunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SandboxRunResult {
  ok: boolean;
  exitCode: number;
  output: string;
  ms: number;
  // false 表示没有沙箱、命令直接在宿主机执行（隔离退化）
  sandboxed: boolean;
  timedOut: boolean;
  aborted: boolean;
}

const OUTPUT_KEEP = 4000;
// 收集阶段的滚动上限，避免长输出把内存吃满；最终只保留最后 OUTPUT_KEEP 字符
const OUTPUT_BUFFER_MAX = 64 * 1024;

function keepTail(s: string, max: number) {
  return s.length > max ? s.slice(-max) : s;
}

/* 异步执行一条 shell 命令，供自动检查与契约 verify 使用。
   有沙箱时：bwrap 参数 + bash -lc <command>；无沙箱时直接 bash -lc <command>。
   spawn 用 detached 单独建进程组，超时/取消时 kill(-pid) 连带清掉 npm/node 子进程。 */
export function runSandboxedCommand(command: string, opts: SandboxRunOptions): Promise<SandboxRunResult> {
  const { cwd, signal, timeoutMs = 120_000 } = opts;
  const t0 = Date.now();
  const sandbox = sandboxBinds(cwd);
  const sandboxed = sandbox !== null;

  // 已取消的任务不再起进程
  if (signal?.aborted) {
    return Promise.resolve({
      ok: false,
      exitCode: -1,
      output: "已取消：命令未执行",
      ms: 0,
      sandboxed,
      timedOut: false,
      aborted: true,
    });
  }

  const cmd = sandbox ? BWRAP_BIN : "bash";
  const args = sandbox ? [...sandbox, "bash", "-lc", command] : ["-lc", command];

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(/*turbopackIgnore: true*/ cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, LANG: "C.UTF-8" },
      });
    } catch (e: any) {
      resolve({
        ok: false,
        exitCode: -1,
        output: keepTail(String(e?.message || e), OUTPUT_KEEP),
        ms: Date.now() - t0,
        sandboxed,
        timedOut: false,
        aborted: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      clearTimeout(hardTimer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      signal?.removeEventListener("abort", onAbort);
    };

    // 杀掉整个进程组；取不到组时退回只杀直接子进程
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* 已退出 */
        }
      }
    };

    // SIGKILL 之后 close 通常立刻到；万一管道被孙进程占住，2 秒后强制收尾
    const killAndWait = () => {
      killGroup("SIGKILL");
      if (!killTimer) {
        killTimer = setTimeout(() => finish(), 2000);
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const reasons: string[] = [];
      if (timedOut) reasons.push(`超时：超过 ${timeoutMs}ms，已终止整个进程组`);
      if (aborted) reasons.push("已取消：任务已中止，已终止整个进程组");
      const body = [stdout, stderr].filter(Boolean).join("\n").trim();
      // 原因放在末尾：截断保留最后 4000 字符时不会把超时/取消说明丢掉
      const output = keepTail([body, ...reasons].filter(Boolean).join("\n"), OUTPUT_KEEP) || "(无输出)";
      resolve({
        ok: !timedOut && !aborted && exitCode === 0,
        exitCode: timedOut ? 124 : aborted ? -1 : exitCode ?? -1,
        output,
        ms: Date.now() - t0,
        sandboxed,
        timedOut,
        aborted,
      });
    };

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      killAndWait();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const hardTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killAndWait();
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = keepTail(stdout + chunk, OUTPUT_BUFFER_MAX);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = keepTail(stderr + chunk, OUTPUT_BUFFER_MAX);
    });

    child.on("error", (e) => {
      stderr = keepTail(`${stderr}\n${String(e)}`, OUTPUT_BUFFER_MAX);
      finish();
    });
    // 用 close 而不是 exit：确保 stdout/stderr 已经读完
    child.on("close", (code) => {
      exitCode = code;
      finish();
    });
  });
}

export function runAgyTask(opts: AgyTaskOptions): Promise<AgyTaskResult> {
  const {
    prompt,
    cwd,
    agentId,
    extraArgs = [],
    env = {},
    timeoutMs = 600_000,
    signal,
    onText,
    onUpdate,
  } = opts;

  // 已经取消的任务不再先起进程
  if (signal?.aborted) {
    return Promise.resolve({ text: "", usage: null, stopReason: null, elapsedMs: 0, error: "已取消" });
  }

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
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      child.kill("SIGTERM");
      // 取消时进程可能对 SIGTERM 无响应，2 秒后补一刀（bwrap 自带 --die-with-parent，这里仍主动收）
      if (error === "已取消" && !exited) {
        killTimer = setTimeout(() => {
          killTimer = null;
          if (!exited) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* 已退出 */
            }
          }
        }, 2000);
        killTimer.unref?.();
      } else {
        cleanup();
      }
      resolve({ text, usage, stopReason, elapsedMs: Date.now() - t0, error });
    };

    const onAbort = () => finish("已取消");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

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
      exited = true;
      if (!settled) finish(`agy exited early (code=${code})`);
      else cleanup();
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

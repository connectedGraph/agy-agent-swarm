import { spawn } from "node:child_process";

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
    const child = spawn(AGY_BIN, ["acp", "--dangerously-skip-permissions", ...extraArgs], {
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
          clientInfo: { name: "agent-swarm", version: "0.1.0" },
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

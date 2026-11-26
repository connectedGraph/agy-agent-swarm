// Gemini 兼容录制网关：agy 用 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL 指向这里，
// 网关按虚拟 key 归属 agent，统计 token，并可按开关录制完整报文。
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.GATEWAY_PORT || 9000);
const UPSTREAM = (process.env.UPSTREAM_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
// 应用根目录在启动时固定，避免进程长期运行时 cwd 指向早已改名的旧目录；
// 录制目录可用 SWARM_GATEWAY_DIR 单独覆盖（绝对路径，或相对当前 cwd 的路径）
const APP_ROOT = process.env.SWARM_APP_ROOT || process.cwd();
const DATA_DIR = process.env.SWARM_GATEWAY_DIR || join(APP_ROOT, "data", "gateway");
// 启动时尽力建一次；此刻磁盘没挂上也不影响转发，写录制前还会再建
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch (e: any) {
  console.warn(`[gateway] 录制目录初始化失败（不影响代理转发）: ${e?.message || String(e)}`);
}

function loadUpstreamKey(): string {
  if (process.env.UPSTREAM_KEY) return process.env.UPSTREAM_KEY;
  const f = join(APP_ROOT, "data", "upstream.key");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  return "";
}
const upstreamKey = loadUpstreamKey();

let recordEnabled = process.env.GATEWAY_RECORD !== "0";
const keyToAgent = new Map<string, string>();
const calls: any[] = [];
const byAgent: Record<string, { calls: number; tokens: number }> = {};
let totalCalls = 0;
let totalTokens = 0;

function logCall(c: any) {
  calls.push(c);
  if (calls.length > 500) calls.shift();
  totalCalls++;
  totalTokens += c.totalTokens || 0;
  const aid = c.agentId || "unattributed";
  const e = (byAgent[aid] ||= { calls: 0, tokens: 0 });
  e.calls++;
  e.tokens += c.totalTokens || 0;
}

// 录制是旁路：写盘失败只记在 call.recordError 并打一条 warn，
// 绝不改 call.status，也不影响已经返回给客户端的响应
function recordCall(call: any, ck: string, body: Buffer | null, acc: string) {
  try {
    // 目录可能被删除、移动或换了挂载点，每次写之前重建，实现自愈
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, `record-${new Date().toISOString().slice(0, 10)}.jsonl`);
    appendFileSync(
      file,
      JSON.stringify({
        ...call,
        keyPrefix: ck ? ck.slice(0, 6) : null,
        request: body ? body.toString("utf8").slice(0, 200_000) : null,
        response: acc.slice(0, 200_000),
      }) + "\n",
    );
  } catch (e: any) {
    call.recordError = e?.message || String(e);
    console.warn(`[gateway] 录制失败（本次调用不受影响）: ${call.recordError}`);
  }
}

function extractUsage(text: string) {
  let prompt = 0, cand = 0, thought = 0, total = 0;
  const apply = (u: any) => {
    if (!u || typeof u !== "object") return;
    prompt = u.promptTokenCount ?? prompt;
    cand = u.candidatesTokenCount ?? cand;
    thought = u.thoughtsTokenCount ?? thought;
    total = u.totalTokenCount ?? total;
  };
  try {
    apply(JSON.parse(text)?.usageMetadata);
  } catch {
    /* 可能是 SSE */
  }
  if (!total) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*data:\s*(\{.*\})\s*$/);
      if (!m) continue;
      try {
        apply(JSON.parse(m[1])?.usageMetadata);
      } catch {
        /* ignore */
      }
    }
  }
  return { prompt, cand, thought, total: total || prompt + cand + thought };
}

function clientKey(req: any, url: URL): string {
  const h = req.headers["x-goog-api-key"];
  if (typeof h === "string" && h) return h;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return url.searchParams.get("key") || "";
}

// 本机来源：localhost / 127.0.0.1 / [::1]，端口不限（URL.hostname 对 IPv6 会带方括号）
function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return isLocalHostname(u.hostname);
  } catch {
    // "null"（沙箱 iframe）以及畸形 Origin 一律拒绝
    return false;
  }
}

// 只为本机来源回显 Origin；其他来源不返回任何 ACAO/允许头，任意网页无法读写本机网关。
// 统一加 Vary: Origin，避免缓存把不同来源的响应混用。
function cors(req: any, res: any) {
  res.setHeader("Vary", "Origin");
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-goog-api-key, x-agent-id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
}

// /control/* 写操作校验：有 Origin 且非本机就拒绝；无 Origin（CLI、脚本）放行
function isCrossSiteWrite(req: any): boolean {
  const origin = req.headers.origin;
  return typeof origin === "string" && !!origin && !isAllowedOrigin(origin);
}

function sendJson(req: any, res: any, code: number, obj: unknown) {
  cors(req, res);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function readBody(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    // 预检保留，但只有本机 Origin 才会拿到 ACAO/允许头（cors 内部判断）
    cors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- 控制面 ----
  if (url.pathname === "/control/state") {
    return sendJson(req, res, 200, {
      enabled: recordEnabled,
      upstream: UPSTREAM,
      hasUpstreamKey: !!upstreamKey,
      stats: { totalCalls, totalTokens, byAgent, recent: calls.slice(-40) },
      keys: [...keyToAgent.entries()].map(([k, a]) => ({ key: k.slice(0, 6) + "…", agentId: a })),
    });
  }
  if (url.pathname === "/control/record" && req.method === "POST") {
    if (isCrossSiteWrite(req)) return sendJson(req, res, 403, { error: "已拒绝跨站写请求" });
    const body = await readBody(req);
    try {
      const j = JSON.parse(body.toString() || "{}");
      recordEnabled = !!j.enabled;
    } catch {
      /* ignore */
    }
    return sendJson(req, res, 200, { enabled: recordEnabled });
  }
  if (url.pathname === "/control/keys" && req.method === "POST") {
    if (isCrossSiteWrite(req)) return sendJson(req, res, 403, { error: "已拒绝跨站写请求" });
    const body = await readBody(req);
    try {
      const j = JSON.parse(body.toString() || "{}");
      if (j.key && j.agentId) keyToAgent.set(j.key, j.agentId);
    } catch {
      /* ignore */
    }
    return sendJson(req, res, 200, { ok: true });
  }
  if (url.pathname === "/health") {
    return sendJson(req, res, 200, { ok: true, upstream: UPSTREAM, recordEnabled });
  }

  // ---- Gemini 代理 ----
  const t0 = Date.now();
  const modelMatch = url.pathname.match(/models\/([^/:]+):(\w+)/);
  const model = modelMatch?.[1] || "unknown";
  const action = modelMatch?.[2] || "";
  const ck = clientKey(req, url);
  const agentId = keyToAgent.get(ck) || (req.headers["x-agent-id"] as string) || null;

  const body = req.method === "POST" ? await readBody(req) : null;

  // 上游 key 替换
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "content-length", "connection", "accept-encoding"].includes(k)) continue;
    if (k === "x-goog-api-key" || k === "authorization") continue;
    if (typeof v === "string") headers[k] = v;
  }
  const finalKey = upstreamKey || ck;
  if (finalKey) headers["x-goog-api-key"] = finalKey;

  const upstreamUrl = new URL(UPSTREAM + url.pathname);
  for (const [k, v] of url.searchParams) if (k !== "key") upstreamUrl.searchParams.set(k, v);

  let call: any = {
    at: Date.now(),
    method: req.method,
    model,
    action,
    agentId,
    status: 0,
    ms: 0,
    promptTokens: 0,
    candidateTokens: 0,
    thoughtTokens: 0,
    totalTokens: 0,
    recorded: recordEnabled,
  };

  let acc = "";
  try {
    const up = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: body && body.length ? new Uint8Array(body) : undefined,
    });
    call.status = up.status;
    const ct = up.headers.get("content-type") || "application/json";
    cors(req, res);
    res.writeHead(up.status, { "content-type": ct, "cache-control": "no-cache" });

    if (up.body) {
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const s = dec.decode(value, { stream: true });
        acc += s;
        res.write(value);
      }
    }
    res.end();
    call.ms = Date.now() - t0;
    const u = extractUsage(acc);
    call.promptTokens = u.prompt;
    call.candidateTokens = u.cand;
    call.thoughtTokens = u.thought;
    call.totalTokens = u.total || u.prompt + u.cand + u.thought;
    logCall(call);
  } catch (e: any) {
    call.status = 502;
    call.ms = Date.now() - t0;
    call.error = e?.message || String(e);
    logCall(call);
    if (!res.headersSent) sendJson(req, res, 502, { error: { code: 502, message: `gateway upstream error: ${call.error}` } });
    else res.end();
  }

  // 录制放在主 try 之外：调用本身失败也留档，而录制失败只落到 call.recordError，不污染状态码和响应
  if (recordEnabled) recordCall(call, ck, body, acc);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[gateway] http://127.0.0.1:${PORT} → ${UPSTREAM} (record=${recordEnabled}, upstreamKey=${upstreamKey ? "set" : "none"})`);
});

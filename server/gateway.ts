// Gemini 兼容录制网关：agy 用 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL 指向这里，
// 网关按虚拟 key 归属 agent，统计 token，并可按开关录制完整报文。
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.GATEWAY_PORT || 9000);
const UPSTREAM = (process.env.UPSTREAM_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
const DATA_DIR = join(process.cwd(), "data", "gateway");
mkdirSync(DATA_DIR, { recursive: true });

function loadUpstreamKey(): string {
  if (process.env.UPSTREAM_KEY) return process.env.UPSTREAM_KEY;
  const f = join(process.cwd(), "data", "upstream.key");
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

function cors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-goog-api-key, x-agent-id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res: any, code: number, obj: unknown) {
  cors(res);
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
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- 控制面 ----
  if (url.pathname === "/control/state") {
    return sendJson(res, 200, {
      enabled: recordEnabled,
      upstream: UPSTREAM,
      hasUpstreamKey: !!upstreamKey,
      stats: { totalCalls, totalTokens, byAgent, recent: calls.slice(-40) },
      keys: [...keyToAgent.entries()].map(([k, a]) => ({ key: k.slice(0, 6) + "…", agentId: a })),
    });
  }
  if (url.pathname === "/control/record" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const j = JSON.parse(body.toString() || "{}");
      recordEnabled = !!j.enabled;
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { enabled: recordEnabled });
  }
  if (url.pathname === "/control/keys" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const j = JSON.parse(body.toString() || "{}");
      if (j.key && j.agentId) keyToAgent.set(j.key, j.agentId);
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, upstream: UPSTREAM, recordEnabled });
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

  try {
    const up = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: body && body.length ? new Uint8Array(body) : undefined,
    });
    call.status = up.status;
    const ct = up.headers.get("content-type") || "application/json";
    cors(res);
    res.writeHead(up.status, { "content-type": ct, "cache-control": "no-cache" });

    let acc = "";
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

    if (recordEnabled) {
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
    }
  } catch (e: any) {
    call.status = 502;
    call.ms = Date.now() - t0;
    call.error = e?.message || String(e);
    logCall(call);
    if (!res.headersSent) sendJson(res, 502, { error: { code: 502, message: `gateway upstream error: ${call.error}` } });
    else res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[gateway] http://127.0.0.1:${PORT} → ${UPSTREAM} (record=${recordEnabled}, upstreamKey=${upstreamKey ? "set" : "none"})`);
});

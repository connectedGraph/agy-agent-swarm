#!/usr/bin/env node
/**
 * swarm — agy-agent-swarm 命令行客户端。
 *
 * 设计原则：CLI 不复制编排逻辑，只做服务器的瘦客户端。
 * 会话、规划、执行、取消、验证、合入都走已有的 /api；服务没起来时 `swarm up`
 * 负责启动（优先 systemd，其次 standalone 后台进程）。这样终端、网页和别的脚本
 * 看到的是同一份状态，不会出现两套任务表。
 *
 * 依赖：Node 22+（原生 fetch / ReadableStream），无第三方包。
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.SWARM_APP_ROOT || resolve(dirname(SELF), "..");
const DEFAULT_URL = (process.env.SWARM_URL || `http://127.0.0.1:${process.env.SWARM_PORT || 3100}`).replace(/\/+$/, "");
const CLI_DIR = join(ROOT, "data", "cli");
const UNIT = "agy-agent-swarm";

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

let BASE = DEFAULT_URL;
let JSON_MODE = false;
let QUIET = false;
let colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

// 同一份代码可能同时跑 3100 与 3111 两个实例；pid/日志按端口分开，避免 down 杀错进程
function cliPort() {
  try {
    return new URL(BASE).port || "3100";
  } catch {
    return process.env.SWARM_PORT || "3100";
  }
}

function pidFile() {
  return join(CLI_DIR, `server-${cliPort()}.pid`);
}

function logFile() {
  return join(CLI_DIR, `server-${cliPort()}.log`);
}

// 管道接到 head/less 时提前关闭是正常用法，不要吐 EPIPE 栈
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e?.code === "EPIPE") process.exit(0);
    throw e;
  });
}

/* ---------------- 参数 ---------------- */

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

class ApiError extends CliError {
  constructor(status, message) {
    super(message, 1);
    this.name = "ApiError";
    this.status = status;
  }
}

const VALUE_OPTS = new Set([
  "url",
  "agents",
  "chat",
  "title",
  "repo",
  "goal",
  "message",
  "timeout",
  "tail",
  "limit",
  "agent",
]);
const BOOL_OPTS = new Set([
  "json",
  "quiet",
  "verbose",
  "help",
  "version",
  "follow",
  "detach",
  "force",
  "dev",
  "full",
  "all",
  "live",
  "last",
  "yes",
  "color",
  "autostart",
  "with-tasks",
]);
const SHORT = {
  n: "agents",
  c: "chat",
  t: "title",
  r: "repo",
  g: "goal",
  m: "message",
  f: "follow",
  j: "json",
  q: "quiet",
  v: "verbose",
  y: "yes",
  h: "help",
  a: "agent",
};

function parseArgv(argv) {
  const pos = [];
  const opts = Object.create(null);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      let key = arg.slice(2);
      let val;
      const eq = key.indexOf("=");
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (key.startsWith("no-")) {
        const base = key.slice(3);
        if (!BOOL_OPTS.has(base)) throw new CliError(`未知选项 --${key}`);
        opts[base] = false;
        continue;
      }
      if (!VALUE_OPTS.has(key) && !BOOL_OPTS.has(key)) throw new CliError(`未知选项 --${key}`);
      if (val === undefined && VALUE_OPTS.has(key)) {
        if (i + 1 >= argv.length) throw new CliError(`--${key} 需要一个值`);
        val = argv[++i];
      }
      opts[key] = val === undefined ? true : val;
      continue;
    }
    const m = /^-([A-Za-z])(?:=(.*))?$/.exec(arg);
    if (m) {
      const key = SHORT[m[1]];
      if (!key) throw new CliError(`未知选项 ${arg}`);
      let val = m[2];
      if (val === undefined && VALUE_OPTS.has(key)) {
        if (i + 1 >= argv.length) throw new CliError(`-${m[1]} 需要一个值`);
        val = argv[++i];
      }
      opts[key] = val === undefined ? true : val;
      continue;
    }
    pos.push(arg);
  }
  return { pos, opts };
}

function num(value, fallback) {
  if (value === undefined || value === true || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* ---------------- 输出 ---------------- */

function paint(code, text) {
  return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const C = {
  dim: (s) => paint(2, s),
  bold: (s) => paint(1, s),
  green: (s) => paint(32, s),
  red: (s) => paint(31, s),
  yellow: (s) => paint(33, s),
  cyan: (s) => paint(36, s),
  magenta: (s) => paint(35, s),
};
const TONE = {
  ok: C.green,
  bad: C.red,
  warn: C.yellow,
  accent: C.cyan,
  neutral: C.dim,
};

function out(text) {
  process.stdout.write(text);
}

// 进度与人类可读输出：--json 时改走 stderr，stdout 只留最终 JSON
function line(text = "") {
  (JSON_MODE ? process.stderr : process.stdout).write(`${text}\n`);
}

function notice(text) {
  process.stderr.write(`${C.dim(text)}\n`);
}

function result(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/* ---------------- 宽度 / 时间 / 数字 ---------------- */

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u;

function charWidth(ch) {
  return WIDE.test(ch) ? 2 : 1;
}

function displayWidth(text) {
  let n = 0;
  for (const ch of String(text)) n += charWidth(ch);
  return n;
}

function padEndW(text, width) {
  const s = String(text);
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

function cutW(text, width, tail = "…") {
  const s = String(text);
  if (displayWidth(s) <= width) return s;
  let acc = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > width - displayWidth(tail)) break;
    acc += ch;
    w += cw;
  }
  return acc + tail;
}

function clipLine(text, width) {
  return cutW(String(text || "").replace(/\s+/g, " ").trim(), width);
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function clock(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function relTime(ts, now = Date.now()) {
  if (!ts) return "";
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(ts);
  const hm = clock(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const that = new Date(ts);
  that.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (days <= 0) return hm;
  if (days === 1) return `昨天 ${hm}`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

function fullTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}:${pad2(d.getSeconds())}`;
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

function tailText(text, chars) {
  const s = String(text || "");
  if (s.length <= chars) return s;
  return `…（前 ${s.length - chars} 字符已省略）\n${s.slice(-chars)}`;
}

function headText(text, chars) {
  const s = String(text || "");
  if (s.length <= chars) return s;
  return `${s.slice(0, chars)}\n…（后 ${s.length - chars} 字符已省略）`;
}

function firstNonEmptyLine(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) || "";
}

/* ---------------- 任务状态 ---------------- */

const LIVE_STATES = new Set(["planning", "running", "merging", "verifying", "rework", "aggregating"]);
const TERMINAL_AGENT = new Set(["done", "failed", "cancelled"]);

const STATE_LABEL = {
  queued: "排队",
  booting: "启动",
  working: "执行中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
  planning: "规划中",
  running: "集群执行",
  merging: "合并中",
  verifying: "验证中",
  rework: "返工中",
  aggregating: "汇总中",
};

const STATE_TONE = {
  queued: "neutral",
  booting: "accent",
  working: "accent",
  done: "ok",
  failed: "bad",
  cancelled: "warn",
  planning: "warn",
  running: "accent",
  merging: "accent",
  verifying: "accent",
  rework: "warn",
  aggregating: "accent",
};

export function isTerminal(state) {
  return state === "done" || state === "failed" || state === "cancelled";
}

function isLive(state) {
  return LIVE_STATES.has(state);
}

export function displayState(task) {
  if (task.state === "cancelled") return { label: "已取消", tone: "warn", live: false };
  if (task.state === "failed") return { label: "失败", tone: "bad", live: false };
  if (task.state === "done") {
    if (task.verdict) {
      return task.verdict.pass
        ? { label: "完成", tone: "ok", live: false }
        : { label: "未通过", tone: "bad", live: false };
    }
    if (task.error) return { label: "失败", tone: "bad", live: false };
    return { label: "完成", tone: "ok", live: false };
  }
  return {
    label: STATE_LABEL[task.state] || task.state,
    tone: STATE_TONE[task.state] || "neutral",
    live: isLive(task.state),
  };
}

function stateText(task) {
  const d = displayState(task);
  return TONE[d.tone](d.label);
}

function usageTotal(agent) {
  return agent.spent || agent.usage?.totalTokens || 0;
}

function agentStateText(agent) {
  const label = STATE_LABEL[agent.state] || agent.state;
  return TONE[STATE_TONE[agent.state] || "neutral"](label);
}

function taskDuration(task) {
  return (task.finishedAt || Date.now()) - task.createdAt;
}

function taskExitCode(task) {
  if (!task) return 1;
  if (task.state === "done") return task.verdict?.pass ? 0 : 2;
  return 1;
}

/* ---------------- HTTP ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", body, timeout = 30_000 } = {}) {
  const ctrl = new AbortController();
  const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) throw new ApiError(res.status, data?.error || `${res.status} ${res.statusText}`);
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e?.name === "AbortError") throw new CliError(`请求超时（${Math.round(timeout / 1000)} 秒）：${path}`);
    throw new CliError(`无法连接 ${BASE}：${e?.cause?.code || e?.message || e}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probe(timeout = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
    if (res.ok) return await res.json();
    // 旧版服务没有 /api/health：退回到会话列表探测，CLI 仍可使用
    if (res.status === 404) {
      const r2 = await fetch(`${BASE}/api/chats`, { signal: ctrl.signal });
      if (r2.ok) return { ok: true, legacy: true };
    }
  } catch {
    /* 不可达 */
  } finally {
    clearTimeout(timer);
  }
  return null;
}

async function fetchChats() {
  return (await api("/api/chats")).chats || [];
}

async function fetchTasks() {
  return (await api("/api/tasks")).tasks || [];
}

async function getChat(id) {
  return (await api(`/api/chats/${encodeURIComponent(id)}`)).chat;
}

async function getTask(id) {
  return (await api(`/api/tasks/${encodeURIComponent(id)}`)).task;
}

/* ---------------- SSE ---------------- */

class EventStream {
  constructor() {
    this.lastId = null;
    this.subs = new Set();
    this.stopped = false;
    this.retry = 600;
    this.ctrl = null;
    this.readyDone = false;
    this.ready = new Promise((res) => {
      this.resolveReady = res;
    });
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  start() {
    void this.loop();
    return this;
  }

  stop() {
    this.stopped = true;
    try {
      this.ctrl?.abort();
    } catch {
      /* 已断开 */
    }
  }

  emit(ev) {
    if (!this.readyDone) {
      this.readyDone = true;
      this.resolveReady();
    }
    for (const fn of [...this.subs]) {
      try {
        fn(ev);
      } catch (e) {
        notice(`事件处理失败：${e?.message || e}`);
      }
    }
  }

  async loop() {
    while (!this.stopped) {
      this.ctrl = new AbortController();
      try {
        const headers = { accept: "text/event-stream" };
        if (this.lastId !== null) headers["last-event-id"] = String(this.lastId);
        const res = await fetch(`${BASE}/api/stream`, { headers, signal: this.ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        this.retry = 600;
        await this.consume(res.body);
      } catch {
        /* 断线后重连 */
      }
      if (this.stopped) break;
      await sleep(this.retry);
      this.retry = Math.min(this.retry * 2, 5000);
    }
  }

  async consume(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m = /\r?\n\r?\n/.exec(buf);
      while (m) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        this.parseBlock(block);
        m = /\r?\n\r?\n/.exec(buf);
      }
    }
  }

  parseBlock(block) {
    let id = null;
    const data = [];
    for (const raw of block.split(/\r?\n/)) {
      if (!raw || raw.startsWith(":")) continue;
      const colon = raw.indexOf(":");
      const field = colon < 0 ? raw : raw.slice(0, colon);
      let val = colon < 0 ? "" : raw.slice(colon + 1);
      if (val.startsWith(" ")) val = val.slice(1);
      if (field === "id") {
        const n = Number(val);
        if (Number.isFinite(n)) id = n;
      } else if (field === "data") {
        data.push(val);
      }
    }
    if (!data.length) return;
    let ev;
    try {
      ev = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (id !== null) this.lastId = id;
    this.emit(ev);
  }
}

function withTimeout(promise, ms, label = "操作") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CliError(`${label}超时`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ---------------- 服务管理 ---------------- */

function unitInstalled() {
  return existsSync(join(homedir(), ".config", "systemd", "user", `${UNIT}.service`));
}

function run(cmd, args, options = {}) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd: ROOT, ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => res({ code: 127, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => res({ code: code ?? 0, stdout, stderr }));
  });
}

function readPid() {
  try {
    const n = Number(readFileSync(pidFile(), "utf8").trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUp(ms, child) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) return false;
    if (await probe(700)) return true;
    await sleep(400);
  }
  return false;
}

async function waitDown(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await probe(500))) return true;
    await sleep(300);
  }
  return !(await probe(500));
}

function serverEnv() {
  return {
    ...process.env,
    SWARM_APP_ROOT: ROOT,
    PORT: cliPort(),
    HOSTNAME: "127.0.0.1",
    SWARM_TASKS_DIR: process.env.SWARM_TASKS_DIR || join(ROOT, "data", "tasks"),
    SWARM_ROOT: process.env.SWARM_ROOT || join(ROOT, "data", "runs"),
    AGY_BIN: process.env.AGY_BIN || join(homedir(), ".local", "bin", "agy"),
    BWRAP_BIN: process.env.BWRAP_BIN || "/usr/bin/bwrap",
    HOME: process.env.HOME || homedir(),
  };
}

// 不用 package.json 里的 `pnpm dev`，因为它把端口写死 3100；这里跟随 --url/SWARM_PORT
function devSpawn() {
  return { cmd: "pnpm", args: ["exec", "next", "dev", "-p", cliPort()] };
}


// 启动优先级：systemd 单元（已安装时）→ standalone 后台进程 → next dev
async function startService({ dev = false } = {}) {
  if (!dev && unitInstalled()) {
    const r = await run("systemctl", ["--user", "start", UNIT]);
    if (r.code === 0 && (await waitUp(45_000))) return true;
  }

  const stale = readPid();
  if (stale && pidAlive(stale)) {
    if (await waitUp(10_000)) return true;
    notice(`已有进程 ${stale} 但服务无响应，先 swarm down 清理`);
    return false;
  }

  mkdirSync(CLI_DIR, { recursive: true });
  const entry = join(ROOT, "dist", "standalone", "server.js");
  const standalone = !dev && existsSync(entry);
  if (!standalone && !existsSync(join(ROOT, "node_modules"))) {
    notice("既没有 standalone 产物，也没有 node_modules；先运行 ./install.sh");
    return false;
  }

  const fd = openSync(logFile(), "a");
  const cmd = standalone ? { cmd: process.execPath, args: [entry] } : devSpawn();
  const child = spawn(cmd.cmd, cmd.args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: serverEnv(),
  });
  child.on("error", (e) => notice(`启动进程失败：${e.message}`));
  child.unref();
  closeSync(fd);
  if (child.pid) writeFileSync(pidFile(), String(child.pid));

  const failed = new Promise((r) => child.once("error", r));
  const ok = await Promise.race([
    waitUp(standalone ? 60_000 : 120_000, child),
    failed.then(() => false),
  ]);
  if (ok) return true;
  notice(`启动失败，日志：${logFile()}`);
  return false;
}

async function stopService() {
  let did = false;

  if (unitInstalled()) {
    const active = await run("systemctl", ["--user", "is-active", UNIT]);
    if (active.stdout.trim() === "active") {
      await run("systemctl", ["--user", "stop", UNIT]);
      did = (await waitDown(20_000)) || did;
    }
  }

  const pid = readPid();
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
    if (!(await waitDown(10_000))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
      await waitDown(3000);
    }
    did = true;
  }
  try {
    unlinkSync(pidFile());
  } catch {
    /* 没有 pid 文件 */
  }
  return did && !(await probe(800));
}

async function ensureService(opts = {}) {
  const health = await probe();
  if (health) return health;
  if (opts.autostart === false || process.env.SWARM_NO_AUTOSTART === "1") {
    throw new CliError(`服务未运行（${BASE}）。先执行 swarm up`);
  }
  notice(`服务未运行，正在启动 ${BASE} ...`);
  const ok = await startService({ dev: !!opts.dev });
  if (!ok) throw new CliError(`服务启动失败，日志：${logFile()}`);
  const started = await probe();
  if (!started) throw new CliError(`服务已启动但无法访问 ${BASE}`);
  notice(`服务已启动（pid ${started.pid ?? "?"}）`);
  return started;
}

/* ---------------- 选择对象 ---------------- */

function expandHome(p) {
  const s = String(p);
  if (s === "~") return homedir();
  if (s.startsWith("~/")) return join(homedir(), s.slice(2));
  return s;
}

function normalizeRepo(raw) {
  return resolve(expandHome(String(raw)));
}

function checkRepo(path) {
  if (!existsSync(path)) {
    notice(`提示：${path} 不存在，执行时会新建临时仓库`);
  } else if (!existsSync(join(path, ".git"))) {
    notice(`提示：${path} 不是 git 仓库，执行时会新建临时仓库`);
  }
}

export function resolveRef(list, ref, label) {
  if (!ref) return null;
  const s = String(ref);
  if (s === "last" || s === "latest") return list[0] || null;

  let hit = list.find((x) => x.id === s);
  if (!hit) {
    const matches = list.filter((x) => x.id.startsWith(s));
    if (matches.length > 1) throw new CliError(`${label} id 前缀 ${s} 不唯一`);
    if (matches.length === 1) hit = matches[0];
  }
  if (!hit) {
    const n = Number(s);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) hit = list[n - 1];
  }
  if (!hit) throw new CliError(`找不到${label} ${s}`);
  return hit;
}

async function chatFromRef(ref) {
  return resolveRef(await fetchChats(), ref, "会话");
}

async function taskFromArgs(pos, opts, { allowLatest = false } = {}) {
  if (pos[0]) return resolveRef(await fetchTasks(), pos[0], "任务");
  if (opts.chat) {
    const chat = await chatFromRef(opts.chat);
    if (!chat?.taskId) throw new CliError("这个会话还没有执行过任务");
    return getTask(chat.taskId);
  }
  if (allowLatest) {
    const t = (await fetchTasks())[0];
    if (!t) throw new CliError("还没有任务");
    return t;
  }
  throw new CliError("需要任务 id（swarm tasks 可查看）");
}

async function createChat({ repo, title } = {}) {
  const body = {};
  if (repo) body.repoPath = normalizeRepo(repo);
  const { chat } = await api("/api/chats", { method: "POST", body });
  let next = chat;
  if (title) {
    const r = await api(`/api/chats/${chat.id}`, { method: "PATCH", body: { title: String(title) } });
    next = r.chat;
  }
  return next;
}

async function findChatForTask(taskId) {
  try {
    const chats = await fetchChats();
    return chats.find((c) => (c.taskIds || []).includes(taskId)) || null;
  } catch {
    return null;
  }
}

/* ---------------- 任务打印 ---------------- */

function printTaskTable(tasks, { live = false, limit = 20 } = {}) {
  const list = (live ? tasks.filter((t) => isLive(t.state)) : tasks).slice(0, Math.max(1, limit));
  if (!list.length) {
    line(C.dim(live ? "没有正在执行的任务。" : "还没有任务。"));
    return;
  }
  line(
    [
      C.dim(padEndW("ID", 10)),
      C.dim(padEndW("状态", 10)),
      C.dim(padEndW("代理", 8)),
      C.dim(padEndW("tokens", 10)),
      C.dim(padEndW("时间", 12)),
      C.dim("目标"),
    ].join(""),
  );
  for (const t of list) {
    const d = displayState(t);
    const ended = t.agents.filter((a) => TERMINAL_AGENT.has(a.state)).length;
    const label = padEndW(d.label, 8);
    line(
      [
        padEndW(shortId(t.id), 10),
        TONE[d.tone](label) + "  ",
        padEndW(`${ended}/${t.agents.length}`, 8),
        padEndW(fmtTokens(t.totalUsage), 10),
        padEndW(relTime(t.createdAt), 12),
        clipLine(t.goal, 70),
      ].join(""),
    );
  }
}

function printChatTable(chats, tasks) {
  if (!chats.length) {
    line(C.dim("还没有会话。swarm say \"目标\" 或 swarm new 建一个。"));
    return;
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  line(
    [
      C.dim(padEndW("ID", 10)),
      C.dim(padEndW("状态", 10)),
      C.dim(padEndW("任务", 6)),
      C.dim(padEndW("更新", 12)),
      C.dim("标题"),
    ].join(""),
  );
  for (const c of chats) {
    const latest = c.taskId ? byId.get(c.taskId) : null;
    const d = latest ? displayState(latest) : null;
    line(
      [
        padEndW(shortId(c.id), 10),
        d ? TONE[d.tone](padEndW(d.label, 8)) + "  " : padEndW("—", 8) + "  ",
        padEndW(String((c.taskIds || []).length), 6),
        padEndW(relTime(c.updatedAt), 12),
        clipLine(c.title || "未命名", 50),
      ].join(""),
    );
  }
}

function printPlan(task) {
  if (!task.boss?.planList?.length) return false;
  line();
  line(C.bold("计划"));
  task.boss.planList.forEach((p, i) => {
    line(`  ${i + 1}. ${p.name}  ${C.dim(clipLine(p.task, 90))}`);
  });
  return true;
}

function printAgents(task, { full = false } = {}) {
  line();
  line(C.bold("代理"));
  for (const a of task.agents) {
    const state = STATE_LABEL[a.state] || a.state;
    const tone = STATE_TONE[a.state] || "neutral";
    const files = a.changedFiles?.length || 0;
    line(
      `  ${padEndW(a.name, 8)} ${TONE[tone](padEndW(state, 10))} ${padEndW(`${fmtTokens(usageTotal(a))} tokens`, 14)} ${
        files ? `${files} 个文件` : C.dim("无改动")
      }`,
    );
    if (a.task) line(`           ${C.dim(clipLine(a.task, 100))}`);
    if (a.branch) line(`           ${C.dim(a.branch)}`);
    if (a.changedFiles?.length) line(`           ${C.dim(clipLine(a.changedFiles.join(", "), 120))}`);
    if (a.error) line(`           ${C.red(clipLine(a.error, 140))}`);
    if (full && a.scope?.length) line(`           ${C.dim(`scope: ${a.scope.join(", ")}`)}`);
    if (full && a.acceptance?.length) {
      for (const item of a.acceptance) line(`           ${C.dim(`验收: ${clipLine(item, 120)}`)}`);
    }
    if (full && a.evidence?.length) line(`           ${C.dim(`证据: ${clipLine(a.evidence.join("；"), 120)}`)}`);
  }
}

function printChecks(task) {
  if (!task.verification) return;
  line();
  line(`${C.bold("检查")}  ${task.verification.ok ? C.green("全部通过") : C.red("有失败项")}`);
  for (const c of task.verification.checks) {
    line(
      `  ${c.ok ? C.green("通过") : C.red("失败")}  ${padEndW(clipLine(c.name, 46), 48)} ${C.dim(
        `${c.ms}ms  exit ${c.exitCode}`,
      )}`,
    );
    if (!c.ok && c.output) line(`        ${C.dim(clipLine(firstNonEmptyLine(c.output), 120))}`);
  }
  if (task.verification.diffStat) {
    line();
    line(C.dim(task.verification.diffStat.trim()));
  }
}

function printTaskDetail(task, { full = false } = {}) {
  const d = displayState(task);
  line();
  line(`${C.bold("任务")}  ${task.id}`);
  line(`${C.bold("状态")}  ${TONE[d.tone](d.label)}`);
  line(`${C.bold("目标")}  ${clipLine(task.goal, 200)}`);
  line(`${C.bold("仓库")}  ${task.repoPath || C.dim("临时仓库")}`);
  line(
    `${C.bold("时间")}  ${fullTime(task.createdAt)}  ·  ${fmtDuration(taskDuration(task))}  ·  ${fmtTokens(
      task.totalUsage,
    )} tokens`,
  );
  line(`${C.bold("代理")}  ${task.agents.length} 个`);

  printPlan(task);
  printAgents(task, { full });
  printChecks(task);

  if (task.rework?.length) {
    line();
    line(C.bold("返工"));
    for (const r of task.rework) {
      const who = r.target === "fixer" ? "修复代理" : r.who;
      line(`  第 ${r.round} 轮  ${who}  ${r.ok ? C.green("通过") : C.red("未通过")}  ${C.dim(clipLine(r.reason, 100))}`);
      if (full && r.detail) line(C.dim(r.detail));
      if (full && r.text) line(tailText(r.text, 2000));
    }
  }

  if (task.verifier) {
    line();
    line(`${C.bold("验证器")}  ${STATE_LABEL[task.verifier.state] || task.verifier.state}  ${fmtTokens(task.verifier.usage?.totalTokens)} tokens`);
    if (full && task.verifier.text) line(tailText(task.verifier.text, 3000));
    if (task.verifier.error) line(C.red(task.verifier.error));
  }

  if (task.verdict) {
    line();
    line(`${C.bold("裁决")}  ${task.verdict.pass ? C.green("通过") : C.red("未通过")}`);
    for (const r of task.verdict.reasons || []) line(`  · ${r}`);
    if (full && task.verdict.raw) line(C.dim(tailText(task.verdict.raw, 2000)));
  }

  if (task.error) {
    line();
    line(`${C.bold("错误")}  ${C.red(task.error)}`);
  }

  if (task.summary) {
    line();
    line(C.bold("汇总"));
    line(full ? task.summary : headText(task.summary, 1500));
  }

  if (task.promote) {
    line();
    line(
      `${C.bold("合入")}  ${
        task.promote.ok
          ? C.green(`${task.promote.target} ${task.promote.commit || ""}`.trim())
          : C.red(task.promote.detail)
      }`,
    );
  }

  if (full) {
    if (task.boss?.plan) {
      line();
      line(C.bold("规划原文"));
      line(task.boss.plan);
    }
    if (task.boss?.text) {
      line();
      line(C.bold("编排器输出"));
      line(task.boss.text);
    }
    for (const a of task.agents) {
      line();
      line(`${C.bold(`代理 ${a.name}`)}  ${C.dim(a.id)}`);
      line(tailText(a.text, 3000));
    }
  }
  line();
}

function createTaskPrinter() {
  let header = false;
  let lastState = null;
  let planLen = -1;
  let checksSig = "";
  let verifierSig = "";
  let reworkLen = 0;
  let verdictSig = "";
  let finalPrinted = false;
  const agentStates = new Map();

  const agentFinal = (a) => {
    const tone = STATE_TONE[a.state] || "neutral";
    const label = STATE_LABEL[a.state] || a.state;
    const files = a.changedFiles?.length || 0;
    line(
      `  ${padEndW(a.name, 8)} ${TONE[tone](label)}  ${C.dim(
        `${fmtTokens(usageTotal(a))} tokens${files ? ` · ${files} 个文件` : ""}`,
      )}`,
    );
    if (a.state === "failed" && a.error) line(`           ${C.red(clipLine(a.error, 140))}`);
  };

  const update = (task) => {
    const d = displayState(task);

    if (!header) {
      header = true;
      lastState = task.state;
      line();
      line(`${C.bold("任务")}  ${shortId(task.id)}  ${TONE[d.tone](d.label)}  ${C.dim(relTime(task.createdAt))}`);
      line(`${C.dim("目标")}  ${clipLine(task.goal, 160)}`);
      if (task.repoPath) line(`${C.dim("仓库")}  ${task.repoPath}`);
      line(`${C.dim("代理")}  ${task.agents.length} 个`);
    } else if (task.state !== lastState) {
      lastState = task.state;
      line(`${C.dim(clock())}  状态  ${TONE[d.tone](d.label)}`);
    }

    if (task.boss?.planList?.length && task.boss.planList.length !== planLen) {
      planLen = task.boss.planList.length;
      line();
      line(C.bold("计划"));
      task.boss.planList.forEach((p, i) => line(`  ${i + 1}. ${p.name}  ${C.dim(clipLine(p.task, 90))}`));
    }

    for (const a of task.agents) {
      const prev = agentStates.get(a.id);
      if (prev === undefined) {
        agentStates.set(a.id, a.state);
        if (a.state === "working" || a.state === "booting") {
          line(`${C.dim(clock())}  ${a.name}  ${C.dim(STATE_LABEL[a.state] || a.state)}${a.task ? `  ${clipLine(a.task, 80)}` : ""}`);
        } else if (TERMINAL_AGENT.has(a.state)) {
          agentFinal(a);
        }
      } else if (prev !== a.state) {
        agentStates.set(a.id, a.state);
        if (a.state === "working") {
          line(`${C.dim(clock())}  ${a.name}  执行中${a.task ? `  ${clipLine(a.task, 80)}` : ""}`);
        } else if (TERMINAL_AGENT.has(a.state)) {
          agentFinal(a);
        }
      }
    }

    if (task.verification) {
      const sig =
        task.verification.checks.map((c) => `${c.name}|${c.ok}|${c.exitCode}|${c.ms}`).join(";") + `|${task.verification.ok}`;
      if (sig !== checksSig) {
        checksSig = sig;
        line();
        line(
          `${C.dim(clock())}  检查  ${task.verification.ok ? C.green("全部通过") : C.red("有失败项")}  ${C.dim(
            `${task.verification.checks.length} 项`,
          )}`,
        );
        for (const c of task.verification.checks) {
          line(
            `  ${c.ok ? C.green("通过") : C.red("失败")}  ${clipLine(c.name, 46)}  ${C.dim(
              `${c.ms}ms  exit ${c.exitCode}`,
            )}`,
          );
          if (!c.ok && c.output) line(`        ${C.dim(clipLine(firstNonEmptyLine(c.output), 120))}`);
        }
      }
    }

    if (task.verifier) {
      const sig = `${task.verifier.state}|${task.verifier.usage?.totalTokens || 0}`;
      if (sig !== verifierSig) {
        const wasEmpty = !verifierSig;
        verifierSig = sig;
        if (!wasEmpty && (task.verifier.state === "done" || task.verifier.state === "failed")) {
          line(
            `${C.dim(clock())}  验证器  ${task.verifier.state === "done" ? C.green("完成") : C.red("失败")}  ${C.dim(
              `${fmtTokens(task.verifier.usage?.totalTokens)} tokens`,
            )}`,
          );
        }
      }
    }

    if ((task.rework?.length || 0) > reworkLen) {
      for (const r of task.rework.slice(reworkLen)) {
        line(
          `${C.dim(clock())}  返工 第 ${r.round} 轮  ${r.target === "fixer" ? "修复代理" : r.who}  ${C.dim(
            clipLine(r.reason, 100),
          )}`,
        );
      }
      reworkLen = task.rework.length;
    }

    if (task.verdict) {
      const sig = `${task.verdict.pass}|${(task.verdict.reasons || []).join("|")}`;
      if (sig !== verdictSig) {
        verdictSig = sig;
        line();
        line(`裁决  ${task.verdict.pass ? C.green("通过") : C.red("未通过")}`);
        for (const r of (task.verdict.reasons || []).slice(0, 8)) line(`  · ${r}`);
      }
    }

    if (finalPrinted) return;
    if (isTerminal(task.state)) {
      finalPrinted = true;
      printFinal(task);
    }
  };

  const printFinal = (task) => {
    const d = displayState(task);
    const ended = task.agents.filter((a) => TERMINAL_AGENT.has(a.state)).length;
    line();
    line(C.dim("─".repeat(46)));
    line(`${C.bold("任务")}  ${shortId(task.id)}  ${TONE[d.tone](d.label)}`);
    line(
      `${C.bold("代理")}  ${ended}/${task.agents.length} 结束  ·  ${fmtTokens(task.totalUsage)} tokens  ·  ${fmtDuration(
        taskDuration(task),
      )}`,
    );
    if (task.verdict) {
      line(`${C.bold("裁决")}  ${task.verdict.pass ? C.green("通过") : C.red("未通过")}`);
      for (const r of (task.verdict.reasons || []).slice(0, 5)) line(`      ${C.dim("·")} ${clipLine(r, 120)}`);
    }
    if (task.error && task.state !== "cancelled") line(`${C.bold("错误")}  ${C.red(clipLine(task.error, 140))}`);
    if (task.verifier?.state === "done" || task.verifier?.state === "failed") {
      line(
        `${C.bold("验证器")}  ${task.verifier.state === "done" ? C.green("完成") : C.red("失败")}  ${C.dim(
          `${fmtTokens(task.verifier.usage?.totalTokens)} tokens`,
        )}`,
      );
    }
    if (task.summary) line(`${C.bold("汇总")}  ${clipLine(task.summary, 160)}`);
    const p = task.promote;
    line(
      `${C.bold("合入")}  ${
        p ? (p.ok ? C.green(`${p.target} ${p.commit || ""}`.trim()) : C.red(clipLine(p.detail, 100))) : C.dim("未执行")
      }`,
    );
    line(C.dim("─".repeat(46)));
    line();
  };

  return { update, isFinal: () => finalPrinted };
}

/* ---------------- 跟随任务 ---------------- */

async function followTask(taskId, { timeoutMs = 0, signal } = {}) {
  const stream = new EventStream();
  const printer = createTaskPrinter();
  let task = null;
  let finalTask = null;
  let resolved = false;
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });

  const finish = (t) => {
    if (resolved) return;
    resolved = true;
    finalTask = t;
    resolveDone(t);
  };

  const adopt = (t) => {
    if (!t || resolved) return;
    task = t;
    printer.update(t);
    if (isTerminal(t.state)) finish(t);
  };

  const unsub = stream.subscribe((ev) => {
    if (ev.type === "snapshot") {
      const t = (ev.tasks || []).find((x) => x.id === taskId);
      if (t) adopt(t);
      else {
        line(C.red(`任务 ${shortId(taskId)} 不在当前服务里`));
        finish(null);
      }
    } else if (ev.type === "task" && ev.task?.id === taskId) {
      adopt(ev.task);
    } else if (ev.type === "task-deleted" && ev.taskId === taskId) {
      line(C.dim(`任务 ${shortId(taskId)} 已被删除`));
      finish(null);
    }
  });

  let abortResolve;
  const aborted = new Promise((r) => {
    abortResolve = r;
  });
  const onAbort = () => {
    abortResolve("aborted");
  };
  const onSigint = () => {
    abortResolve("aborted");
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  } else {
    process.once("SIGINT", onSigint);
  }

  stream.start();

  let timer = null;
  try {
    if (signal?.aborted) {
      line(C.dim(`已停止跟随；任务仍在后台运行。继续查看：swarm watch ${shortId(taskId)}`));
      return null;
    }
    await Promise.race([withTimeout(stream.ready, 12_000, "连接事件流").catch(() => {}), aborted]);
    if (resolved) return finalTask;
    if (!task) {
      const fetched = await getTask(taskId);
      if (fetched) adopt(fetched);
    }
    if (resolved) return finalTask;

    const timeoutPromise = timeoutMs
      ? new Promise((r) => {
          timer = setTimeout(() => r("timeout"), timeoutMs);
        })
      : new Promise(() => {});

    const outcome = await Promise.race([done, timeoutPromise, aborted]);
    if (outcome === "aborted") {
      line(C.dim(`已停止跟随；任务仍在后台运行。继续查看：swarm watch ${shortId(taskId)}`));
      return null;
    }
    if (outcome === "timeout") {
      line(C.dim(`等待超时；任务仍在后台运行。继续查看：swarm watch ${shortId(taskId)}`));
      return task;
    }
    return finalTask || task;
  } finally {
    if (timer) clearTimeout(timer);
    unsub();
    stream.stop();
    if (signal) signal.removeEventListener("abort", onAbort);
    else process.removeListener("SIGINT", onSigint);
  }
}

/* ---------------- 命令：服务 ---------------- */

async function cmdUp(pos, opts) {
  const running = await probe();
  if (running) {
    if (JSON_MODE) return result({ running: true, url: BASE, health: running });
    line(`服务已在运行  ${C.cyan(BASE)}  ${C.dim(`pid ${running.pid ?? "?"}`)}`);
    return;
  }
  notice(`正在启动 ${BASE} ...`);
  const ok = await startService({ dev: !!opts.dev });
  const health = ok ? await probe() : null;
  if (!health) throw new CliError(`启动失败，日志：${logFile()}`);
  if (JSON_MODE) return result({ running: true, url: BASE, health });
  line(`服务已启动  ${C.cyan(BASE)}  ${C.dim(`pid ${health.pid ?? "?"}`)}`);
  if (health.legacy) notice("当前服务没有 /api/health，版本可能较旧；CLI 仍可用。");
}

async function cmdDown() {
  const was = await probe();
  if (!was) {
    if (JSON_MODE) return result({ running: false, stopped: false });
    line(C.dim("服务本来就没有运行。"));
    return;
  }
  const stopped = await stopService();
  if (JSON_MODE) return result({ running: !stopped, stopped });
  if (stopped) line("服务已停止。");
  else line(C.yellow("没能停掉服务；它可能不是由本 CLI 或 systemd 单元启动的。"));
  if (!stopped) process.exitCode = 1;
}

async function cmdServe(pos, opts) {
  if (await probe()) throw new CliError(`端口已有服务（${BASE}），先 swarm down`);
  const entry = join(ROOT, "dist", "standalone", "server.js");
  const standalone = !opts.dev && existsSync(entry);
  if (!standalone && !existsSync(join(ROOT, "node_modules"))) {
    throw new CliError("既没有 standalone 产物，也没有 node_modules；先运行 ./install.sh");
  }
  const cmd = standalone ? { cmd: process.execPath, args: [entry] } : devSpawn();
  const child = spawn(cmd.cmd, cmd.args, {
    cwd: ROOT,
    stdio: "inherit",
    env: serverEnv(),
  });
  child.on("error", (e) => {
    notice(`启动进程失败：${e.message}`);
    process.exitCode = 1;
  });
  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      /* 已退出 */
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  const code = await new Promise((r) => child.on("close", r));
  process.exitCode = code ?? 0;
}

async function cmdStatus() {
  const health = await probe();
  if (!health) {
    if (JSON_MODE) {
      process.exitCode = 1;
      return result({ running: false, url: BASE });
    }
    line(`服务  ${C.cyan(BASE)}  ${C.red("未运行")}`);
    line(C.dim("用 swarm up 启动；或把 --url 指向别的实例。"));
    process.exitCode = 1;
    return;
  }
  const [chats, tasks] = await Promise.all([fetchChats(), fetchTasks()]);
  const live = tasks.filter((t) => isLive(t.state));
  if (JSON_MODE) {
    return result({
      running: true,
      url: BASE,
      health,
      chats: chats.length,
      tasks: tasks.length,
      live: live.length,
    });
  }
  line(
    `服务  ${C.cyan(BASE)}  ${C.green("运行中")}  ${C.dim(
      health.legacy ? "旧版服务（无 /api/health）" : `pid ${health.pid ?? "?"} · 已运行 ${fmtDuration((health.uptime || 0) * 1000)}`,
    )}`,
  );
  if (health.appRoot) line(`根目录  ${health.appRoot}`);
  line(`会话  ${chats.length} 个  ·  任务 ${tasks.length} 个  ·  执行中 ${live.length} 个`);
  if (live.length) {
    line();
    line(C.bold("执行中"));
    for (const t of live) {
      const d = displayState(t);
      line(`  ${shortId(t.id)}  ${TONE[d.tone](d.label)}  ${C.dim(clipLine(t.goal, 90))}`);
    }
  }
  if (tasks[0]) {
    line();
    line(
      `最近任务  ${shortId(tasks[0].id)}  ${stateText(tasks[0])}  ${C.dim(relTime(tasks[0].createdAt))}  ${clipLine(
        tasks[0].goal,
        70,
      )}`,
    );
  }
}

/* ---------------- 命令：会话 ---------------- */

async function cmdChats(pos, opts) {
  await ensureService(opts);
  const [chats, tasks] = await Promise.all([fetchChats(), fetchTasks()]);
  if (JSON_MODE) return result({ chats });
  printChatTable(chats.slice(0, Math.max(1, num(opts.limit, 20))), tasks);
}

async function cmdNew(pos, opts) {
  await ensureService(opts);
  const chat = await createChat({ repo: opts.repo, title: opts.title });
  if (JSON_MODE) return result({ chat });
  line(`会话已创建  ${C.bold(shortId(chat.id))}  ${clipLine(chat.title, 60)}`);
  line(C.dim(`继续对话：swarm say --chat ${shortId(chat.id)} "..."`));
}

async function sendAndStream(chat, text, stream) {
  const state = { text: "", printed: false };
  const off = stream.subscribe((ev) => {
    if (ev.type !== "session-delta" || ev.chatId !== chat.id) return;
    if (QUIET || JSON_MODE) return;
    if (!state.printed) {
      out(`\n${C.dim("编排器")}\n`);
      state.printed = true;
    }
    state.text += ev.delta;
    out(ev.delta);
  });
  try {
    const data = await api(`/api/chats/${encodeURIComponent(chat.id)}/messages`, {
      method: "POST",
      body: { text },
      // 编排器回复可能很久；这里只限制上限，正常会提前返回
      timeout: 20 * 60_000,
    });
    await sleep(120);
    return { data, streamed: state.text, printed: state.printed };
  } finally {
    off();
  }
}

function finishReply(reply, streamed, printed) {
  if (QUIET) {
    out(`${reply.text}\n`);
    return;
  }
  if (!printed) {
    out(`\n${C.dim("编排器")}\n${reply.text}\n`);
    return;
  }
  if (reply.text.startsWith(streamed) && reply.text.length > streamed.length) {
    out(reply.text.slice(streamed.length));
  }
  out("\n");
}

async function cmdSay(pos, opts) {
  const text = String(opts.message ?? pos.join(" ")).trim();
  if (!text) throw new CliError('消息为空。用法：swarm say "..." [--chat id]');
  await ensureService(opts);

  let chat;
  if (opts.chat && opts.repo) throw new CliError("--chat 与 --repo 不能同时使用");
  if (opts.chat) chat = await chatFromRef(opts.chat);
  else if (opts.last) {
    const chats = await fetchChats();
    chat = chats[0];
    if (!chat) throw new CliError("还没有会话");
  } else {
    chat = await createChat({ repo: opts.repo, title: opts.title });
  }

  const stream = new EventStream();
  stream.start();
  await withTimeout(stream.ready, 8000, "连接事件流").catch(() => {});

  let data;
  try {
    const body = await sendAndStream(chat, text, stream);
    data = body.data;
    const reply = data.message;
    if (JSON_MODE) {
      result({ chatId: chat.id, reply });
    } else {
      finishReply(reply, body.streamed, body.printed);
      line(C.dim(`${shortId(chat.id)} · ${reply.error ? "失败" : "已回复"}`));
    }
    if (reply.error) process.exitCode = 1;
  } finally {
    stream.stop();
  }
}

async function cmdShell(pos, opts) {
  await ensureService(opts);
  let chats = await fetchChats();
  let tasks = await fetchTasks();
  const ref = opts.chat || pos[0];
  let current = ref ? await chatFromRef(ref) : chats[0] || null;

  line();
  line(`${C.bold("swarm")}  ${C.dim(BASE)}`);
  line(
    `${chats.length} 个会话  ·  ${tasks.length} 个任务  ·  执行中 ${tasks.filter((t) => isLive(t.state)).length} 个`,
  );
  if (current) line(`当前会话  ${C.bold(clipLine(current.title, 40))}  ${C.dim(shortId(current.id))}`);
  else line(C.dim("还没有会话，直接输入目标即可新建。"));
  line(C.dim("直接输入与编排器对话；/run 派发执行；/help 查看命令。"));
  line();

  const stream = new EventStream();
  stream.start();
  await withTimeout(stream.ready, 8000, "连接事件流").catch(() => {});

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  rl.setPrompt(`${C.cyan("swarm")}> `);
  rl.prompt();

  let following = null;
  let closed = false;
  let queue = Promise.resolve();

  const refresh = async () => {
    chats = await fetchChats();
    tasks = await fetchTasks();
    if (current) current = chats.find((c) => c.id === current.id) || current;
  };

  const showChats = () => {
    if (!chats.length) {
      line(C.dim("还没有会话。"));
      return;
    }
    line(C.bold("会话"));
    chats.slice(0, 20).forEach((c, i) => {
      const mark = current?.id === c.id ? C.cyan("→") : " ";
      line(`${mark} ${String(i + 1).padStart(2)}  ${shortId(c.id)}  ${padEndW(clipLine(c.title, 34), 36)} ${C.dim(`${(c.taskIds || []).length} 个任务 · ${relTime(c.updatedAt)}`)}`);
    });
  };

  const say = async (text) => {
    if (!current) {
      current = await createChat();
      line(C.dim(`新会话 ${shortId(current.id)}`));
    }
    try {
      const body = await sendAndStream(current, text, stream);
      const reply = body.data.message;
      finishReply(reply, body.streamed, body.printed);
      if (reply.error) line(C.red("编排器调用失败"));
      current = body.data.chat || current;
      await refresh();
    } catch (e) {
      line(C.red(`发送失败：${e?.message || e}`));
    }
  };

  const runTaskInChat = async (arg) => {
    if (!current) throw new CliError("先 /new 建一个会话，或直接输入目标");
    const m = /^(\d+)\s*(.*)$/.exec(arg.trim());
    const agents = m ? Math.max(1, Math.min(8, Number(m[1]))) : 3;
    const goal = (m ? m[2] : arg).trim();
    const { task } = await api(`/api/chats/${encodeURIComponent(current.id)}/run`, {
      method: "POST",
      body: { agents, goal: goal || undefined },
      timeout: 60_000,
    });
    line();
    line(`任务 ${C.bold(shortId(task.id))} 已派发（${task.agents.length} 个执行代理）`);
    following = new AbortController();
    try {
      await followTask(task.id, { signal: following.signal });
    } finally {
      following = null;
    }
    await refresh();
    if (current) line(C.dim("继续输入与编排器对话，或 /run 再执行一轮。"));
  };

  const watchTask = async (arg) => {
    let task;
    if (arg) task = resolveRef(await fetchTasks(), arg, "任务");
    else if (current?.taskId) task = await getTask(current.taskId);
    else {
      const list = await fetchTasks();
      task = list.find((t) => isLive(t.state)) || list[0];
    }
    if (!task) throw new CliError("没有可查看的任务");
    following = new AbortController();
    try {
      await followTask(task.id, { signal: following.signal });
    } finally {
      following = null;
    }
    await refresh();
  };

  const promoteTask = async (arg) => {
    if (!arg && !current?.taskId) throw new CliError("用法：/promote [任务id]；当前会话还没有任务");
    const task = arg ? resolveRef(await fetchTasks(), arg, "任务") : await getTask(current.taskId);
    if (!task) throw new CliError("没有可合入的任务");
    const r = await api(`/api/tasks/${encodeURIComponent(task.id)}/promote`, {
      method: "POST",
      body: { force: !!opts.force },
      timeout: 120_000,
    });
    const p = r.promote;
    line(p.ok ? C.green(`已合入 ${p.target} ${p.commit || ""}`.trim()) : C.red(`合入失败：${p.detail}`));
  };

  const repl = async (text) => {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (name) {
      case "help":
        line(C.dim("直接输入=与编排器对话。命令：/new [仓库] /chats /use <序号|id> /repo [路径] /title <标题>"));
        line(C.dim("/run [代理数] [目标] /watch [任务id] /tasks /show [任务id] /agents /logs /diff /cancel /promote /status /quit"));
        return;
      case "new":
        current = await createChat({ repo: arg || opts.repo });
        line(`会话已创建  ${C.bold(shortId(current.id))}  ${clipLine(current.title, 50)}`);
        await refresh();
        return;
      case "chats":
        await refresh();
        showChats();
        return;
      case "use": {
        if (!arg) return showChats();
        await refresh();
        current = resolveRef(chats, arg, "会话");
        line(`当前会话  ${C.bold(current.title)}  ${C.dim(shortId(current.id))}`);
        return;
      }
      case "repo": {
        if (!current) throw new CliError("先选一个会话");
        if (!arg) return line(current.repoPath || C.dim("未指定仓库（执行时新建临时仓库）"));
        const repo = normalizeRepo(arg);
        checkRepo(repo);
        const r = await api(`/api/chats/${current.id}`, { method: "PATCH", body: { repoPath: repo } });
        current = r.chat;
        line(`仓库已改为  ${repo}`);
        return;
      }
      case "title": {
        if (!current) throw new CliError("先选一个会话");
        if (!arg) return line(current.title);
        const r = await api(`/api/chats/${current.id}`, { method: "PATCH", body: { title: arg } });
        current = r.chat;
        line(`标题已改为  ${current.title}`);
        return;
      }
      case "run":
        return runTaskInChat(arg);
      case "watch":
        return watchTask(arg);
      case "tasks":
        await refresh();
        printTaskTable(tasks, { live: false });
        return;
      case "status":
        return cmdStatus();
      case "show": {
        await refresh();
        const task = arg ? resolveRef(tasks, arg, "任务") : current?.taskId ? await getTask(current.taskId) : null;
        if (!task) throw new CliError("没有可查看的任务");
        printTaskDetail(task, { full: !!opts.full });
        return;
      }
      case "agents": {
        if (!arg && !current?.taskId) throw new CliError("用法：/agents [任务id]；当前会话还没有任务");
        return cmdAgents(arg ? [arg] : [], arg ? opts : { ...opts, chat: current.id });
      }
      case "logs": {
        await refresh();
        const task = arg ? resolveRef(tasks, arg, "任务") : current?.taskId ? await getTask(current.taskId) : null;
        if (!task) throw new CliError("没有可查看的任务");
        printLogs(task, { tail: num(opts.tail, 1200), agent: opts.agent });
        return;
      }
      case "diff": {
        await refresh();
        const task = arg ? resolveRef(tasks, arg, "任务") : current?.taskId ? await getTask(current.taskId) : null;
        if (!task) throw new CliError("没有可查看的任务");
        await printDiff(task.id);
        return;
      }
      case "cancel": {
        await refresh();
        const task = arg ? resolveRef(tasks, arg, "任务") : current?.taskId ? await getTask(current.taskId) : null;
        if (!task) throw new CliError("没有可取消的任务");
        const r = await api(`/api/tasks/${task.id}/cancel`, { method: "POST", timeout: 60_000 });
        line(`任务 ${shortId(task.id)}  ${stateText(r.task)}`);
        return;
      }
      case "promote":
        return promoteTask(arg);
      case "quit":
      case "exit":
        closed = true;
        rl.close();
        return;
      default:
        line(C.dim(`未知命令 /${name}，输入 /help 查看。`));
    }
  };

  const handle = async (raw) => {
    const text = String(raw).trim();
    if (!text) return;
    if (text.startsWith("/")) return repl(text);
    return say(text);
  };

  const onLine = (raw) => {
    rl.pause();
    queue = queue
      .then(() => handle(raw))
      .catch((e) => line(C.red(`错误  ${e?.message || e}`)))
      .finally(() => {
        if (!closed) {
          rl.resume();
          rl.prompt();
        }
      });
  };

  rl.on("line", onLine);
  rl.on("SIGINT", () => {
    if (following) {
      following.abort();
      return;
    }
    closed = true;
    line();
    rl.close();
  });
  rl.on("close", () => {
    closed = true;
    // 管道输入时 close 会在 EOF 立刻触发；等队列里最后一条消息处理完再退出
    queue.finally(() => {
      stream.stop();
      line(C.dim("再见。"));
      process.exit(0);
    });
  });

  await new Promise(() => {});
}

/* ---------------- 命令：任务 ---------------- */

async function cmdTasks(pos, opts) {
  await ensureService(opts);
  const tasks = await fetchTasks();
  if (JSON_MODE) return result({ tasks });
  printTaskTable(tasks, { live: !!opts.live, limit: num(opts.limit, 20) });
}

async function cmdShow(pos, opts) {
  await ensureService(opts);
  const task = await taskFromArgs(pos, opts, { allowLatest: true });
  if (JSON_MODE) return result({ task });
  printTaskDetail(task, { full: !!opts.full });
  const chat = await findChatForTask(task.id);
  if (chat) line(C.dim(`会话  ${shortId(chat.id)}  ${clipLine(chat.title, 40)}  ·  继续对话：swarm say --chat ${shortId(chat.id)} "..."`));
}

async function cmdLogs(pos, opts) {
  await ensureService(opts);
  const task = await taskFromArgs(pos, opts, { allowLatest: true });
  if (JSON_MODE) return result({ task });
  printLogs(task, { tail: num(opts.tail, 1200), agent: opts.agent });
}

async function cmdAgents(pos, opts) {
  await ensureService(opts);
  const task = await taskFromArgs(pos, opts, { allowLatest: true });
  if (JSON_MODE) return result({ taskId: task.id, agents: task.agents });
  line(`${C.bold("任务")}  ${shortId(task.id)}  ${stateText(task)}  ${C.dim(`${task.agents.length} 个执行代理`)}`);
  if (task.boss?.planList?.length) {
    line(C.dim(`计划 ${task.boss.planList.length} 项：${task.boss.planList.map((p) => p.name).join(" / ")}`));
  }
  for (const a of task.agents) {
    line(
      `  ${padEndW(a.name, 8)} ${padEndW(STATE_LABEL[a.state] || a.state, 8)} ${padEndW(
        `${fmtTokens(usageTotal(a))} tokens`,
        14,
      )} ${padEndW(`${a.changedFiles?.length || 0} 个文件`, 8)} ${C.dim(a.branch || "—")}`,
    );
    if (a.task) line(`           ${C.dim(clipLine(a.task, 110))}`);
    if (a.error) line(`           ${C.red(clipLine(a.error, 120))}`);
  }
}

function printLogs(task, { tail = 1200, agent } = {}) {
  line(`${C.bold("任务")}  ${shortId(task.id)}  ${stateText(task)}  ${C.dim(clipLine(task.goal, 100))}`);
  if (task.boss?.text) {
    line();
    line(C.bold("编排器"));
    line(tailText(task.boss.text, tail));
  }
  for (const a of task.agents) {
    if (agent && a.name !== agent && !a.id.startsWith(String(agent)) && String(a.index + 1) !== String(agent)) continue;
    line();
    line(
      `${C.bold(a.name)}  ${agentStateText(a)}  ${C.dim(
        `${fmtTokens(usageTotal(a))} tokens${a.changedFiles?.length ? ` · ${a.changedFiles.length} 个文件` : ""}`,
      )}`,
    );
    if (a.task) line(C.dim(a.task));
    line(a.text ? tailText(a.text, tail) : C.dim("（没有输出）"));
    if (a.error) line(C.red(a.error));
  }
  if (task.verifier?.text) {
    line();
    line(C.bold("验证器"));
    line(tailText(task.verifier.text, tail));
  }
  if (task.verdict?.raw) {
    line();
    line(C.bold("裁决原文"));
    line(tailText(task.verdict.raw, tail));
  }
  line();
}

async function printDiff(taskId) {
  const data = await api(`/api/tasks/${encodeURIComponent(taskId)}/diff`, { timeout: 30_000 });
  if (JSON_MODE) return result(data);
  if (!data.agents?.length) {
    line(C.dim("没有代理改动。"));
    return;
  }
  for (const a of data.agents) {
    line();
    line(`${C.bold(a.name)}  ${C.dim(a.branch || "")}`);
    if (a.worktree) line(`  ${C.dim(a.worktree)}`);
    const files = a.files || [];
    const untracked = a.untracked?.count || 0;
    line(
      `  改动 ${files.length} 个文件${untracked ? `（未跟踪 ${untracked}）` : ""}${
        a.committed ? C.dim("（已提交到分支，工作区干净）") : ""
      }`,
    );
    for (const f of files.slice(0, 80)) line(`    ${f}`);
    if (files.length > 80) line(C.dim(`    …还有 ${files.length - 80} 个`));
    if (a.stat) {
      line();
      line(C.dim(a.stat.trim()));
    }
  }
  line();
}

async function cmdDiff(pos, opts) {
  await ensureService(opts);
  const task = await taskFromArgs(pos, opts, { allowLatest: true });
  await printDiff(task.id);
}

async function cmdWatch(pos, opts) {
  await ensureService(opts);
  let task;
  if (pos[0]) task = resolveRef(await fetchTasks(), pos[0], "任务");
  else if (opts.chat) {
    const chat = await chatFromRef(opts.chat);
    if (!chat?.taskId) throw new CliError("这个会话还没有任务");
    task = await getTask(chat.taskId);
  } else {
    const tasks = await fetchTasks();
    task = tasks.find((t) => isLive(t.state)) || tasks[0];
    if (!task) throw new CliError("还没有任务");
  }
  const seconds = num(opts.timeout, 0);
  const final = await followTask(task.id, { timeoutMs: seconds > 0 ? seconds * 1000 : 0 });
  if (JSON_MODE) return result({ task: final || task });
  if (final) process.exitCode = taskExitCode(final);
}

async function cmdRun(pos, opts) {
  const goal = String(opts.goal ?? pos.join(" ")).trim();
  if (opts.chat && opts.repo) throw new CliError("--chat 与 --repo 不能同时使用");
  await ensureService(opts);

  let chat = null;
  if (opts.chat) chat = await chatFromRef(opts.chat);
  else if (opts.last) {
    chat = (await fetchChats())[0];
    if (!chat) throw new CliError("还没有会话");
  } else {
    if (!goal) throw new CliError("需要目标文本，或用 --chat 指定已有会话");
    if (opts.repo) checkRepo(normalizeRepo(opts.repo));
    chat = await createChat({ repo: opts.repo, title: opts.title });
  }

  const agents = Math.max(1, Math.min(8, num(opts.agents, 3)));
  const { task } = await api(`/api/chats/${encodeURIComponent(chat.id)}/run`, {
    method: "POST",
    body: { agents, goal: goal || undefined },
    timeout: 60_000,
  });

  if (JSON_MODE && opts.detach) {
    result({ chatId: chat.id, task });
  } else if (!JSON_MODE) {
    line(
      `任务 ${C.bold(shortId(task.id))} 已派发  ${C.dim(`${task.agents.length} 个执行代理 · 会话 ${shortId(chat.id)}`)}`,
    );
  }

  if (opts.detach) {
    if (!JSON_MODE) line(C.dim(`跟随进度：swarm watch ${shortId(task.id)}`));
    return;
  }
  const seconds = num(opts.timeout, 0);
  const final = await followTask(task.id, { timeoutMs: seconds > 0 ? seconds * 1000 : 0 });
  if (JSON_MODE) return result({ chatId: chat.id, task: final || task });
  if (final) process.exitCode = taskExitCode(final);
}

async function cmdCancel(pos, opts) {
  await ensureService(opts);
  let task;
  if (pos[0]) task = resolveRef(await fetchTasks(), pos[0], "任务");
  else if (opts.chat) {
    const chat = await chatFromRef(opts.chat);
    if (!chat?.taskId) throw new CliError("这个会话还没有任务");
    task = await getTask(chat.taskId);
  } else {
    throw new CliError("需要任务 id（swarm tasks 可查看）");
  }
  const r = await api(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST", timeout: 60_000 });
  if (JSON_MODE) return result({ task: r.task });
  line(`任务 ${shortId(task.id)}  ${stateText(r.task)}`);
}

async function confirm(question, opts) {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    throw new CliError(`${question}（不可逆）非交互环境请加 --yes`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function cmdRemove(pos, opts) {
  await ensureService(opts);
  let kind = pos[0];
  let ref = pos[1];
  if (kind !== "task" && kind !== "chat") {
    ref = pos[0];
    kind = null;
  }
  if (!ref) throw new CliError("用法：swarm rm <id> | swarm rm task <id> | swarm rm chat <id>");

  const chats = await fetchChats();
  const tasks = await fetchTasks();

  if (!kind) {
    const isChat = chats.some((c) => c.id === ref || c.id.startsWith(ref));
    const isTask = tasks.some((t) => t.id === ref || t.id.startsWith(ref));
    if (isChat && isTask) throw new CliError("这个 id 同时匹配会话与任务，请显式写 rm task / rm chat");
    if (isChat) kind = "chat";
    else if (isTask) kind = "task";
    else throw new CliError(`找不到任务或会话 ${ref}`);
  }

  if (kind === "task") {
    const task = resolveRef(tasks, ref, "任务");
    if (!(await confirm(`删除任务 ${shortId(task.id)} 及其运行目录？`, opts))) {
      line(C.dim("已取消。"));
      return;
    }
    const r = await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    if (JSON_MODE) return result(r);
    line(`任务 ${shortId(task.id)} 已删除。`);
    return;
  }

  const chat = resolveRef(chats, ref, "会话");
  const withTasks = Boolean(opts["with-tasks"]);
  if (!(await confirm(`删除会话「${clipLine(chat.title, 30)}」${withTasks ? "及其全部任务" : ""}？`, opts))) {
    line(C.dim("已取消。"));
    return;
  }
  const r = await api(
    `/api/chats/${encodeURIComponent(chat.id)}${withTasks ? "?withTasks=1" : ""}`,
    { method: "DELETE" },
  );
  if (JSON_MODE) return result(r);
  line(
    `会话 ${shortId(chat.id)} 已删除${r.deletedTasks?.length ? `，同时清理 ${r.deletedTasks.length} 个任务` : ""}。`,
  );
}

async function cmdPromote(pos, opts) {
  await ensureService(opts);
  const task = await taskFromArgs(pos, opts);
  if (!(await confirm(`把任务 ${shortId(task.id)} 的整合分支合入主干？`, opts))) {
    line(C.dim("已取消。"));
    return;
  }
  const r = await api(`/api/tasks/${encodeURIComponent(task.id)}/promote`, {
    method: "POST",
    body: { force: !!opts.force },
    timeout: 180_000,
  });
  if (JSON_MODE) return result(r);
  const p = r.promote;
  if (p.ok) {
    line(C.green(`已合入 ${p.target} ${p.commit || ""}`.trim()));
  } else {
    line(C.red(`合入失败：${p.detail}`));
    process.exitCode = 1;
  }
}

/* ---------------- 帮助 ---------------- */

function printHelp() {
  const text = `swarm ${VERSION} — agy-agent-swarm 命令行

用法
  swarm                         交互式会话（默认）
  swarm up [--dev]              启动服务：systemd 单元 → standalone 后台进程
  swarm serve [--dev]           前台运行服务（日志直接进终端）
  swarm down                    停止服务
  swarm status                  服务、会话、任务概况

会话
  swarm new [--repo 路径] [--title 标题]
  swarm chats [--limit N]       会话列表（序号可用于 --chat / chat）
  swarm say <文本> [--chat id|--last] [--repo 路径]
  swarm chat [id|序号]          进入某个会话的交互模式

执行
  swarm run [目标] [--chat id|--last] [--repo 路径] [-n 代理数] [--detach]
     不带 --chat 时新建会话并直接派发；--repo 指向项目目录，目标省略则用会话最后一条用户消息。
  swarm watch [任务id] [--chat id] [--timeout 秒]
  swarm tasks [--limit N] [--live]
  swarm show [任务id] [--full] [--chat id]
  swarm agents [任务id] [--chat id]     执行代理清单（名称、状态、token、分支）
  swarm logs [任务id] [--agent 名称] [--tail 字符数] [--chat id]
  swarm diff [任务id] [--chat id]
  swarm cancel <任务id> [--chat id]
  swarm promote <任务id> [--force] [--yes]
  swarm rm <任务id|会话id> | swarm rm task|chat <id> [--with-tasks] [--yes]

通用
  --url 地址      连接其它实例，默认 ${DEFAULT_URL}
  --json          机器输出：最终 JSON 走 stdout，进度走 stderr
  --quiet         只输出回复正文
  --no-color      关闭颜色
  --no-autostart  服务没起来时直接报错，不自动启动
  --help          本帮助；swarm <命令> --help 同样可用

交互模式
  直接输入文本即与编排器对话。斜杠命令：
  /new [仓库]  /chats  /use <序号|id>  /repo [路径]  /title <标题>
  /run [代理数] [目标]  /watch [任务id]  /tasks  /show [任务id]  /logs  /diff
  /cancel  /promote  /status  /quit

退出码
  0 成功 / 任务通过    2 任务结束但裁决未通过    1 失败、取消或接口错误

例子
  swarm run --repo ~/proj --goal "补 README 并跑通测试" -n 3
  swarm say --chat 451456ba "下一轮把检查命令收紧到 npm test"
  swarm tasks --live
  swarm watch 5f3c1a2b
`;
  process.stdout.write(text);
}

/* ---------------- 入口 ---------------- */

const COMMANDS = {
  up: cmdUp,
  down: cmdDown,
  serve: cmdServe,
  status: cmdStatus,
  new: cmdNew,
  chats: cmdChats,
  ls: cmdChats,
  sessions: cmdChats,
  say: cmdSay,
  ask: cmdSay,
  chat: cmdShell,
  shell: cmdShell,
  run: cmdRun,
  dispatch: cmdRun,
  watch: cmdWatch,
  tasks: cmdTasks,
  ps: cmdTasks,
  show: cmdShow,
  info: cmdShow,
  agents: cmdAgents,
  logs: cmdLogs,
  diff: cmdDiff,
  cancel: cmdCancel,
  stop: cmdCancel,
  promote: cmdPromote,
  merge: cmdPromote,
  rm: cmdRemove,
  delete: cmdRemove,
};

async function main() {
  const { pos, opts } = parseArgv(process.argv.slice(2));
  JSON_MODE = !!opts.json;
  QUIET = !!opts.quiet;
  if (opts.color === false) colorEnabled = false;
  if (opts.color === true) colorEnabled = true;
  if (opts.url) BASE = String(opts.url).replace(/\/+$/, "");

  if (opts.help) return printHelp(pos[0]);
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const cmd = pos.shift() || "shell";
  if (cmd === "help") return printHelp(pos[0]);
  if (cmd === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) throw new CliError(`未知命令 ${cmd}，用 swarm help 查看可用命令`);
  await fn(pos, opts);
}

function fail(e) {
  const message = e?.message || String(e);
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ error: message, status: e?.status ?? null })}\n`);
  } else {
    process.stderr.write(`${C.red("错误")}  ${message}\n`);
  }
  process.exitCode = e?.exitCode ?? 1;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] || "") === realpathSync(SELF);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch(fail);
}

export { parseArgv, fmtTokens, fmtDuration, relTime, displayWidth, cutW, padEndW };

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runAgyTask, runSandboxedCommand } from "./acp.ts";
import { createDeltaBatcher, getTask, putTask, emit, removeTask, store } from "./store.ts";
import { BOSS_JUDGE_SYSTEM, BOSS_JUDGE_TASK, BOSS_PLAN_SYSTEM, BOSS_PLAN_TASK, BOSS_SUMMARY_TASK, FIXER_TASK, REWORK_AGENT_TASK, VERIFIER_TASK, WORKER_PREAMBLE, WORKER_TASK } from "./prompts.ts";
import type { AgentRun, CheckResult, MergeResult, PromoteResult, Task, TaskState, Usage, Verification } from "../lib/types.ts";

// standalone 模式下 server.js 会 chdir 到部署目录，仓库内的运行时文件用显式根目录定位
const APP_ROOT = process.env.SWARM_APP_ROOT || process.cwd();
const ROOT = process.env.SWARM_ROOT || join(APP_ROOT, "data", "runs");
const BOSS_PROVIDER = process.env.BOSS_PROVIDER || "1";
const BOSS_MODEL = process.env.BOSS_MODEL || "deepseek-v4.1-flash";
const GIT = ["-c", "user.email=swarm@local", "-c", "user.name=swarm"];

const CODENAMES = [
  "Atlas", "Nova", "Lyra", "Orion", "Vega", "Rune", "Echo", "Kite",
  "Sable", "Flint", "Juno", "Onyx", "Pike", "Quill", "Reed", "Tess",
];

function sh(cmd: string, args: string[], cwd?: string) {
  return execFileSync(/*turbopackIgnore: true*/ cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function trySh(cmd: string, args: string[], cwd?: string): { ok: boolean; out: string; err: string } {
  try {
    return { ok: true, out: sh(cmd, args, cwd), err: "" };
  } catch (e: any) {
    return { ok: false, out: String(e?.stdout || ""), err: String(e?.stderr || e?.message || e) };
  }
}

function git(args: string[], cwd: string) {
  return sh("git", [...GIT, ...args], cwd);
}

function short(id: string) {
  return id.slice(0, 8);
}

/* ---------------- 编排器 ---------------- */

export async function makeBossSession(cwd: string) {
  const pi: any = await import("@earendil-works/pi-coding-agent");
  const modelRuntime = await pi.ModelRuntime.create();
  const model = modelRuntime.getModel(BOSS_PROVIDER, BOSS_MODEL);
  if (!model) throw new Error(`编排器模型不可用: ${BOSS_PROVIDER}/${BOSS_MODEL}`);
  const { session } = await pi.createAgentSession({
    model,
    modelRuntime,
    cwd,
    noTools: true,
    sessionManager: pi.SessionManager.inMemory(cwd),
  });
  return session;
}

// pi 会话里的 usage 是整段会话的累计值；记账必须按阶段取增量，否则后写的阶段会把前面的盖掉。
// 这里缓存「上次读到的累计快照」，usageDelta 返回本次新增的部分（字段级相减）。
type UsageAcc = Usage & { cacheRead?: number; cacheWrite?: number };
const lastUsage = new WeakMap<object, Record<string, number>>();

function collectPiusage(session: any): Record<string, number> | null {
  const msgs = session.messages || [];
  const us = msgs.filter((m: any) => m.usage).map((m: any) => m.usage);
  if (!us.length) return null;
  return us.reduce(
    (acc: any, u: any) => {
      acc.input += u.input || 0;
      acc.output += u.output || 0;
      acc.cacheRead += u.cacheRead || 0;
      acc.cacheWrite += u.cacheWrite || 0;
      acc.totalTokens += u.totalTokens || 0;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  );
}

// 本次调用相对上次读取新增的用量；会话没有新消息时返回 null
export function usageDelta(session: any): UsageAcc | null {
  const cur = collectPiusage(session);
  if (!cur) return null;
  const prev = lastUsage.get(session) || {};
  lastUsage.set(session, cur);
  const delta: UsageAcc = {
    input: (cur.input || 0) - (prev.input || 0),
    output: (cur.output || 0) - (prev.output || 0),
    cacheRead: (cur.cacheRead || 0) - (prev.cacheRead || 0),
    cacheWrite: (cur.cacheWrite || 0) - (prev.cacheWrite || 0),
    totalTokens: (cur.totalTokens || 0) - (prev.totalTokens || 0),
  };
  const changed = (delta.totalTokens || 0) > 0 || (delta.input || 0) > 0 || (delta.output || 0) > 0;
  return changed ? delta : null;
}

// 把增量累加进已经记账的 Usage；保持 Usage 原有字段结构，只做加法
function addUsage(base: Usage | null, delta: Usage | null): Usage | null {
  if (!delta) return base ?? null;
  const b = (base || {}) as UsageAcc;
  const d = delta as UsageAcc;
  const out: UsageAcc = {
    input: (b.input || 0) + (d.input || 0),
    output: (b.output || 0) + (d.output || 0),
    cacheRead: (b.cacheRead || 0) + (d.cacheRead || 0),
    cacheWrite: (b.cacheWrite || 0) + (d.cacheWrite || 0),
    totalTokens: (b.totalTokens || 0) + (d.totalTokens || 0),
  };
  return out;
}

/* ---------------- 任务取消与系统消息 ---------------- */

// Next 在不同路由/热更新下可能加载多份模块，跨请求共享的状态一律挂在 globalThis
// 运行中任务的 AbortController；runTask 各阶段检查 signal，取消后不再 spawn 下一批代理
const gswarm = globalThis as unknown as {
  __swarmTaskControllers?: Map<string, AbortController>;
  __swarmDeletedTasks?: Set<string>;
  __swarmSystemSink?: ((taskId: string, text: string, kind: "event" | "error") => void) | null;
};
const controllers = (gswarm.__swarmTaskControllers ||= new Map<string, AbortController>());
// 已被删除的任务：runTask 收尾时不要再把快照写回 store/磁盘
const deletedTasks = (gswarm.__swarmDeletedTasks ||= new Set<string>());

class TaskCancelled extends Error {
  constructor() {
    super("已取消");
    this.name = "TaskCancelled";
  }
}

function isCancelled(e: any, signal?: AbortSignal): boolean {
  return e instanceof TaskCancelled || !!signal?.aborted;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new TaskCancelled();
}

// 让不可中断的 promise（pi 会话）在取消时立刻返回，底层请求自行收尾
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new TaskCancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new TaskCancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

// 「开始/取消/失败」要落成会话里的系统消息；编排器不反向依赖 chats，
// 由 chats 启动时注册 sink，避免循环 import。
export function setSystemMessageSink(fn: (taskId: string, text: string, kind: "event" | "error") => void) {
  gswarm.__swarmSystemSink = fn;
}

function noteSystem(taskId: string, text: string, kind: "event" | "error") {
  try {
    gswarm.__swarmSystemSink?.(taskId, text, kind);
  } catch {
    /* 会话侧失败不影响任务 */
  }
}

const LIVE_STATES = new Set(["planning", "running", "merging", "verifying", "rework", "aggregating"]);

/* ---------------- 任务状态机 ---------------- */

// 允许的迁移表。终态不再迁移；done 只表示流程结束，成功与否看 verdict。
const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  planning: ["running", "failed", "cancelled"],
  running: ["merging", "failed", "cancelled"],
  merging: ["verifying", "failed", "cancelled"],
  verifying: ["rework", "aggregating", "failed", "cancelled"],
  // 修复代理直接在合并树上改完后，同一轮内已重新验证，回到 verifying
  rework: ["merging", "verifying", "failed", "cancelled"],
  aggregating: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

// 单一迁移入口：同状态重复设置按幂等处理；
// 非法迁移开发环境直接抛错，生产环境只告警并照常迁移，避免线上流程卡死。
export function transition(task: Task, next: TaskState): void {
  if (task.state === next) return;
  const allowed = TASK_TRANSITIONS[task.state];
  if (!allowed.includes(next)) {
    const msg = `非法状态迁移：${task.state} → ${next}（task ${short(task.id)}）`;
    if (process.env.NODE_ENV === "production") console.warn(msg);
    else throw new Error(msg);
  }
  task.state = next;
}

export function isTaskLive(task: Task): boolean {
  return LIVE_STATES.has(task.state);
}

// 状态已终结、但 runTask 还没收尾（取消后等子进程退出）也算活动中，此时不能删除
export function isTaskActive(task: Task): boolean {
  return isTaskLive(task) || controllers.has(task.id);
}

/* ---------------- 规划契约校验 ---------------- */

export type PlannedTask = {
  name: string;
  task: string;
  scope: string[];
  acceptance: string[];
  evidence: string[];
  dependsOn: string[];
};

// 项目未开 strictNullChecks，字面量判别式联合不会被收窄，这里用扁平结构：
// 成功/失败都返回同样的字段，调用方只看 ok 与 errors。
export type PlanResult = {
  ok: boolean;
  contract: any | null;
  tasks: PlannedTask[];
  errors: string[];
};

// 提取 JSON 候选：先取 ```json 代码块，再退化为平衡括号扫描。
// 平衡扫描按字符串状态跳过引号内容，只切出最外层的完整对象/数组，
// 不会因为前后夹带说明文字或正文里出现花括号而切错。
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };

  const fence = /```json\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m; m = fence.exec(text)) push(m[1]);
  for (const s of balancedJsonSlices(text)) push(s);
  return out;
}

function balancedJsonSlices(text: string): string[] {
  const out: string[] = [];
  const stack: { ch: string; i: number }[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") {
      stack.push({ ch: c, i });
      continue;
    }
    if (c === "}" || c === "]") {
      const top = stack[stack.length - 1];
      if (!top) continue;
      const expect = top.ch === "{" ? "}" : "]";
      if (c !== expect) {
        // 括号失配：丢掉这一层，继续往后找成对的候选
        stack.pop();
        continue;
      }
      stack.pop();
      if (!stack.length) out.push(text.slice(top.i, i + 1));
    }
  }
  return out;
}

function readStringArray(v: any, label: string, errors: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push(`${label} 必须是字符串数组`);
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") {
      errors.push(`${label} 必须是字符串数组`);
      return [];
    }
    out.push(item.trim());
  }
  return out;
}

// 拓扑排序检测环，返回环上的任务名（用于错误提示）
function findCycle(tasks: PlannedTask[]): string | null {
  const names = tasks.map((t) => t.name).filter(Boolean);
  const indeg = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const n of names) {
    indeg.set(n, 0);
    edges.set(n, []);
  }
  for (const t of tasks) {
    if (!t.name) continue;
    for (const d of t.dependsOn) {
      if (!edges.has(d) || d === t.name) continue;
      edges.get(d)!.push(t.name);
      indeg.set(t.name, (indeg.get(t.name) || 0) + 1);
    }
  }
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([n]) => n);
  let seen = 0;
  while (queue.length) {
    const n = queue.shift()!;
    seen++;
    for (const m of edges.get(n) || []) {
      const v = (indeg.get(m) || 0) - 1;
      indeg.set(m, v);
      if (!v) queue.push(m);
    }
  }
  if (seen === names.length) return null;
  return [...indeg.entries()]
    .filter(([, v]) => v > 0)
    .map(([n]) => n)
    .join("、");
}

// 手写 validator：不做 schema 猜测，不造任务。列表字段缺失按空数组处理，显式写错类型则拒绝。
export function validatePlan(raw: any, count: number): PlanResult {
  const errors: string[] = [];
  let contract: any = null;
  let list: any[];

  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object" && raw.contract && typeof raw.contract === "object" && !Array.isArray(raw.contract) && Array.isArray(raw.tasks)) {
    contract = raw.contract;
    list = raw.tasks;
  } else {
    return { ok: false, contract: null, tasks: [], errors: ['顶层必须是 {"contract":{…},"tasks":[…]} 或 tasks 数组'] };
  }

  if (list.length !== count) errors.push(`tasks 数量为 ${list.length}，与执行代理数 ${count} 不一致`);

  const tasks: PlannedTask[] = [];
  const names = new Set<string>();
  list.forEach((x, i) => {
    const label = `tasks[${i}]`;
    if (!x || typeof x !== "object" || Array.isArray(x)) {
      errors.push(`${label} 必须是对象`);
      return;
    }
    const name = String(x.name ?? x.codename ?? "").trim();
    const body = String(x.task ?? x.description ?? "").trim();
    if (!name) errors.push(`${label}.name 不能为空`);
    else if (names.has(name)) errors.push(`${label}.name「${name}」重复`);
    else names.add(name);
    if (!body) errors.push(`${label}.task 正文不能为空`);
    tasks.push({
      name,
      task: body,
      scope: readStringArray(x.scope, `${label}.scope`, errors),
      acceptance: readStringArray(x.acceptance, `${label}.acceptance`, errors),
      evidence: readStringArray(x.evidence, `${label}.evidence`, errors),
      dependsOn: readStringArray(x.depends_on ?? x.dependsOn, `${label}.depends_on`, errors),
    });
  });

  // depends_on 必须指向真实任务、不能自依赖、不能成环
  const nameSet = new Set(tasks.map((t) => t.name).filter(Boolean));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!d) continue;
      if (d === t.name) errors.push(`任务「${t.name}」不能依赖自己`);
      else if (!nameSet.has(d)) errors.push(`任务「${t.name}」的 depends_on「${d}」不存在`);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) errors.push(`depends_on 存在循环依赖：${cycle}`);

  return errors.length
    ? { ok: false, contract: null, tasks, errors }
    : { ok: true, contract, tasks, errors: [] };
}

export function parsePlan(text: string, count: number): PlanResult {
  const candidates = jsonCandidates(text);
  if (!candidates.length) return { ok: false, contract: null, tasks: [], errors: ["输出里没有找到 JSON"] };

  let firstError: string[] | null = null;
  for (const raw of candidates) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const res = validatePlan(parsed, count);
    if (res.ok) return res;
    if (!firstError) firstError = res.errors;
  }
  return { ok: false, contract: null, tasks: [], errors: firstError || ["找到 JSON 候选，但都无法解析"] };
}

function cleanModelText(t: string): string {
  return t
    .replace(/<\|[^>]*\|>/g, " ")
    .replace(/<\|[\s\S]*?\|>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 1600);
}

/* ---------------- 仓库与 worktree ---------------- */

function ensureBaseRepo(task: Task): string {
  if (task.baseRepo) {
    if (!task.baseBranch) task.baseBranch = actualBranch(task.baseRepo) || null;
    return task.baseRepo;
  }

  if (task.repoPath && existsSync(join(task.repoPath, ".git"))) {
    task.baseRepo = task.repoPath;
    return task.baseRepo;
  }

  const base = join(ROOT, task.id, "repo");
  mkdirSync(base, { recursive: true });
  if (!existsSync(join(base, ".git"))) {
    git(["init", "-q", "-b", "main"], base);
    writeFileSync(join(base, "README.md"), `# Swarm task\n\n${task.goal}\n`);
    git(["add", "-A"], base);
    git(["commit", "-qm", "init"], base);
  }
  task.baseRepo = base;
  return base;
}

function prepareWorktree(task: Task, index: number, baseRef = "HEAD"): { dir: string; branch: string } {
  const base = ensureBaseRepo(task);
  const dir = join(ROOT, task.id, `agent-${index + 1}`);
  const branch = `swarm/${short(task.id)}/a${index + 1}`;

  if (existsSync(dir)) {
    trySh("git", ["-C", base, "worktree", "remove", "--force", dir]);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  trySh("git", ["-C", base, "branch", "-D", branch]);
  const r = trySh("git", [...GIT, "-C", base, "worktree", "add", "-b", branch, dir, baseRef]);
  if (!r.ok) {
    mkdirSync(dir, { recursive: true });
    return { dir, branch: "" };
  }
  return { dir, branch };
}

function actualBranch(worktree: string): string {
  const r = trySh("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.out.trim() : "";
}

// 子代理跑起来的解释器/包管理器会在工作目录里留缓存（__pycache__、node_modules 等），
// 这些不是交付物，提交时统一排除，免得被合进主干。
const JUNK = [
  ":(exclude,glob)**/__pycache__/**",
  ":(exclude,glob)**/*.pyc",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/.next/**",
  ":(exclude,glob)**/.venv/**",
  ":(exclude,glob)**/.swarm-verify/**",
];

function stageAll(dir: string) {
  if (!trySh("git", ["-C", dir, "add", "-A", "--", ".", ...JUNK]).ok) {
    trySh("git", ["-C", dir, "add", "-A"]);
  }
}

function dirtyPaths(dir: string): string[] {
  const r = trySh("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all", "--", ".", ...JUNK]);
  return r.ok ? r.out.split("\n").filter(Boolean) : [];
}

function commitAgent(agent: AgentRun): { ok: boolean; detail: string } {
  if (!agent.worktree) return { ok: false, detail: "no worktree" };
  // 子代理可能自己切过分支，记录的分支名不可信，以实际 HEAD 为准
  const branch = actualBranch(agent.worktree);
  if (!branch || branch === "HEAD") return { ok: false, detail: "detached HEAD" };
  agent.branch = branch;
  stageAll(agent.worktree);
  const msg = `${agent.name}: ${agent.task.replace(/\s+/g, " ").slice(0, 72)}`;
  const c = trySh("git", [...GIT, "commit", "-qm", msg], agent.worktree);
  if (c.ok) return { ok: true, detail: `committed ${branch}` };
  if (!dirtyPaths(agent.worktree).length) return { ok: true, detail: `已无未提交改动 (${branch})` };
  return { ok: false, detail: c.err.trim().split("\n")[0] };
}

function changedFiles(worktree: string): string[] {
  return dirtyPaths(worktree).map((l) => l.slice(3).trim()).filter(Boolean);
}

/* ---------------- 合并 ---------------- */

function mergeAll(task: Task): MergeResult[] {
  const base = ensureBaseRepo(task);
  const intDir = join(ROOT, task.id, "integration");
  const intBranch = `swarm/${short(task.id)}/integration`;

  if (existsSync(intDir)) {
    trySh("git", ["-C", base, "worktree", "remove", "--force", intDir]);
    if (existsSync(intDir)) rmSync(intDir, { recursive: true, force: true });
  }
  trySh("git", ["-C", base, "branch", "-D", intBranch]);
  const w = trySh("git", [...GIT, "-C", base, "worktree", "add", "-b", intBranch, intDir, "HEAD"]);
  if (!w.ok) {
    return task.agents.map((a) => ({ name: a.name, branch: a.branch, status: "skipped" as const, detail: w.err }));
  }

  const results: MergeResult[] = [];
  for (const a of task.agents) {
    if (a.state !== "done" || !a.branch) {
      results.push({ name: a.name, branch: a.branch, status: "skipped", detail: a.state !== "done" ? `执行代理状态 ${a.state}` : "无分支" });
      continue;
    }
    const c = commitAgent(a);
    if (!c.ok) {
      results.push({ name: a.name, branch: a.branch, status: "skipped", detail: `提交失败：${c.detail}` });
      continue;
    }
    const m = trySh("git", [...GIT, "merge", "--no-ff", "--no-edit", a.branch], intDir);
    if (m.ok) {
      results.push({ name: a.name, branch: a.branch, status: "merged", detail: "fast merge 成功" });
    } else {
      trySh("git", ["merge", "--abort"], intDir);
      results.push({ name: a.name, branch: a.branch, status: "conflict", detail: (m.out + m.err).trim().slice(0, 400) });
    }
  }
  return results;
}

// 把一个执行代理的全部依赖合成一个基准提交：先提交每个依赖，
// 再从第一个依赖分支拉出临时分支 deps-<index>，依次 merge 其余依赖。
// 这样多依赖的产物都真实可见；任何一步冲突都让该代理直接失败，不再静默只用其中一个依赖。
function mergeDependencyRefs(
  task: Task,
  agent: AgentRun,
  deps: AgentRun[],
): { ok: boolean; ref?: string; error?: string } {
  const base = ensureBaseRepo(task);

  for (const dep of deps) {
    const c = commitAgent(dep);
    if (!c.ok) return { ok: false, error: `依赖 ${dep.name} 提交失败：${c.detail}` };
  }

  const ref = `swarm/${short(task.id)}/deps-${agent.index + 1}`;
  const dir = join(ROOT, task.id, `deps-${agent.index + 1}`);
  if (existsSync(dir)) {
    trySh("git", ["-C", base, "worktree", "remove", "--force", dir]);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  trySh("git", ["-C", base, "branch", "-D", ref]);

  const first = deps[0];
  // 用依赖的实际分支而不是工作区 HEAD：代理可能自己切过分支，commitAgent 已校正 agent.branch
  const w = trySh("git", [...GIT, "-C", base, "worktree", "add", "-b", ref, dir, first.branch]);
  if (!w.ok) {
    return { ok: false, error: `无法创建依赖合并分支：${(w.out + w.err).trim().slice(0, 200)}` };
  }

  try {
    const merged = [first.name];
    for (const dep of deps.slice(1)) {
      const m = trySh("git", [...GIT, "-C", dir, "merge", "--no-ff", "--no-edit", dep.branch]);
      if (!m.ok) {
        trySh("git", ["-C", dir, "merge", "--abort"]);
        return {
          ok: false,
          error: `依赖合并冲突：${dep.name} 无法并入 ${merged.join("、")}（${(m.out + m.err).trim().slice(0, 200)}）`,
        };
      }
      merged.push(dep.name);
    }
    return { ok: true, ref };
  } finally {
    // 只保留分支，临时 worktree 用完即摘
    trySh("git", ["-C", base, "worktree", "remove", "--force", dir]);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- 验收 ---------------- */

// 依赖/构建/缓存目录一律不参与语法检查；.venv/venv/target/vendor/coverage 是各语言常见的重目录
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "data",
  "dist",
  "build",
  ".venv",
  "venv",
  "target",
  "vendor",
  "coverage",
  ".pytest_cache",
]);

interface SourceBuckets {
  py: string[];
  sh: string[];
  js: string[];
  html: string[];
}

// 一次遍历按扩展名分桶：Dirent 自带类型，不再逐层 statSync。
// 每个桶各自保留 200 文件上限（与改造前每类分别 walk 的结果一致），四桶全满才提前结束。
async function collectSources(dir: string, maxPerBucket = 200): Promise<SourceBuckets> {
  const buckets: SourceBuckets = { py: [], sh: [], js: [], html: [] };
  const full = () =>
    buckets.py.length >= maxPerBucket &&
    buckets.sh.length >= maxPerBucket &&
    buckets.js.length >= maxPerBucket &&
    buckets.html.length >= maxPerBucket;
  const walk = async (d: string): Promise<void> => {
    if (full()) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (full()) return;
      const name = ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(join(d, name));
        continue;
      }
      if (!ent.isFile()) continue;
      let bucket: keyof SourceBuckets | null = null;
      if (name.endsWith(".py")) bucket = "py";
      else if (name.endsWith(".sh") || name.endsWith(".bash")) bucket = "sh";
      else if (name.endsWith(".mjs") || name.endsWith(".cjs")) bucket = "js";
      else if (name.endsWith(".html")) bucket = "html";
      if (!bucket || buckets[bucket].length >= maxPerBucket) continue;
      buckets[bucket].push(join(d, name));
    }
  };
  await walk(dir);
  return buckets;
}

function quote(p: string) {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

async function detectChecks(dir: string): Promise<{ name: string; command: string }[]> {
  const checks: { name: string; command: string }[] = [];

  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const pj = JSON.parse(await readFile(pkg, "utf8"));
      if (pj?.scripts?.test) checks.push({ name: "npm test", command: "npm test --silent" });
    } catch {
      /* ignore */
    }
  }

  const sources = await collectSources(dir);
  const py = sources.py.map((p) => relative(dir, p));
  if (py.length) checks.push({ name: `python 语法 (${py.length} 文件)`, command: `python3 -m py_compile ${py.map(quote).join(" ")}` });

  const shFiles = sources.sh.map((p) => relative(dir, p));
  if (shFiles.length) checks.push({ name: `shell 语法 (${shFiles.length} 文件)`, command: `bash -n ${shFiles.map(quote).join(" ")}` });

  const js = sources.js.map((p) => relative(dir, p));
  if (js.length) checks.push({ name: `node 语法 (${js.length} 文件)`, command: `node --check ${js.map(quote).join(" ")}` });

  const html = sources.html.map((p) => relative(dir, p));
  if (html.length) {
    const list = html.map(quote).join(" ");
    checks.push({
      name: `HTML 结构 (${html.length} 文件)`,
      command: `for f in ${list}; do test -s "$f" && grep -qi "<html" "$f" || { echo "invalid: $f"; exit 1; }; done`,
    });
  }

  const testsDir = join(dir, "tests");
  if (existsSync(testsDir) && py.length && !checks.some((c) => c.name.startsWith("python 语法"))) {
    checks.push({ name: "pytest", command: "python3 -m pytest -q" });
  }

  return checks;
}

// 检查串行执行（顺序有语义），单条命令在沙箱里异步跑，超时/取消由 runSandboxedCommand 处理
async function runChecks(
  dir: string,
  checks: { name: string; command: string }[],
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    if (signal?.aborted) break;
    const r = await runSandboxedCommand(c.command, { cwd: dir, signal });
    // 没有 bwrap 或显式关闭时如实标出隔离退化，避免把宿主机执行误当成沙箱结果
    const output = r.sandboxed
      ? r.output
      : `${r.output}\n[隔离退化] 未启用 bubblewrap 沙箱（SWARM_SANDBOX=off 或找不到 bwrap），命令直接在宿主机执行`.slice(-4000);
    results.push({ name: c.name, command: c.command, ok: r.ok, exitCode: r.exitCode, output, ms: r.ms });
  }
  return results;
}

const BANNED_CMD = /(rm\s+-rf\s+\/|sudo\b|mkfs|dd\s+if=|curl[^|]*\|\s*(sh|bash)|wget[^|]*\|\s*(sh|bash))/i;

async function verify(task: Task, merge: MergeResult[], signal?: AbortSignal): Promise<Verification> {
  const intDir = join(ROOT, task.id, "integration");
  const auto = await detectChecks(intDir);
  const contractCmds = (Array.isArray(task.boss.contract?.verify) ? task.boss.contract.verify : [])
    .filter((c: any) => typeof c === "string" && c.trim() && !BANNED_CMD.test(c))
    .map((c: string) => ({ name: `契约检查: ${c.slice(0, 70)}`, command: c }));
  const checks = [...auto, ...contractCmds];
  // 沙箱是第一道防线，BANNED_CMD 只是第二道
  const results = await runChecks(intDir, checks, signal);
  throwIfAborted(signal);

  // 合并后相对分叉点的真实差异。base 仓库的默认分支不一定是 main（可能是 master），
  // 所以先解析它，再用 merge-base 取分叉提交，避免基分支在任务期间前进带来的噪声。
  let diffStat = "";
  try {
    const baseBranch = (() => {
      if (!task.baseRepo) return "main";
      const r = trySh("git", ["-C", task.baseRepo, "rev-parse", "--abbrev-ref", "HEAD"]);
      const name = r.ok ? r.out.trim() : "";
      return name && name !== "HEAD" ? name : "main";
    })();
    const mb = trySh("git", ["-C", intDir, "merge-base", "HEAD", baseBranch]);
    const ref = mb.ok && mb.out.trim() ? mb.out.trim() : "HEAD^1";
    diffStat = sh("git", [...GIT, "-C", intDir, "diff", "--stat", ref], intDir);
  } catch {
    diffStat = "";
  }
  void merge;

  return {
    ok: results.every((r) => r.ok),
    integrationDir: intDir,
    integrationBranch: `swarm/${short(task.id)}/integration`,
    checks: results,
    diffStat,
  };
}

/* ---------------- 流程 ---------------- */

async function plan(task: Task, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  transition(task, "planning");
  task.boss.state = "planning";
  putTask(task);

  const orchDir = join(ROOT, task.id, "orchestrator");
  mkdirSync(orchDir, { recursive: true });

  const session = await makeBossSession(orchDir);
  // 规划文本按 60ms 合帧发增量；完整 boss 事件在 finally 里作为最终真相
  const batcher = createDeltaBatcher((delta) => emit({ type: "boss-delta", taskId: task.id, delta }));
  try {
    const prompt = [
      BOSS_PLAN_SYSTEM,
      BOSS_PLAN_TASK(task.goal, task.agents.length, CODENAMES.slice(0, task.agents.length)),
    ].join("\n\n");

    let acc = "";
    session.subscribe((ev: any) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        const delta = ev.assistantMessageEvent.delta as string;
        acc += delta;
        task.boss.text = acc;
        batcher.push(delta);
      }
    });
    await raceAbort(session.prompt(prompt), signal);
    throwIfAborted(signal);
    task.boss.usage = addUsage(task.boss.usage, usageDelta(session));

    const text = acc || session.getLastAssistantText?.() || "";
    task.boss.plan = text;

    let result = parsePlan(text, task.agents.length);

    // 规划输出不合法：把具体错误发回模型，要求只输出修正后的 JSON；只重试一次。
    // 仍不合法就让任务失败，不再编造任务。
    if (!result.ok) {
      const errors = result.errors.slice(0, 12).map((e) => `- ${e}`).join("\n");
      await raceAbort(
        session.prompt(
          `你上一条输出不符合规划契约，具体问题：\n${errors}\n\n` +
            "你没有工具，不能执行命令或读取文件。请只输出修正后的完整 JSON（{\"contract\":…,\"tasks\":[…]} 或 tasks 数组），" +
            "tasks 数量必须等于执行代理数，name 唯一且非空，depends_on 只能引用存在的 name。不要输出任何其它文字。",
        ),
        signal,
      );
      throwIfAborted(signal);
      task.boss.usage = addUsage(task.boss.usage, usageDelta(session));
      const retry = (session.getLastAssistantText?.() || acc || "").trim();
      if (retry) {
        task.boss.plan = `${text}\n\n--- retry ---\n\n${retry}`;
        result = parsePlan(retry, task.agents.length);
      }
    }
    if (!result.ok) throw new Error(`规划输出不合法：${result.errors.slice(0, 6).join("；")}`);

    task.boss.contract = result.contract;
    task.boss.planList = result.tasks.map((t) => ({ name: t.name, task: t.task }));
    // 规划校验保证 tasks 数量与代理数一致，这里按位置一一对应，不再静默复用最后一个任务
    task.agents.forEach((a, i) => {
      const item = result.tasks[i];
      a.name = item.name;
      a.task = item.task;
      a.scope = item.scope;
      a.acceptance = item.acceptance;
      a.evidence = item.evidence;
      a.dependsOn = item.dependsOn;
    });
    task.boss.state = "done";
  } finally {
    // 先 flush 剩余增量，再发完整 boss；取消/异常也走这里，定时器不会残留
    batcher.flush();
    emit({ type: "boss", taskId: task.id, boss: task.boss });
    session.dispose();
  }
}

async function runAgent(task: Task, agent: AgentRun, opts?: { reason?: string; detail?: string; baseRef?: string; signal?: AbortSignal }): Promise<void> {
  // 取消后不再为排队中的代理创建 worktree
  if (opts?.signal?.aborted) {
    agent.state = "cancelled";
    agent.error = "已取消";
    agent.startedAt = agent.startedAt || Date.now();
    agent.endedAt = Date.now();
    emit({ type: "agent", taskId: task.id, agent });
    return;
  }
  agent.state = "booting";
  agent.startedAt = Date.now();
  agent.endedAt = null;
  agent.error = null;
  agent.text = "";
  emit({ type: "agent", taskId: task.id, agent });

  const { dir, branch } = prepareWorktree(task, agent.index, opts?.baseRef || "HEAD");
  agent.worktree = dir;
  agent.branch = branch;
  agent.state = "working";
  emit({ type: "agent", taskId: task.id, agent });

  if (opts?.signal?.aborted) {
    agent.state = "cancelled";
    agent.error = "已取消";
    agent.endedAt = Date.now();
    emit({ type: "agent", taskId: task.id, agent });
    return;
  }

  const env: Record<string, string> = {
    AGENT_ID: agent.id,
    SWARM_SHOT_JS: join(APP_ROOT, "tools", "worker-shot.mjs"),
    SWARM_PLAYWRIGHT_CORE: join(APP_ROOT, "node_modules", "playwright-core", "index.js"),
  };
  if (process.env.SWARM_GATEWAY_URL) {
    env.GOOGLE_GEMINI_BASE_URL = process.env.SWARM_GATEWAY_URL;
    if (process.env.SWARM_GATEWAY_KEY) env.GEMINI_API_KEY = process.env.SWARM_GATEWAY_KEY;
  }

  const parts = [
    WORKER_PREAMBLE(task.boss.contract),
    WORKER_TASK({ task: agent.task, scope: agent.scope, acceptance: agent.acceptance, evidence: agent.evidence }),
  ];
  if (opts?.reason) parts.push(REWORK_AGENT_TASK(opts.reason, opts.detail || ""));

  // 文本增量按 60ms 合帧；状态变化仍发完整 agent（booting/working/done/...）
  const batcher = createDeltaBatcher((delta) => emit({ type: "agent-delta", taskId: task.id, agentId: agent.id, delta }));

  const res = await (async () => {
    try {
      return await runAgyTask({
        prompt: parts.join("\n\n"),
        cwd: dir,
        agentId: agent.id,
        env,
        timeoutMs: Number(process.env.SWARM_AGENT_TIMEOUT_MS || 600_000),
        signal: opts?.signal,
        onText: (delta, full) => {
          agent.text = full;
          batcher.push(delta);
        },
      });
    } finally {
      // 取消/异常也先 flush，剩余文本不会丢，定时器也不会残留
      batcher.flush();
    }
  })();

  agent.usage = res.usage;
  agent.spent = (agent.spent || 0) + (res.usage?.totalTokens || 0);
  agent.endedAt = Date.now();
  const cancelled = res.error === "已取消" || !!opts?.signal?.aborted;
  agent.state = cancelled ? "cancelled" : res.error ? "failed" : "done";
  agent.error = cancelled ? "已取消" : res.error || null;
  agent.changedFiles = changedFiles(dir);
  emit({ type: "agent", taskId: task.id, agent });
}

async function runVerifier(task: Task, verification: Verification, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const intDir = join(ROOT, task.id, "integration");
  const checks = verification.checks
    .map((c) => `- [${c.ok ? "PASS" : "FAIL"}] ${c.name}: ${(c.output || "").slice(0, 200).replace(/\s+/g, " ")}`)
    .join("\n");
  task.verifier = { state: "working", text: "", usage: null, error: null };
  putTask(task);

  const res = await runAgyTask({
    prompt: VERIFIER_TASK(task.goal, task.boss.contract?.dod || [], checks),
    cwd: intDir,
    agentId: "verifier",
    timeoutMs: Number(process.env.SWARM_VERIFIER_TIMEOUT_MS || 600_000),
    signal,
    onText: (_d, full) => {
      if (task.verifier) task.verifier.text = full;
      emit({ type: "task", task: task });
    },
  });

  if (res.error === "已取消" || signal?.aborted) {
    task.verifier = { state: "failed", text: res.text, usage: res.usage, error: "已取消" };
    putTask(task);
    throw new TaskCancelled();
  }

  task.verifier = {
    state: res.error ? "failed" : "done",
    text: res.text,
    usage: res.usage,
    error: res.error || null,
  };
  putTask(task);
}

/* ---------------- 返工 ---------------- */

type Problem =
  | { kind: "failed"; agent: AgentRun; name: string; reason: string; detail: string }
  | { kind: "conflict"; agent: AgentRun | null; name: string; reason: string; detail: string }
  | { kind: "check"; name: string; reason: string; detail: string };

function integrationHead(task: Task): string {
  const r = trySh("git", ["-C", join(ROOT, task.id, "integration"), "rev-parse", "HEAD"]);
  return r.ok ? r.out.trim() : "HEAD";
}

function collectProblems(task: Task): Problem[] {
  const out: Problem[] = [];
  for (const a of task.agents) {
    if (a.state === "failed") {
      out.push({ kind: "failed", agent: a, name: a.name, reason: "执行代理本轮执行失败", detail: a.error || "无错误信息" });
    }
  }
  for (const m of task.merge) {
    if (m.status !== "conflict") continue;
    const agent = task.agents.find((a) => a.branch === m.branch) || null;
    out.push({ kind: "conflict", agent, name: m.name, reason: "合并冲突", detail: m.detail });
  }
  for (const c of task.verification?.checks || []) {
    if (c.ok) continue;
    out.push({ kind: "check", name: c.name, reason: `检查命令失败：${c.command}`, detail: `exit ${c.exitCode}\n${c.output}` });
  }
  return out;
}

function problemsText(ps: Problem[]): string {
  return ps
    .map((p, i) => `${i + 1}. [${p.kind}] ${p.name} — ${p.reason}\n${p.detail.slice(0, 1200)}`)
    .join("\n\n");
}

// 返工只做一件事：把失败证据交回给它真正能改的那一层。
// 执行代理级问题（未跑完 / 分支冲突）→ 基于当前 integration 提交重做；
// 只有自动检查失败（多份改动叠加后才暴露）→ 修复代理直接在合并树上修。
async function reworkOnce(task: Task, round: number, signal?: AbortSignal): Promise<"none" | "progress" | "stalled"> {
  throwIfAborted(signal);
  const problems = collectProblems(task);
  if (!problems.length) return "none";

  transition(task, "rework");
  putTask(task);

  const agentProblems = problems.filter((p) => p.kind === "failed" || p.kind === "conflict");

  if (agentProblems.length) {
    const baseRef = integrationHead(task);
    const detail = problemsText(agentProblems);
    const seen = new Set<string>();
    for (const p of agentProblems) {
      throwIfAborted(signal);
      const agent = p.agent;
      if (!agent || seen.has(agent.id)) continue;
      seen.add(agent.id);
      await runAgent(task, agent, { reason: p.reason, detail, baseRef, signal });
      task.rework.push({
        round,
        target: "agent",
        who: agent.name,
        reason: p.reason,
        detail,
        text: agent.text,
        usage: agent.usage,
        ok: agent.state === "done",
      });
      putTask(task);
    }

    throwIfAborted(signal);
    transition(task, "merging");
    putTask(task);
    task.merge = mergeAll(task);
    throwIfAborted(signal);
    transition(task, "verifying");
    putTask(task);
    task.verification = await verify(task, task.merge, signal);
    putTask(task);
    return "progress";
  }

  const intDir = join(ROOT, task.id, "integration");
  const detail = problemsText(problems);
  const before = integrationHead(task);
  const entry = {
    round,
    target: "fixer" as const,
    who: `修复代理 #${round}`,
    reason: `合并后自动检查失败 ${problems.length} 项`,
    detail,
    text: "",
    usage: null,
    ok: false,
  };
  task.rework.push(entry);
  putTask(task);

  const res = await runAgyTask({
    prompt: FIXER_TASK(task.goal, task.boss.contract?.dod || [], detail),
    cwd: intDir,
    agentId: "fixer",
    timeoutMs: Number(process.env.SWARM_FIXER_TIMEOUT_MS || 600_000),
    signal,
    onText: (_d, full) => {
      entry.text = full;
      emit({ type: "task", task });
    },
  });

  if (res.error === "已取消" || signal?.aborted) {
    entry.text = res.text || entry.text;
    entry.reason += "（已取消）";
    putTask(task);
    throw new TaskCancelled();
  }

  trySh("git", ["-C", intDir, "add", "-A", "--", ".", ...JUNK]);
  const c = trySh("git", [...GIT, "-C", intDir, "commit", "-qm", `fixer #${round}: 修复合并后的自动检查失败`], intDir);
  const after = integrationHead(task);

  entry.text = res.text || entry.text;
  entry.usage = (res.usage || null) as any;
  entry.ok = before !== after || (c.ok && !res.error);
  if (res.error) entry.reason += `（修复代理报错：${res.error}）`;
  putTask(task);

  task.verification = await verify(task, task.merge, signal);
  throwIfAborted(signal);
  putTask(task);
  // 修复代理直接在合并树上改完并已重新验证，本轮回到 verifying
  transition(task, "verifying");
  // 修复代理未修改任何文件时，再开一轮没有意义，直接交给裁决
  return before !== after ? "progress" : "stalled";
}

async function judge(task: Task, verification: Verification, merge: MergeResult[], signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const orchDir = join(ROOT, task.id, "orchestrator");
  const session = await makeBossSession(orchDir);
  try {
    const audit = [
      `目标：${task.goal}`,
      `合并结果：\n${merge.map((m) => `- ${m.name}: ${m.status} (${m.branch}) ${m.detail}`).join("\n")}`,
      `合并后 diff stat：\n${verification.diffStat || "(空)"}`,
      `检查命令与结果：\n${
        verification.checks.length
          ? verification.checks
              .map((c) => `- [${c.ok ? "PASS" : "FAIL"}] ${c.name} (exit ${c.exitCode})\n${c.output.slice(-800)}`)
              .join("\n")
          : "(没有可识别的自动检查命令)"
      }`,
      `独立验证器（看到合并后的完整代码，自行选择验证方式，证据优先于执行代理自述）：\n${task.verifier?.text || "(未运行)"}`,
      `执行代理自述（仅供参考，不可当作证据）：\n${task.agents
        .map((a) => `- ${a.name}: ${a.text.slice(-400).replace(/\s+/g, " ")}`)
        .join("\n")}`,
    ].join("\n\n");

    const hardPass =
      verification.ok &&
      merge.some((m) => m.status === "merged") &&
      merge.every((m) => m.status !== "conflict") &&
      task.agents.every((a) => a.state === "done");

    const prompt = [BOSS_JUDGE_SYSTEM, BOSS_JUDGE_TASK(audit)].join("\n\n");

    let acc = "";
    session.subscribe((ev: any) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        acc += ev.assistantMessageEvent.delta;
      }
    });
    await raceAbort(session.prompt(prompt), signal);
    throwIfAborted(signal);
    task.boss.summaryUsage = addUsage(task.boss.summaryUsage, usageDelta(session));
    const raw = (acc || session.getLastAssistantText?.() || "").trim();
    const cleaned = raw
      .replace(/<[\s\S]*?>/g, " ")
      .replace(/[｜|]{1,2}\s*DSML\s*[｜|]{1,2}/gi, " ")
      .replace(/[｜|]{2}/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    let modelPass: boolean | null = null;
    let reasons: string[] = [];

    // 以 BOSS_JUDGE_TASK 约定的单行协议为准：先认 PASS:/FAIL:（允许中文「通过/不通过」与全角冒号）
    const line = /^\s*(PASS|FAIL|通过|不通过|未通过)\s*[:：]?\s*(.*)$/i.exec(cleaned);
    if (line) {
      const v = line[1];
      modelPass = /^PASS$/i.test(v) || v === "通过";
      const reason = line[2].replace(/^[-—:：\s]+/, "").trim();
      if (reason) reasons = [reason];
    } else {
      // 兼容旧模型输出：单行协议解析不到时再看 JSON
      for (const rawJson of jsonCandidates(raw)) {
        try {
          const j = JSON.parse(rawJson);
          if (j && typeof j === "object" && !Array.isArray(j) && "pass" in j) {
            modelPass = !!j.pass;
            reasons = Array.isArray(j.reasons) ? j.reasons.map(String).slice(0, 3) : [];
            break;
          }
        } catch {
          /* 试下一个候选 */
        }
      }
    }

    // 硬证据优先：自动检查与合并结果决定通过与否，模型只能否决不能被采信为通过
    const pass = hardPass && modelPass !== false;
    if (!reasons.length) {
      reasons = [
        hardPass
          ? `自动检查与合并均通过；编排器${modelPass === false ? "有保留" : "无异议"}。`
          : verification.checks.some((c) => !c.ok)
            ? `自动检查失败：${verification.checks.filter((c) => !c.ok).map((c) => c.name).join("、")}`
            : merge.some((m) => m.status === "conflict")
              ? "存在合并冲突"
              : "执行代理未全部正常完成",
      ];
    }
    task.verdict = { pass, reasons, raw: (cleaned || raw).slice(0, 2000) };
    task.boss.state = "done";
  } catch (e: any) {
    if (isCancelled(e, signal)) throw e;
    task.verdict = { pass: false, reasons: [`判定失败：${e?.message || e}`], raw: "" };
    task.boss.state = "failed";
  } finally {
    session.dispose();
    emit({ type: "boss", taskId: task.id, boss: task.boss });
  }
}

async function aggregate(task: Task, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  transition(task, "aggregating");
  putTask(task);
  const orchDir = join(ROOT, task.id, "orchestrator");
  const session = await makeBossSession(orchDir);
  try {
    const reports = task.agents
      .map(
        (a) =>
          `## ${a.name}（${a.state}，${a.usage?.totalTokens ?? 0} tokens）\n改动：${a.changedFiles.join(", ") || "无"}\n结果：${a.text.slice(-900) || a.error || "无输出"}`,
      )
      .join("\n\n");
    const ctx = [
      `合并已由系统完成：${task.merge.map((m) => `${m.name}=${m.status}`).join("，")}`,
      `自动检查：${task.verification?.ok ? "通过" : "未通过"}`,
    ].join("\n");
    const prompt = BOSS_SUMMARY_TASK(`${ctx}\n\n${reports}`);

    let acc = "";
    session.subscribe((ev: any) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        acc += ev.assistantMessageEvent.delta;
      }
    });
    await raceAbort(session.prompt(prompt), signal);
    throwIfAborted(signal);
    task.boss.summaryUsage = addUsage(task.boss.summaryUsage, usageDelta(session));
    task.summary = cleanModelText(acc || session.getLastAssistantText?.() || "");
    task.boss.state = "done";
  } catch (e: any) {
    if (isCancelled(e, signal)) throw e;
    task.summary = `汇总失败：${e?.message || e}`;
    task.boss.state = "failed";
  } finally {
    session.dispose();
    emit({ type: "boss", taskId: task.id, boss: task.boss });
  }
}

async function runTask(task: Task, signal?: AbortSignal) {
  try {
    throwIfAborted(signal);
    ensureBaseRepo(task);
    throwIfAborted(signal);
    await plan(task, signal);
    throwIfAborted(signal);
    transition(task, "running");
    putTask(task);

    // 按 dependsOn 分批推进：无依赖的先跑，依赖满足后再跑下一批
    const doneNames = new Set<string>();
    let remaining = [...task.agents];
    while (remaining.length) {
      throwIfAborted(signal);
      let ready = remaining.filter((a) => (a.dependsOn || []).every((d) => doneNames.has(d)));
      if (!ready.length) ready = remaining; // 循环依赖兜底：剩下的全部放行
      await Promise.all(
        ready.map(async (a) => {
          // 有依赖的执行代理从「全部依赖合并后的提交」出发，确保多依赖的产物都可见；
          // 依赖合并冲突时该代理直接失败，不再静默只取其中一个依赖。
          const deps = [...new Set(a.dependsOn || [])]
            .map((n) => task.agents.find((x) => x.name === n && x.state === "done" && x.branch))
            .filter(Boolean) as AgentRun[];
          let baseRef: string | undefined;
          if (deps.length) {
            const merged = mergeDependencyRefs(task, a, deps);
            if (!merged.ok) {
              a.state = "failed";
              a.error = merged.error;
              a.startedAt = a.startedAt || Date.now();
              a.endedAt = Date.now();
              emit({ type: "agent", taskId: task.id, agent: a });
              return;
            }
            baseRef = merged.ref;
          }
          return runAgent(task, a, { baseRef, signal });
        }),
      );
      // 取消后不再进入下一批，也不再把状态写回 running
      throwIfAborted(signal);
      for (const a of ready) doneNames.add(a.name);
      recount(task);
      putTask(task);
      remaining = remaining.filter((a) => !ready.includes(a));
    }

    throwIfAborted(signal);
    transition(task, "merging");
    putTask(task);
    task.merge = mergeAll(task);
    throwIfAborted(signal);
    putTask(task);

    transition(task, "verifying");
    putTask(task);
    task.verification = await verify(task, task.merge, signal);
    throwIfAborted(signal);
    putTask(task);

    // 自动检查失败 → 返工，最多 N 轮；每轮只处理一类问题，改完重新合并并/重跑验收
    const maxRounds = Math.max(0, Number(process.env.SWARM_REWORK_ROUNDS ?? 2));
    for (let round = 1; round <= maxRounds; round++) {
      throwIfAborted(signal);
      const acted = await reworkOnce(task, round, signal);
      if (acted === "none" || acted === "stalled") break;
      recount(task);
      putTask(task);
    }

    transition(task, "verifying");
    putTask(task);
    await runVerifier(task, task.verification, signal);

    await aggregate(task, signal);
    await judge(task, task.verification, task.merge, signal);

    transition(task, "done");
  } catch (e: any) {
    if (isCancelled(e, signal) || task.state === "cancelled") {
      // 取消由 cancelTask 统一落状态与系统消息，这里只保证不再被改成 failed
      transition(task, "cancelled");
      task.error = task.error || "已取消";
    } else {
      transition(task, "failed");
      task.error = e?.message || String(e);
      task.boss.state = "failed";
      noteSystem(task.id, `任务 ${task.id.slice(0, 8)} 执行失败：${task.error}`, "error");
    }
  } finally {
    // 任务可能在取消后已被删除：不要再把旧快照写回
    if (!deletedTasks.has(task.id)) {
      task.finishedAt = task.finishedAt || Date.now();
      recount(task);
      putTask(task);
    }
  }
}

export function recount(task: Task) {
  const boss = (task.boss.usage?.totalTokens || 0) + (task.boss.summaryUsage?.totalTokens || 0);
  const agents = task.agents.reduce((n, a) => n + (a.spent || a.usage?.totalTokens || 0), 0);
  const verifier = task.verifier?.usage?.totalTokens || 0;
  // 执行代理返工开销已计入 agent.spent，这里只补修复代理
  const fixers = (task.rework || []).filter((r) => r.target === "fixer").reduce((n, r) => n + (r.usage?.totalTokens || 0), 0);
  task.totalUsage = boss + agents + verifier + fixers;
}

export function createTask(input: { goal: string; agents?: number; repoPath?: string }): Task {
  const count = Math.max(1, Math.min(8, Number(input.agents) || 3));
  const task: Task = {
    id: randomUUID(),
    goal: input.goal,
    repoPath: input.repoPath || null,
    baseRepo: null,
    state: "planning",
    createdAt: Date.now(),
    finishedAt: null,
    boss: { state: "idle", text: "", plan: "", planList: [], contract: null, usage: null, summaryUsage: null },
    agents: Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      index: i,
      name: CODENAMES[i % CODENAMES.length],
      task: "",
      scope: [],
      acceptance: [],
      evidence: [],
      dependsOn: [],
      worktree: "",
      branch: "",
      state: "queued",
      text: "",
      usage: null,
      spent: 0,
      startedAt: null,
      endedAt: null,
      error: null,
      changedFiles: [],
    })),
    totalUsage: 0,
    summary: "",
    merge: [],
    verification: null,
    verifier: null,
    verdict: null,
    rework: [],
    promote: null,
    error: null,
  };
  const controller = new AbortController();
  controllers.set(task.id, controller);
  putTask(task);
  // 推迟到微任务，让会话来得及先把 taskId 绑上（失败时的系统消息才不会丢）
  queueMicrotask(() => {
    void runTask(task, controller.signal).finally(() => {
      controllers.delete(task.id);
    });
  });
  return task;
}

// 任务级取消：中断运行中的 agy、把未结束的代理标为 cancelled，并落一条会话系统消息
export function cancelTask(id: string): Task | undefined {
  const task = getTask(id);
  if (!task) return undefined;
  if (!isTaskLive(task)) return task;

  controllers.get(id)?.abort();

  const now = Date.now();
  transition(task, "cancelled");
  task.error = "已取消";
  task.finishedAt = task.finishedAt || now;
  for (const a of task.agents) {
    if (a.state === "queued" || a.state === "booting" || a.state === "working") {
      a.state = "cancelled";
      a.error = "已取消";
      a.endedAt = a.endedAt || now;
    }
  }
  if (task.verifier && task.verifier.state === "working") task.verifier.state = "failed";
  putTask(task);
  noteSystem(id, `任务 ${id.slice(0, 8)} 已取消`, "event");
  return task;
}

// 删除任务及其运行目录：先摘 worktree，再删 runs/<id>，最后删任务快照
export function cleanupTask(id: string): boolean {
  const task = getTask(id);
  if (!task) return false;
  deletedTasks.add(id);

  const worktrees = [...task.agents.map((a) => a.worktree), join(ROOT, id, "integration")].filter(
    (p): p is string => !!p && existsSync(p),
  );
  for (const wt of worktrees) {
    if (task.baseRepo) trySh("git", ["-C", task.baseRepo, "worktree", "remove", "--force", wt]);
    if (existsSync(wt)) {
      try {
        rmSync(wt, { recursive: true, force: true });
      } catch {
        /* 已被 git 清掉 */
      }
    }
  }
  // 基础仓库可能就在 runs/<id> 下（临时仓库），整目录删掉即可，不会碰到用户自己的仓库
  try {
    rmSync(join(ROOT, id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  controllers.delete(id);
  removeTask(id);
  emit({ type: "task-deleted", taskId: id });
  return true;
}

export function getRecordState() {
  return store().recordEnabled;
}

/* ---------------- 合回主干 ---------------- */

export function promoteTask(task: Task, force = false): PromoteResult {
  const base =
    task.baseRepo ||
    (task.repoPath && existsSync(join(task.repoPath, ".git")) ? task.repoPath : null);
  const target = task.baseBranch || (base && actualBranch(base)) || "main";

  const record = (ok: boolean, detail: string, commit?: string) => {
    const r: PromoteResult = { at: Date.now(), target, ok, detail, commit };
    task.promote = r;
    putTask(task);
    return r;
  };

  if (!base) return record(false, "找不到基础仓库");
  if (!task.verification) return record(false, "还没有完成合并与验证");
  if (!force && !task.verdict?.pass) {
    return record(false, `验证未通过，拒绝合入。${task.verdict?.reasons?.[0] || ""}`);
  }

  const dirty = trySh("git", ["-C", base, "status", "--porcelain", "--untracked-files=no"]);
  if (dirty.ok && dirty.out.trim()) return record(false, "基础仓库有未提交改动，先处理干净再合入");

  const branch = task.verification.integrationBranch;
  if (!trySh("git", ["-C", base, "rev-parse", "--verify", branch]).ok) {
    return record(false, `整合分支不存在：${branch}`);
  }

  const m = trySh("git", [...GIT, "-C", base, "merge", "--no-ff", "--no-edit", branch]);
  if (!m.ok) {
    trySh("git", ["-C", base, "merge", "--abort"]);
    return record(false, `合入失败，已回滚：${(m.out + m.err).trim().slice(0, 400)}`);
  }

  const commit = trySh("git", ["-C", base, "rev-parse", "--short", "HEAD"]).out.trim();
  return record(true, `已把 ${branch} 合入 ${target}`, commit);
}

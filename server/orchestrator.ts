import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runAgyTask } from "./acp.ts";
import { getTask, putTask, emit, store } from "./store.ts";
import { BOSS_JUDGE_SYSTEM, BOSS_JUDGE_TASK, BOSS_PLAN_SYSTEM, BOSS_PLAN_TASK, BOSS_SUMMARY_TASK, FIXER_TASK, REWORK_AGENT_TASK, VERIFIER_TASK, WORKER_PREAMBLE, WORKER_TASK } from "./prompts.ts";
import type { AgentRun, CheckResult, MergeResult, PromoteResult, Task, Verification } from "../lib/types.ts";

const ROOT = process.env.SWARM_ROOT || join(process.cwd(), "data", "runs");
const BOSS_PROVIDER = process.env.BOSS_PROVIDER || "1";
const BOSS_MODEL = process.env.BOSS_MODEL || "deepseek-v4.1-flash";
const GIT = ["-c", "user.email=swarm@local", "-c", "user.name=swarm"];

const CODENAMES = [
  "Atlas", "Nova", "Lyra", "Orion", "Vega", "Rune", "Echo", "Kite",
  "Sable", "Flint", "Juno", "Onyx", "Pike", "Quill", "Reed", "Tess",
];

function sh(cmd: string, args: string[], cwd?: string) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

/* ---------------- 包工头 ---------------- */

async function makeBossSession(cwd: string) {
  const pi: any = await import("@earendil-works/pi-coding-agent");
  const modelRuntime = await pi.ModelRuntime.create();
  const model = modelRuntime.getModel(BOSS_PROVIDER, BOSS_MODEL);
  if (!model) throw new Error(`包工头模型不可用: ${BOSS_PROVIDER}/${BOSS_MODEL}`);
  const { session } = await pi.createAgentSession({
    model,
    modelRuntime,
    cwd,
    noTools: true,
    sessionManager: pi.SessionManager.inMemory(cwd),
  });
  return session;
}

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

function flatten(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(flatten).filter(Boolean).join("\n");
  if (typeof v === "object") {
    return Object.entries(v)
      .filter(([k]) => !["id", "codename", "name", "title", "parallel_group", "depends_on"].includes(k))
      .map(([k, val]) => `${k}: ${flatten(val)}`)
      .join("\n");
  }
  return String(v);
}

function normalizeTask(x: any, i: number): { name: string; task: string; scope: string[]; acceptance: string[]; evidence: string[]; dependsOn: string[] } {
  const name = String(x.name || x.codename || x.title || CODENAMES[i % CODENAMES.length]).slice(0, 24);
  const body = x.task || x.description
    ? flatten(x.task || x.description)
    : [
        x.title ? `目标：${x.title}` : "",
        x.instructions ? `步骤：\n${flatten(x.instructions)}` : "",
        x.inputs ? `输入：\n${flatten(x.inputs)}` : "",
        x.acceptance_criteria ? `验收：\n${flatten(x.acceptance_criteria)}` : "",
      ].filter(Boolean).join("\n\n");
  return {
    name,
    task: body,
    scope: Array.isArray(x.scope) ? x.scope.map(String) : [],
    acceptance: Array.isArray(x.acceptance) ? x.acceptance.map(String) : Array.isArray(x.acceptance_criteria) ? x.acceptance_criteria.map(String) : [],
    evidence: Array.isArray(x.evidence) ? x.evidence.map(String) : [],
    dependsOn: Array.isArray(x.depends_on) ? x.depends_on.map(String) : Array.isArray(x.dependsOn) ? x.dependsOn.map(String) : [],
  };
}

function parsePlan(text: string, goal: string, count: number) {
  const cleaned = text.replace(/```json/gi, "```").replace(/```/g, "");
  const candidates: string[] = [];
  const os = cleaned.indexOf("{");
  const oe = cleaned.lastIndexOf("}");
  if (os >= 0 && oe > os) candidates.push(cleaned.slice(os, oe + 1));
  const as = cleaned.indexOf("[");
  const ae = cleaned.lastIndexOf("]");
  if (as >= 0 && ae > as) candidates.push(cleaned.slice(as, ae + 1));

  for (const raw of candidates) {
    try {
      const j = JSON.parse(raw);
      if (j && !Array.isArray(j) && j.contract && Array.isArray(j.tasks) && j.tasks.length) {
        return { contract: j.contract, tasks: j.tasks.slice(0, count).map(normalizeTask) };
      }
      if (Array.isArray(j) && j.length) {
        return { contract: null, tasks: j.slice(0, count).map(normalizeTask) };
      }
    } catch {
      /* 试下一个候选 */
    }
  }

  return {
    contract: null,
    tasks: Array.from({ length: count }, (_, i) => ({
      name: CODENAMES[i % CODENAMES.length],
      task: `${goal}\n\n你是第 ${i + 1}/${count} 个执行者。先查看当前目录，只完成与你的编号对应的那部分工作；若无法切分，就独立完成整个目标中最基础的一步，并在结果里说明你做了什么。`,
      scope: [] as string[],
      acceptance: [] as string[],
      evidence: [] as string[],
      dependsOn: [] as string[],
    })),
  };
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
  if (task.baseRepo) return task.baseRepo;

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
      results.push({ name: a.name, branch: a.branch, status: "skipped", detail: a.state !== "done" ? `工人状态 ${a.state}` : "无分支" });
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

/* ---------------- 验收 ---------------- */

function walkFiles(dir: string, exts: string[], max = 200): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", ".next", "data", "dist", "build"]);
  const walk = (d: string) => {
    if (out.length >= max) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (exts.some((e) => name.endsWith(e))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function quote(p: string) {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function detectChecks(dir: string): { name: string; command: string }[] {
  const checks: { name: string; command: string }[] = [];

  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const pj = JSON.parse(readFileSync(pkg, "utf8"));
      if (pj?.scripts?.test) checks.push({ name: "npm test", command: "npm test --silent" });
    } catch {
      /* ignore */
    }
  }

  const py = walkFiles(dir, [".py"]).map((p) => relative(dir, p));
  if (py.length) checks.push({ name: `python 语法 (${py.length} 文件)`, command: `python3 -m py_compile ${py.map(quote).join(" ")}` });

  const shFiles = walkFiles(dir, [".sh", ".bash"]).map((p) => relative(dir, p));
  if (shFiles.length) checks.push({ name: `shell 语法 (${shFiles.length} 文件)`, command: `bash -n ${shFiles.map(quote).join(" ")}` });

  const js = walkFiles(dir, [".mjs", ".cjs"]).map((p) => relative(dir, p));
  if (js.length) checks.push({ name: `node 语法 (${js.length} 文件)`, command: `node --check ${js.map(quote).join(" ")}` });

  const html = walkFiles(dir, [".html"]).map((p) => relative(dir, p));
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

function runChecks(dir: string, checks: { name: string; command: string }[]): CheckResult[] {
  const results: CheckResult[] = [];
  for (const c of checks) {
    const t0 = Date.now();
    try {
      const out = execFileSync("bash", ["-lc", c.command], {
        cwd: dir,
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
      });
      results.push({ name: c.name, command: c.command, ok: true, exitCode: 0, output: String(out).slice(-4000), ms: Date.now() - t0 });
    } catch (e: any) {
      const output = [e?.stdout, e?.stderr].filter(Boolean).map(String).join("\n").slice(-4000) || String(e?.message || e);
      results.push({ name: c.name, command: c.command, ok: false, exitCode: Number(e?.status ?? 1), output, ms: Date.now() - t0 });
    }
  }
  return results;
}

const BANNED_CMD = /(rm\s+-rf\s+\/|sudo\b|mkfs|dd\s+if=|curl[^|]*\|\s*(sh|bash)|wget[^|]*\|\s*(sh|bash))/i;

function verify(task: Task, merge: MergeResult[]): Verification {
  const intDir = join(ROOT, task.id, "integration");
  const auto = detectChecks(intDir);
  const contractCmds = (Array.isArray(task.boss.contract?.verify) ? task.boss.contract.verify : [])
    .filter((c: any) => typeof c === "string" && c.trim() && !BANNED_CMD.test(c))
    .map((c: string) => ({ name: `契约验收: ${c.slice(0, 70)}`, command: c }));
  const checks = [...auto, ...contractCmds];
  const results = runChecks(intDir, checks);
  let diffStat = "";
  try {
    diffStat = sh("git", ["-C", intDir, "diff", "--stat", "HEAD~0"], intDir);
  } catch {
    diffStat = "";
  }
  // 合并后相对 base 的真实差异
  try {
    diffStat = sh("git", [...GIT, "-C", intDir, "diff", "--stat", "main"], intDir);
  } catch {
    /* ignore */
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

async function plan(task: Task): Promise<void> {
  task.state = "planning";
  task.boss.state = "planning";
  putTask(task);

  const orchDir = join(ROOT, task.id, "orchestrator");
  mkdirSync(orchDir, { recursive: true });

  const session = await makeBossSession(orchDir);
  try {
    const prompt = [
      BOSS_PLAN_SYSTEM,
      BOSS_PLAN_TASK(task.goal, task.agents.length, CODENAMES.slice(0, task.agents.length)),
    ].join("\n\n");

    let acc = "";
    session.subscribe((ev: any) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        acc += ev.assistantMessageEvent.delta;
        task.boss.text = acc;
        emit({ type: "boss", taskId: task.id, boss: task.boss });
      }
    });
    await session.prompt(prompt);
    const text = acc || session.getLastAssistantText?.() || "";
    task.boss.plan = text;
    task.boss.usage = collectPiusage(session);

    let { contract, tasks } = parsePlan(text, task.goal, task.agents.length);

    // 模型有时会输出工具调用而不是 JSON：纠正一次
    if (!contract) {
      await session.prompt(
        "你上一条输出不是要求的 JSON。你没有工具，不能执行命令或读取文件。请直接输出约定的 JSON 对象，不要输出任何其它内容。",
      );
      const retry = (session.getLastAssistantText?.() || "").trim();
      if (retry) {
        task.boss.plan = `${text}\n\n--- retry ---\n\n${retry}`;
        const retried = parsePlan(retry, task.goal, task.agents.length);
        contract = retried.contract;
        tasks = retried.tasks;
      }
    }

    task.boss.contract = contract;
    task.boss.planList = tasks.map((t) => ({ name: t.name, task: t.task }));
    task.agents.forEach((a, i) => {
      const item = tasks[i] || tasks[tasks.length - 1];
      a.name = item?.name || CODENAMES[i % CODENAMES.length];
      a.task = item?.task || task.goal;
      a.scope = item?.scope || [];
      a.acceptance = item?.acceptance || [];
      a.evidence = item?.evidence || [];
      a.dependsOn = item?.dependsOn || [];
    });
    task.boss.state = "done";
  } finally {
    session.dispose();
  }
}

async function runAgent(task: Task, agent: AgentRun, opts?: { reason?: string; detail?: string; baseRef?: string }): Promise<void> {
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

  const env: Record<string, string> = {
    AGENT_ID: agent.id,
    SWARM_SHOT_JS: join(process.cwd(), "tools", "worker-shot.mjs"),
    SWARM_PLAYWRIGHT_CORE: join(process.cwd(), "node_modules", "playwright-core", "index.js"),
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

  const res = await runAgyTask({
    prompt: parts.join("\n\n"),
    cwd: dir,
    agentId: agent.id,
    env,
    timeoutMs: Number(process.env.SWARM_AGENT_TIMEOUT_MS || 600_000),
    onText: (_d, full) => {
      agent.text = full;
      emit({ type: "agent", taskId: task.id, agent });
    },
  });

  agent.usage = res.usage;
  agent.spent = (agent.spent || 0) + (res.usage?.totalTokens || 0);
  agent.endedAt = Date.now();
  agent.state = res.error ? "failed" : "done";
  agent.error = res.error || null;
  agent.changedFiles = changedFiles(dir);
  emit({ type: "agent", taskId: task.id, agent });
}

async function runVerifier(task: Task, verification: Verification): Promise<void> {
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
    onText: (_d, full) => {
      if (task.verifier) task.verifier.text = full;
      emit({ type: "task", task: task });
    },
  });

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
      out.push({ kind: "failed", agent: a, name: a.name, reason: "工人本轮执行失败", detail: a.error || "无错误信息" });
    }
  }
  for (const m of task.merge) {
    if (m.status !== "conflict") continue;
    const agent = task.agents.find((a) => a.branch === m.branch) || null;
    out.push({ kind: "conflict", agent, name: m.name, reason: "合并冲突", detail: m.detail });
  }
  for (const c of task.verification?.checks || []) {
    if (c.ok) continue;
    out.push({ kind: "check", name: c.name, reason: `验收命令失败：${c.command}`, detail: `exit ${c.exitCode}\n${c.output}` });
  }
  return out;
}

function problemsText(ps: Problem[]): string {
  return ps
    .map((p, i) => `${i + 1}. [${p.kind}] ${p.name} — ${p.reason}\n${p.detail.slice(0, 1200)}`)
    .join("\n\n");
}

// 返工只做一件事：把失败证据交回给它真正能改的那一层。
// 工人级问题（自己没跑完 / 分支冲突）→ 让它基于当前 integration 提交重做；
// 只剩验收项失败（多份改动叠加后才暴露）→ 派修复者在合并树上直接修。
async function reworkOnce(task: Task, round: number): Promise<"none" | "progress" | "stalled"> {
  const problems = collectProblems(task);
  if (!problems.length) return "none";

  task.state = "rework";
  putTask(task);

  const agentProblems = problems.filter((p) => p.kind === "failed" || p.kind === "conflict");

  if (agentProblems.length) {
    const baseRef = integrationHead(task);
    const detail = problemsText(agentProblems);
    const seen = new Set<string>();
    for (const p of agentProblems) {
      const agent = p.agent;
      if (!agent || seen.has(agent.id)) continue;
      seen.add(agent.id);
      await runAgent(task, agent, { reason: p.reason, detail, baseRef });
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

    task.state = "merging";
    putTask(task);
    task.merge = mergeAll(task);
    task.state = "verifying";
    putTask(task);
    task.verification = verify(task, task.merge);
    putTask(task);
    return "progress";
  }

  const intDir = join(ROOT, task.id, "integration");
  const detail = problemsText(problems);
  const before = integrationHead(task);
  const entry = {
    round,
    target: "fixer" as const,
    who: `修复者 #${round}`,
    reason: `合并后验收失败 ${problems.length} 项`,
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
    onText: (_d, full) => {
      entry.text = full;
      emit({ type: "task", task });
    },
  });

  trySh("git", ["-C", intDir, "add", "-A", "--", ".", ...JUNK]);
  const c = trySh("git", [...GIT, "-C", intDir, "commit", "-qm", `fixer #${round}: 修复合并后的验收失败`], intDir);
  const after = integrationHead(task);

  entry.text = res.text || entry.text;
  entry.usage = (res.usage || null) as any;
  entry.ok = before !== after || (c.ok && !res.error);
  if (res.error) entry.reason += `（修复者报错：${res.error}）`;
  putTask(task);

  task.verification = verify(task, task.merge);
  putTask(task);
  // 修复者一筹莫展（一个文件都没动）时再开一轮没有意义，把最终判断交给人
  return before !== after ? "progress" : "stalled";
}

async function judge(task: Task, verification: Verification, merge: MergeResult[]): Promise<void> {  const orchDir = join(ROOT, task.id, "orchestrator");
  const session = await makeBossSession(orchDir);
  try {
    const audit = [
      `目标：${task.goal}`,
      `合并结果：\n${merge.map((m) => `- ${m.name}: ${m.status} (${m.branch}) ${m.detail}`).join("\n")}`,
      `合并后 diff stat：\n${verification.diffStat || "(空)"}`,
      `验收命令与结果：\n${
        verification.checks.length
          ? verification.checks
              .map((c) => `- [${c.ok ? "PASS" : "FAIL"}] ${c.name} (exit ${c.exitCode})\n${c.output.slice(-800)}`)
              .join("\n")
          : "(没有可识别的自动验收命令)"
      }`,
      `独立验证者（看到的是合并后的完整代码，自选方式验证，它的证据优先于工人自述）：\n${task.verifier?.text || "(未运行)"}`,
      `工人自述（仅供参考，不可当作证据）：\n${task.agents
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
    await session.prompt(prompt);
    const raw = (acc || session.getLastAssistantText?.() || "").trim();
    const cleaned = raw
      .replace(/<[\s\S]*?>/g, " ")
      .replace(/[｜|]{1,2}\s*DSML\s*[｜|]{1,2}/gi, " ")
      .replace(/[｜|]{2}/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    let modelPass: boolean | null = null;
    let reasons: string[] = [];
    const js = cleaned.indexOf("{");
    const je = cleaned.lastIndexOf("}");
    if (js >= 0 && je > js) {
      try {
        const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
        modelPass = !!j.pass;
        reasons = Array.isArray(j.reasons) ? j.reasons.map(String).slice(0, 3) : [];
      } catch {
        /* 落到关键词 */
      }
    }
    if (modelPass === null) {
      if (/^\s*(PASS|通过)/i.test(cleaned)) modelPass = true;
      else if (/^\s*(FAIL|不通过|未通过)/i.test(cleaned)) modelPass = false;
    }

    // 硬证据优先：自动检查与合并结果决定通过与否，模型只能否决不能被采信为通过
    const pass = hardPass && modelPass !== false;
    if (!reasons.length) {
      reasons = [
        hardPass
          ? `自动检查与合并均通过；包工头${modelPass === false ? "有保留" : "无异议"}。`
          : verification.checks.some((c) => !c.ok)
            ? `自动检查失败：${verification.checks.filter((c) => !c.ok).map((c) => c.name).join("、")}`
            : merge.some((m) => m.status === "conflict")
              ? "存在合并冲突"
              : "工人未全部正常完成",
      ];
    }
    task.verdict = { pass, reasons, raw: (cleaned || raw).slice(0, 2000) };
    task.boss.summaryUsage = collectPiusage(session);
    task.boss.state = "done";
  } catch (e: any) {
    task.verdict = { pass: false, reasons: [`判定失败：${e?.message || e}`], raw: "" };
    task.boss.state = "failed";
  } finally {
    session.dispose();
    emit({ type: "boss", taskId: task.id, boss: task.boss });
  }
}

async function aggregate(task: Task): Promise<void> {
  task.state = "aggregating";
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
      `自动验收：${task.verification?.ok ? "通过" : "未通过"}`,
    ].join("\n");
    const prompt = BOSS_SUMMARY_TASK(`${ctx}\n\n${reports}`);

    let acc = "";
    session.subscribe((ev: any) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        acc += ev.assistantMessageEvent.delta;
      }
    });
    await session.prompt(prompt);
    task.summary = cleanModelText(acc || session.getLastAssistantText?.() || "");
    task.boss.state = "done";
  } catch (e: any) {
    task.summary = `汇总失败：${e?.message || e}`;
    task.boss.state = "failed";
  } finally {
    session.dispose();
    emit({ type: "boss", taskId: task.id, boss: task.boss });
  }
}

async function runTask(task: Task) {
  try {
    ensureBaseRepo(task);
    await plan(task);
    task.state = "running";
    putTask(task);

    // 按 dependsOn 分批推进：无依赖的先跑，依赖满足后再跑下一批
    const doneNames = new Set<string>();
    let remaining = [...task.agents];
    while (remaining.length) {
      let ready = remaining.filter((a) => (a.dependsOn || []).every((d) => doneNames.has(d)));
      if (!ready.length) ready = remaining; // 循环依赖兜底：剩下的全部放行
      await Promise.all(
        ready.map((a) => {
          // 有依赖的工人从依赖方的提交出发，这样它能看到上游已经写下的东西
          const deps = (a.dependsOn || [])
            .map((n) => task.agents.find((x) => x.name === n && x.state === "done" && x.branch))
            .filter(Boolean) as AgentRun[];
          let baseRef: string | undefined;
          if (deps.length) {
            const dep = deps[deps.length - 1];
            commitAgent(dep);
            const r = trySh("git", ["-C", dep.worktree, "rev-parse", "HEAD"]);
            if (r.ok && r.out.trim()) baseRef = r.out.trim();
          }
          return runAgent(task, a, baseRef ? { baseRef } : undefined);
        }),
      );
      for (const a of ready) doneNames.add(a.name);
      recount(task);
      putTask(task);
      remaining = remaining.filter((a) => !ready.includes(a));
    }

    task.state = "merging";
    putTask(task);
    task.merge = mergeAll(task);
    putTask(task);

    task.state = "verifying";
    putTask(task);
    task.verification = verify(task, task.merge);
    putTask(task);

    // 验收失败 → 返工，最多 N 轮；每轮只处理一类问题，改完重新合并/重跑验收
    const maxRounds = Math.max(0, Number(process.env.SWARM_REWORK_ROUNDS ?? 2));
    for (let round = 1; round <= maxRounds; round++) {
      const acted = await reworkOnce(task, round);
      if (acted === "none" || acted === "stalled") break;
      recount(task);
      putTask(task);
    }

    task.state = "verifying";
    putTask(task);
    await runVerifier(task, task.verification);

    await aggregate(task);
    await judge(task, task.verification, task.merge);

    task.state = "done";
  } catch (e: any) {
    task.state = "failed";
    task.error = e?.message || String(e);
    task.boss.state = "failed";
  } finally {
    task.finishedAt = Date.now();
    recount(task);
    putTask(task);
  }
}

function recount(task: Task) {
  const boss = (task.boss.usage?.totalTokens || 0) + (task.boss.summaryUsage?.totalTokens || 0);
  const agents = task.agents.reduce((n, a) => n + (a.spent || a.usage?.totalTokens || 0), 0);
  const verifier = task.verifier?.usage?.totalTokens || 0;
  // 工人返工的开销已经算进 agent.spent，这里只补修复者的
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
  putTask(task);
  void runTask(task);
  return task;
}

export function cleanupTask(id: string) {
  const task = getTask(id);
  if (!task) return false;
  for (const a of task.agents) {
    if (a.worktree && existsSync(a.worktree)) {
      try {
        if (task.baseRepo) sh("git", ["-C", task.baseRepo, "worktree", "remove", "--force", a.worktree]);
        else rmSync(a.worktree, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
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
  const target = (base && actualBranch(base)) || "main";

  const record = (ok: boolean, detail: string, commit?: string) => {
    const r: PromoteResult = { at: Date.now(), target, ok, detail, commit };
    task.promote = r;
    putTask(task);
    return r;
  };

  if (!base) return record(false, "找不到基础仓库");
  if (!task.verification) return record(false, "还没有完成合并与验收");
  if (!force && !task.verdict?.pass) {
    return record(false, `验收未通过，拒绝合入。${task.verdict?.reasons?.[0] || ""}`);
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

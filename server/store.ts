import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, SwarmEvent } from "../lib/types.ts";

interface SwarmStore {
  tasks: Map<string, Task>;
  bus: EventEmitter;
  recordEnabled: boolean;
}

// 进程内事件日志：单调 id + 最近 N 条环，供 SSE 断线重连补发。
// seq 以启动时间（毫秒）为起点而不是 0：上一次进程的旧 Last-Event-ID 会明显小于本进程的
// 第一条 id，eventsSince 据此判定为过期并让前端退回全量 snapshot，避免重启后误补发。
interface SwarmEventLog {
  seq: number;
  ring: { id: number; ev: SwarmEvent }[];
}

const g = globalThis as unknown as {
  __swarmStore?: SwarmStore;
  __swarmWrites?: Map<string, ReturnType<typeof setTimeout>>;
  __swarmEventLog?: SwarmEventLog;
};

// 断线重连最多补发 1000 条；超过就退回 snapshot。delta 很小，正常流式一分钟也用不完。
const EVENT_RING_LIMIT = 1000;

function eventLog(): SwarmEventLog {
  if (!g.__swarmEventLog) g.__swarmEventLog = { seq: Date.now(), ring: [] };
  return g.__swarmEventLog;
}

// 与 chats/orchestrator 使用同一个应用根目录；standalone 下 server.js 会 chdir，不能只看 cwd
const APP_ROOT = process.env.SWARM_APP_ROOT || process.cwd();
const TASKS_DIR = process.env.SWARM_TASKS_DIR || join(APP_ROOT, "data", "tasks");

// TASKS_DIR 是运行时目录（standalone 下由 SWARM_TASKS_DIR 指定），
// 标上 turbopackIgnore 阻止构建期把整个仓库当成依赖产物打进 standalone
function taskFile(id: string) {
  return join(/*turbopackIgnore: true*/ TASKS_DIR, `${id}.json`);
}

/* ---------------- 落盘 ---------------- */

// 长任务的 agent 全文会到几十 KB，每次防抖都整份重写会把磁盘写放大；
// 落盘前只保留文本尾部，重启后仍能看到最近的输出。
const TAIL_MARK = "…（已截断，仅保留末尾）";
const TAIL_LIMITS = {
  agentText: 20000,
  summary: 8000,
  verifierText: 12000,
  verdictRaw: 4000,
  reworkText: 8000,
  bossPlan: 20000,
  bossText: 8000,
} as const;

// 保留最后 max 个字符；本来就短于上限的字段原样返回。
// 切点落在代理对中间时往后让一位，避免半个 emoji 变成乱码。
function keepTail(text: string, max: number): string {
  if (typeof text !== "string" || text.length <= max) return text;
  let tail = text.slice(-max);
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return TAIL_MARK + tail;
}

// 生成落盘用的浅拷贝：只克隆会被改写的对象，其余（usage / contract / checks 等）
// 共享引用但只读，不影响内存里的完整对象（SSE 与 UI 仍拿全文）。
export function snapshotForDisk(task: Task): Task {
  const copy: Task = {
    ...task,
    summary: keepTail(task.summary, TAIL_LIMITS.summary),
    boss: task.boss && {
      ...task.boss,
      plan: keepTail(task.boss.plan, TAIL_LIMITS.bossPlan),
      text: keepTail(task.boss.text, TAIL_LIMITS.bossText),
    },
    agents: (task.agents || []).map((a) => ({ ...a, text: keepTail(a.text, TAIL_LIMITS.agentText) })),
    verifier: task.verifier && { ...task.verifier, text: keepTail(task.verifier.text, TAIL_LIMITS.verifierText) },
    verdict: task.verdict && { ...task.verdict, raw: keepTail(task.verdict.raw, TAIL_LIMITS.verdictRaw) },
    rework: (task.rework || []).map((r) => ({ ...r, text: keepTail(r.text, TAIL_LIMITS.reworkText) })),
  };
  return copy;
}

// 落盘用的序列化：先压缩文本再 stringify，供写盘和体积核对共用
export function serializeForDisk(task: Task): string {
  return JSON.stringify(snapshotForDisk(task));
}

// 唯一的写盘入口：tmp + rename 原子替换。失败只告警，不打断编排。
export function writeTaskAtomic(id: string, task: Task) {
  try {
    mkdirSync(TASKS_DIR, { recursive: true });
    const file = taskFile(id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, serializeForDisk(task));
    renameSync(tmp, file);
  } catch (err) {
    console.warn(`[store] 任务 ${id} 落盘失败，已跳过：`, err);
  }
}

function persistNow(id: string) {
  const task = store().tasks.get(id);
  if (!task) return;
  writeTaskAtomic(id, task);
}

// 文本流会高频触发事件，按任务做尾随防抖，避免每个 delta 都写盘
function schedulePersist(id: string) {
  if (!g.__swarmWrites) g.__swarmWrites = new Map();
  const writes = g.__swarmWrites;
  if (writes.has(id)) return;
  writes.set(
    id,
    setTimeout(() => {
      writes.delete(id);
      persistNow(id);
    }, 400),
  );
}

function flushAll() {
  const writes = g.__swarmWrites;
  if (writes) {
    for (const [id, t] of writes) {
      clearTimeout(t);
      persistNow(id);
    }
    writes.clear();
  }
}

/* ---------------- 启动时恢复 ---------------- */

function markInterrupted(t: Task): boolean {
  if (t.state === "done" || t.state === "failed" || t.state === "cancelled") return false;
  t.state = "failed";
  t.error = t.error || "服务重启，任务被中断";
  t.finishedAt = t.finishedAt || Date.now();
  if (t.boss?.state === "planning" || t.boss?.state === "aggregating") t.boss.state = "failed";
  for (const a of t.agents || []) {
    if (a.state === "booting" || a.state === "working" || a.state === "queued") a.state = "failed";
  }
  if (t.verifier && t.verifier.state === "working") t.verifier.state = "failed";
  return true;
}

function loadTasks(): Map<string, Task> {
  const tasks = new Map<string, Task>();
  try {
    if (!existsSync(/*turbopackIgnore: true*/ TASKS_DIR)) return tasks;
    for (const name of readdirSync(/*turbopackIgnore: true*/ TASKS_DIR)) {
      if (!name.endsWith(".json")) continue;
      try {
        const t = JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ TASKS_DIR, name), "utf8")) as Task;
        if (!t?.id || !Array.isArray(t.agents)) continue;
        // 会话模型收敛后任务不再自带消息；旧快照里的字段直接丢弃，避免再写回磁盘
        delete (t as any).messages;
        t.rework = Array.isArray(t.rework) ? t.rework : [];
        t.promote = t.promote || null;
        if (markInterrupted(t)) writeTaskAtomic(t.id, t);
        tasks.set(t.id, t);
      } catch {
        /* 跳过损坏的文件 */
      }
    }
  } catch {
    /* 目录不可读就当空库 */
  }
  return tasks;
}

/* ---------------- store ---------------- */

export function store(): SwarmStore {
  if (!g.__swarmStore) {
    const bus = new EventEmitter();
    bus.setMaxListeners(200);
    g.__swarmStore = { tasks: loadTasks(), bus, recordEnabled: true };
  }
  return g.__swarmStore;
}

export function emit(ev: SwarmEvent) {
  const log = eventLog();
  const id = ++log.seq;
  log.ring.push({ id, ev });
  if (log.ring.length > EVENT_RING_LIMIT) log.ring.splice(0, log.ring.length - EVENT_RING_LIMIT);
  store().bus.emit("event", id, ev);
  // 落盘仍然按任务做尾随防抖：delta 也刷新防抖，任务运行中也能落一份进度；
  // 会话（session / session-delta）的写盘只在结束时由 chats 自己做，避免每个 delta 写盘。
  if (ev.type === "task") schedulePersist(ev.task.id);
  else if (ev.type === "agent" || ev.type === "boss" || ev.type === "agent-delta" || ev.type === "boss-delta") {
    schedulePersist(ev.taskId);
  }
}

// 兼容旧调用：只关心事件本身
export function onEvent(fn: (ev: SwarmEvent) => void): () => void {
  const handler = (_id: number, ev: SwarmEvent) => fn(ev);
  store().bus.on("event", handler);
  return () => store().bus.off("event", handler);
}

// SSE 用：同时拿到单调 id，便于写 EventSource 的 id 字段
export function subscribeWithIds(fn: (id: number, ev: SwarmEvent) => void): () => void {
  store().bus.on("event", fn);
  return () => store().bus.off("event", fn);
}

// 返回 id 之后（不含）的所有事件；id 已经滚出环、来自旧进程或非法时返回 null，
// 调用方据此退回全量 snapshot。id 正好等于当前 seq 表示没有遗漏，返回空数组。
export function eventsSince(id: number): { id: number; ev: SwarmEvent }[] | null {
  if (!Number.isInteger(id) || id < 0) return null;
  const log = eventLog();
  if (id > log.seq) return null;
  if (id === log.seq) return [];
  const ring = log.ring;
  // 环空但还有更新的事件 → 中间全部滚出
  if (!ring.length) return null;
  // 需要的下一条是 id+1；环里最旧的都更靠后，说明中间有缺
  if (ring[0].id > id + 1) return null;
  return ring.filter((e) => e.id > id);
}

/* ---------------- 文本合帧 ---------------- */

export interface DeltaBatcher {
  push(delta: string): void;
  // 立即发出剩余增量并清掉定时器；流结束、取消、异常都必须调用
  flush(): void;
}

// 高频文本 delta 的 60ms 合帧器：一帧内的增量合并成一条事件，降低 SSE 条数与前端 setState 次数。
// 首次 push 才启动定时器；flush 之后可再次 push（例如同一会话的下一段流）。
export function createDeltaBatcher(send: (delta: string) => void, frameMs = 60): DeltaBatcher {
  let buf = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buf) return;
    const out = buf;
    buf = "";
    try {
      send(out);
    } catch {
      /* 发送失败不阻断编排 */
    }
  };

  return {
    push(delta: string) {
      if (!delta) return;
      buf += delta;
      if (timer) return;
      timer = setTimeout(flush, frameMs);
    },
    flush,
  };
}

export function listTasks(): Task[] {
  return [...store().tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getTask(id: string): Task | undefined {
  return store().tasks.get(id);
}

export function putTask(task: Task) {
  store().tasks.set(task.id, task);
  emit({ type: "task", task });
}

// 删除任务快照：清掉待写盘的防抖定时器，避免删除后又被定时器写回来
export function removeTask(id: string) {
  const writes = g.__swarmWrites;
  const timer = writes?.get(id);
  if (timer) {
    clearTimeout(timer);
    writes?.delete(id);
  }
  store().tasks.delete(id);
  try {
    rmSync(/*turbopackIgnore: true*/ taskFile(id), { force: true });
  } catch {
    /* 文件不存在或不可删，Map 已移除即可 */
  }
}

export function tasksDir() {
  return TASKS_DIR;
}

// Next 热更新会重新加载模块，退出前把没写完的任务刷一遍盘
const gsig = globalThis as unknown as { __swarmSigHook?: boolean };
if (!gsig.__swarmSigHook) {
  gsig.__swarmSigHook = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      flushAll();
      process.exit(0);
    });
  }
}

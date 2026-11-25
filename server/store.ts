import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, SwarmEvent } from "../lib/types.ts";

interface SwarmStore {
  tasks: Map<string, Task>;
  bus: EventEmitter;
  recordEnabled: boolean;
}

const g = globalThis as unknown as {
  __swarmStore?: SwarmStore;
  __swarmWrites?: Map<string, ReturnType<typeof setTimeout>>;
};

const TASKS_DIR = process.env.SWARM_TASKS_DIR || join(process.cwd(), "data", "tasks");

// TASKS_DIR 是运行时目录（standalone 下由 SWARM_TASKS_DIR 指定），
// 标上 turbopackIgnore 阻止构建期把整个仓库当成依赖产物打进 standalone
function taskFile(id: string) {
  return join(/*turbopackIgnore: true*/ TASKS_DIR, `${id}.json`);
}

/* ---------------- 落盘 ---------------- */

function persistNow(id: string) {
  const task = store().tasks.get(id);
  if (!task) return;
  try {
    mkdirSync(TASKS_DIR, { recursive: true });
    const file = taskFile(id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(task));
    renameSync(tmp, file);
  } catch {
    /* 落盘失败不影响编排 */
  }
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
  if (t.state === "done" || t.state === "failed") return false;
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
        t.rework = Array.isArray(t.rework) ? t.rework : [];
        t.promote = t.promote || null;
        if (markInterrupted(t)) persistTask(t);
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

function persistTask(t: Task) {
  try {
    mkdirSync(TASKS_DIR, { recursive: true });
    writeFileSync(taskFile(t.id), JSON.stringify(t));
  } catch {
    /* ignore */
  }
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
  store().bus.emit("event", ev);
  if (ev.type === "task") schedulePersist(ev.task.id);
  else if (ev.type === "agent" || ev.type === "boss") schedulePersist(ev.taskId);
}

export function onEvent(fn: (ev: SwarmEvent) => void): () => void {
  store().bus.on("event", fn);
  return () => store().bus.off("event", fn);
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

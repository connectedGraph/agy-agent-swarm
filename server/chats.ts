import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Chat, ChatMessage, Task } from "../lib/types.ts";
import { BOSS_SESSION_SYSTEM } from "./prompts.ts";
import { createTask, isTaskLive, makeBossSession, setSystemMessageSink } from "./orchestrator.ts";
import { createDeltaBatcher, emit, getTask, listTasks } from "./store.ts";

// standalone 下 server.js 会 chdir，路径一律基于显式根目录
const APP_ROOT = process.env.SWARM_APP_ROOT || process.cwd();
const CHATS_DIR = process.env.SWARM_CHATS_DIR || join(APP_ROOT, "data", "chats");
const RUNS_ROOT = process.env.SWARM_ROOT || join(APP_ROOT, "data", "runs");

const g = globalThis as unknown as { __swarmChats?: Map<string, Chat> };

function chatFile(id: string) {
  return join(/*turbopackIgnore: true*/ CHATS_DIR, `${id}.json`);
}

// 旧数据只有 taskId：加载时迁成 taskIds，并把 taskId 固定为「最近一次」
function normalizeChat(c: Chat): Chat {
  const ids = Array.isArray(c.taskIds) ? c.taskIds.filter((x) => typeof x === "string" && x) : [];
  if (c.taskId && !ids.includes(c.taskId)) ids.push(c.taskId);
  c.taskIds = ids;
  c.taskId = ids.length ? ids[ids.length - 1] : null;
  return c;
}

function loadChats(): Map<string, Chat> {
  const map = new Map<string, Chat>();
  try {
    if (!existsSync(/*turbopackIgnore: true*/ CHATS_DIR)) return map;
    for (const name of readdirSync(/*turbopackIgnore: true*/ CHATS_DIR)) {
      if (!name.endsWith(".json")) continue;
      try {
        const c = JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ CHATS_DIR, name), "utf8")) as Chat;
        if (!c?.id || !Array.isArray(c.messages)) continue;
        map.set(c.id, normalizeChat(c));
      } catch {
        /* 跳过损坏文件 */
      }
    }
  } catch {
    /* 目录不可读就当空库 */
  }
  return map;
}

function all(): Map<string, Chat> {
  if (!g.__swarmChats) {
    g.__swarmChats = loadChats();
    migrateTasks(g.__swarmChats);
  }
  return g.__swarmChats;
}

// 旧版本只有任务没有会话：首次启动补一条会话，历史任务仍能在会话列表里打开。
// 这是一次性迁移：写完标记后不再执行，否则用户删掉会话后会因为任务还在而被重新补回来。
const MIGRATED_MARKER = join(/*turbopackIgnore: true*/ CHATS_DIR, ".tasks-migrated");

function migrateTasks(map: Map<string, Chat>) {
  if (existsSync(/*turbopackIgnore: true*/ MIGRATED_MARKER)) return;
  const linked = new Set([...map.values()].flatMap((c) => c.taskIds || []).filter(Boolean));
  for (const t of listTasks()) {
    if (linked.has(t.id)) continue;
    const chat: Chat = {
      id: t.id,
      title: t.goal.replace(/\s+/g, " ").slice(0, 40),
      repoPath: t.repoPath,
      createdAt: t.createdAt,
      updatedAt: t.finishedAt || t.createdAt,
      messages: [{ id: `goal-${t.id}`, role: "user", text: t.goal, at: t.createdAt, kind: "goal" }],
      taskIds: [t.id],
      taskId: t.id,
    };
    map.set(chat.id, chat);
    persist(chat);
  }
  // 迁移只做一次；标记写在会话目录里，和会话文件一起被忽略
  try {
    mkdirSync(/*turbopackIgnore: true*/ CHATS_DIR, { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ MIGRATED_MARKER, new Date().toISOString());
  } catch {
    /* 标记写不了就下次再试 */
  }
}

function persist(chat: Chat) {
  try {
    mkdirSync(/*turbopackIgnore: true*/ CHATS_DIR, { recursive: true });
    const file = chatFile(chat.id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(chat));
    renameSync(tmp, file);
  } catch {
    /* 落盘失败不影响对话 */
  }
}

function broadcast(chat: Chat) {
  chat.updatedAt = Date.now();
  emit({ type: "session", chat });
}

export function listChats(): Chat[] {
  return [...all().values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getChat(id: string): Chat | undefined {
  return all().get(id);
}

export function createChat(input: { repoPath?: string } = {}): Chat {
  const chat: Chat = {
    id: randomUUID(),
    title: "新会话",
    repoPath: input.repoPath?.trim() || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    taskIds: [],
    taskId: null,
  };
  all().set(chat.id, chat);
  persist(chat);
  emit({ type: "session", chat });
  return chat;
}

// 只改会话标题与目标仓库；标题限 60 字，repoPath 传空串表示清空为 null
export function updateChat(
  id: string,
  patch: { title?: string; repoPath?: string | null },
): Chat | undefined {
  const chat = all().get(id);
  if (!chat) return undefined;
  if (typeof patch.title === "string") {
    const title = patch.title.trim().slice(0, 60);
    if (title) chat.title = title;
  }
  if (patch.repoPath !== undefined) {
    const repo = String(patch.repoPath ?? "").trim();
    chat.repoPath = repo || null;
  }
  // 先广播（会刷新 updatedAt），再落盘，保证磁盘上的时间与推送一致
  broadcast(chat);
  persist(chat);
  return chat;
}

function push(chat: Chat, msg: ChatMessage) {
  chat.messages.push(msg);
  broadcast(chat);
}

/* ---------------- 编排器对话 ---------------- */

// 每个会话一个 pi 编排器会话；按最近使用淘汰，避免长期运行无限占内存
// 同样挂到 globalThis，避免不同路由 bundle 各持一份 Map
const gsessions = globalThis as unknown as { __swarmBossSessions?: Map<string, any> };
const sessions = (gsessions.__swarmBossSessions ||= new Map<string, any>());
const MAX_SESSIONS = 50;

function getSession(id: string): any {
  const s = sessions.get(id);
  if (!s) return undefined;
  // 重新插入到末尾，Map 的迭代顺序就是 LRU 顺序
  sessions.delete(id);
  sessions.set(id, s);
  return s;
}

function putSession(id: string, session: any) {
  sessions.set(id, session);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const old = sessions.get(oldest);
    sessions.delete(oldest);
    try {
      old?.dispose?.();
    } catch {
      /* dispose 失败不影响新会话 */
    }
  }
}

function dropSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    s?.dispose?.();
  } catch {
    /* ignore */
  }
}

function chatContext(chat: Chat): string {
  const taskIds = chat.taskIds || [];
  const lines = [
    chat.repoPath ? `仓库：${chat.repoPath}` : "仓库：未指定（执行时会新建临时仓库）",
    taskIds.length ? `已执行 ${taskIds.length} 次，最近一次：${taskIds[taskIds.length - 1].slice(0, 8)}` : "还没有派发执行任务",
  ];
  const task = chat.taskId ? getTask(chat.taskId) : undefined;
  if (task) {
    lines.push(`任务状态：${task.state}`);
    if (task.summary) lines.push(`任务汇总：${task.summary}`);
  }
  return lines.join("\n");
}

export async function sendChatMessage(chat: Chat, text: string): Promise<ChatMessage> {
  const clean = String(text || "").trim().slice(0, 4000);
  if (!clean) throw new Error("消息为空");

  const userMsg: ChatMessage = { id: randomUUID(), role: "user", text: clean, at: Date.now() };
  if (chat.title === "新会话") chat.title = clean.replace(/\s+/g, " ").slice(0, 40);
  push(chat, userMsg);

  const reply: ChatMessage = { id: randomUUID(), role: "boss", text: "", at: Date.now(), kind: "reply" };
  chat.messages.push(reply);
  broadcast(chat);

  try {
    const dir = join(RUNS_ROOT, chat.id, "orchestrator");
    mkdirSync(dir, { recursive: true });
    let session = getSession(chat.id);
    if (!session) {
      session = await makeBossSession(dir);
      putSession(chat.id, session);
    }

    // 流式回复只发增量，不再每个 delta 广播整个 chat；完整 session 在开始与结束时各发一次
    const batcher = createDeltaBatcher((delta) =>
      emit({ type: "session-delta", chatId: chat.id, messageId: reply.id, delta }),
    );
    let acc = "";
    const unsub = session.subscribe((ev: any) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        const delta = ev.assistantMessageEvent.delta as string;
        acc += delta;
        reply.text = acc;
        batcher.push(delta);
      }
    });
    try {
      await session.prompt(`${BOSS_SESSION_SYSTEM}\n\n当前会话：\n${chatContext(chat)}\n\n用户：${clean}`);
    } finally {
      if (typeof unsub === "function") unsub();
      // 先 flush 剩余增量，下面的完整 session 事件是最终真相；异常时同样清理定时器
      batcher.flush();
    }
    reply.text = (acc || session.getLastAssistantText?.() || "").trim() || "（编排器没有返回内容）";
  } catch (e: any) {
    reply.text = `编排器会话失败：${e?.message || e}`;
    reply.error = true;
  }
  persist(chat);
  broadcast(chat);
  return reply;
}

/* ---------------- 从会话开始执行 ---------------- */

// 会话里已有 live 任务时不能再开一轮，接口层据此返回 409
export class ChatBusyError extends Error {
  code = "BUSY";
  constructor(message: string) {
    super(message);
    this.name = "ChatBusyError";
  }
}

export function startChatTask(chat: Chat, opts: { agents?: number; goal?: string } = {}): Task {
  for (const id of chat.taskIds || []) {
    const t = getTask(id);
    if (t && isTaskLive(t)) throw new ChatBusyError("这个会话已经有一个任务在执行");
  }

  // 显式 goal 优先；为空时回退到最后一条用户消息（兼容旧前端）
  const explicit = String(opts.goal || "").trim().slice(0, 4000);
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user" && m.text.trim());
  const goal = explicit || lastUser?.text.trim() || "";
  if (!goal) throw new Error("还没有可执行的目标");

  // 显式 goal 与最后一条用户消息不同（比如确认后的摘要）时，记进会话保证记录完整
  if (explicit && explicit !== lastUser?.text.trim()) {
    push(chat, { id: randomUUID(), role: "user", text: explicit, at: Date.now(), kind: "goal" });
  }
  if (chat.title === "新会话") chat.title = goal.replace(/\s+/g, " ").slice(0, 40);

  const agents = Math.max(1, Math.min(8, Number(opts.agents) || 3));
  const task = createTask({ goal, agents, repoPath: chat.repoPath || undefined });

  // 追加而不是覆盖：历史任务仍可从 taskIds 打开
  chat.taskIds = [...(chat.taskIds || []), task.id];
  chat.taskId = task.id;
  push(chat, {
    id: randomUUID(),
    role: "system",
    text: `已开始执行 ${task.id.slice(0, 8)}（${task.agents.length} 个执行代理）`,
    at: Date.now(),
    kind: "event",
  });
  persist(chat);
  broadcast(chat);
  return task;
}

/* ---------------- 任务与会话的绑定维护 ---------------- */

// 编排器把「开始/取消/失败」交给这里落成会话消息；找不到归属会话就跳过
export function pushSystemMessageForTask(taskId: string, text: string, kind: "event" | "error" = "event") {
  const chat = [...all().values()].find((c) => (c.taskIds || []).includes(taskId));
  if (!chat) return;
  push(chat, {
    id: randomUUID(),
    role: "system",
    text,
    at: Date.now(),
    kind,
    error: kind === "error" ? true : undefined,
  });
  persist(chat);
}

// 删除任务后摘掉会话里的引用，taskId 回退到仍在的最后一个历史任务
export function detachTaskFromChats(taskId: string) {
  for (const chat of all().values()) {
    if (!(chat.taskIds || []).includes(taskId)) continue;
    chat.taskIds = (chat.taskIds || []).filter((x) => x !== taskId);
    chat.taskId = chat.taskIds.length ? chat.taskIds[chat.taskIds.length - 1] : null;
    persist(chat);
    broadcast(chat);
  }
}

export function deleteChat(id: string): boolean {
  if (!all().has(id)) return false;
  dropSession(id);
  all().delete(id);
  try {
    const file = chatFile(id);
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* 文件已不在 */
  }
  // 只删会话自己的编排器目录；chat id 与旧任务 id 相同时，runs/<id> 里还有任务 worktree，不能整目录删
  try {
    rmSync(join(/*turbopackIgnore: true*/ RUNS_ROOT, id, "orchestrator"), { recursive: true, force: true });
  } catch {
    /* 目录已不在 */
  }
  emit({ type: "session-deleted", chatId: id });
  return true;
}

setSystemMessageSink((taskId, text, kind) => pushSystemMessageForTask(taskId, text, kind));

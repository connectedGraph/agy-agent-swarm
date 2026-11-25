import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Chat, ChatMessage, Task } from "../lib/types.ts";
import { BOSS_SESSION_SYSTEM } from "./prompts.ts";
import { createTask, makeBossSession } from "./orchestrator.ts";
import { emit, getTask, listTasks } from "./store.ts";

// standalone 下 server.js 会 chdir，路径一律基于显式根目录
const APP_ROOT = process.env.SWARM_APP_ROOT || process.cwd();
const CHATS_DIR = process.env.SWARM_CHATS_DIR || join(APP_ROOT, "data", "chats");
const RUNS_ROOT = process.env.SWARM_ROOT || join(APP_ROOT, "data", "runs");

const g = globalThis as unknown as { __swarmChats?: Map<string, Chat> };

function chatFile(id: string) {
  return join(/*turbopackIgnore: true*/ CHATS_DIR, `${id}.json`);
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
        map.set(c.id, c);
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

// 旧版本只有任务没有会话：启动时补一条会话，历史任务仍能在会话列表里打开
function migrateTasks(map: Map<string, Chat>) {
  const linked = new Set([...map.values()].map((c) => c.taskId).filter(Boolean));
  for (const t of listTasks()) {
    if (linked.has(t.id)) continue;
    const chat: Chat = {
      id: t.id,
      title: t.goal.replace(/\s+/g, " ").slice(0, 40),
      repoPath: t.repoPath,
      createdAt: t.createdAt,
      updatedAt: t.finishedAt || t.createdAt,
      messages: [{ id: `goal-${t.id}`, role: "user", text: t.goal, at: t.createdAt, kind: "goal" }],
      taskId: t.id,
    };
    map.set(chat.id, chat);
    persist(chat);
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
    taskId: null,
  };
  all().set(chat.id, chat);
  persist(chat);
  emit({ type: "session", chat });
  return chat;
}

function push(chat: Chat, msg: ChatMessage) {
  chat.messages.push(msg);
  broadcast(chat);
}

/* ---------------- 编排器对话 ---------------- */

const sessions = new Map<string, any>();

function chatContext(chat: Chat): string {
  const lines = [
    chat.repoPath ? `仓库：${chat.repoPath}` : "仓库：未指定（执行时会新建临时仓库）",
    chat.taskId ? `已有一个执行任务：${chat.taskId.slice(0, 8)}` : "还没有派发执行任务",
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
    let session = sessions.get(chat.id);
    if (!session) {
      session = await makeBossSession(dir);
      sessions.set(chat.id, session);
    }

    let acc = "";
    const unsub = session.subscribe((ev: any) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        acc += ev.assistantMessageEvent.delta;
        reply.text = acc;
        broadcast(chat);
      }
    });
    try {
      await session.prompt(`${BOSS_SESSION_SYSTEM}\n\n当前会话：\n${chatContext(chat)}\n\n用户：${clean}`);
    } finally {
      if (typeof unsub === "function") unsub();
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

export function startChatTask(chat: Chat, agents = 3): Task {
  if (chat.taskId && getTask(chat.taskId)) {
    const t = getTask(chat.taskId);
    if (t && (t.state === "planning" || t.state === "running" || t.state === "merging" || t.state === "verifying" || t.state === "rework" || t.state === "aggregating")) {
      throw new Error("这个会话已经有一个任务在执行");
    }
  }
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user" && m.text.trim());
  if (!lastUser) throw new Error("还没有可执行的目标");

  const task = createTask({
    goal: lastUser.text,
    agents,
    repoPath: chat.repoPath || undefined,
  });
  chat.taskId = task.id;
  persist(chat);
  broadcast(chat);
  return task;
}

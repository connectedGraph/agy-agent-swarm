"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Task } from "@/lib/types";
import { BrandMark } from "@/components/console/Header";
import { Dot, Icon, IconBtn, Spinner, Tag } from "@/components/ui/kit";
import { displayState, fmt, isLive } from "@/components/console/shared";
import { Sidebar } from "./Sidebar";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { AgentRail } from "./AgentRail";
import { Confirm } from "./Confirm";
import { RunDialog } from "./RunDialog";

const EXAMPLES = [
  "新增 README：说明仓库用途与文件结构，并附上实际运行过的检查命令",
  "修掉 python 语法错误，先用 py_compile 复现再改，把输出写进 evidence/",
  "补一个 CLI 参数解析，用 node --check 和真实执行做验收",
];

const LAST_CHAT_KEY = "swarm-last-chat";

/* ---------------- SSE 更新的对象复用 ----------------
   服务端每次广播都重新 JSON 序列化整个 chat/task，客户端拿到的是全新对象。
   这里把内容未变的消息/会话复用上一份引用，配合子组件的 memo，
   让每个 delta 只重渲染真正变化的那一条消息。 */

function sameMessage(a: Chat["messages"][number], b: Chat["messages"][number]) {
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.at === b.at &&
    a.role === b.role &&
    a.kind === b.kind &&
    a.error === b.error
  );
}

function sameIds(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function reconcileChat(prev: Chat | undefined, incoming: Chat): Chat {
  if (!prev || prev.id !== incoming.id) return incoming;

  const prevMsgs = prev.messages;
  const nextMsgs = incoming.messages;
  let messages = nextMsgs;
  if (prevMsgs.length <= nextMsgs.length) {
    let reused = 0;
    const merged = nextMsgs.map((m, i) => {
      const old = prevMsgs[i];
      if (old && sameMessage(old, m)) {
        reused++;
        return old;
      }
      return m;
    });
    // 长度与内容都没变时整段复用，连数组引用也不换
    messages = reused === nextMsgs.length && nextMsgs.length === prevMsgs.length ? prevMsgs : merged;
  }

  const idsEqual = sameIds(prev.taskIds || [], incoming.taskIds || []);
  const taskIds = idsEqual ? prev.taskIds : incoming.taskIds;
  if (
    messages === prevMsgs &&
    idsEqual &&
    prev.title === incoming.title &&
    prev.repoPath === incoming.repoPath &&
    prev.taskId === incoming.taskId &&
    prev.updatedAt === incoming.updatedAt
  ) {
    return prev;
  }
  return { ...incoming, messages, taskIds };
}

function upsertChat(list: Chat[], chat: Chat) {
  const i = list.findIndex((c) => c.id === chat.id);
  if (i < 0) return [chat, ...list];
  const merged = reconcileChat(list[i], chat);
  if (merged === list[i]) return list;
  const next = list.slice();
  next[i] = merged;
  return next;
}

function upsertTask(list: Task[], task: Task) {
  const i = list.findIndex((t) => t.id === task.id);
  if (i < 0) return [task, ...list];
  if (list[i] === task) return list;
  const next = list.slice();
  next[i] = task;
  return next;
}

/* ---------------- 流式增量 ----------------
   服务端把高频文本合帧成 delta 事件，只带新增的一段。
   这里只替换命中的 task/agent 或 chat/message，不新建对象；
   完整对象事件（agent/session/boss）随后到达时以服务端为准整体覆盖。 */

function applyAgentDelta(list: Task[], ev: { taskId: string; agentId: string; delta: string }) {
  const ti = list.findIndex((t) => t.id === ev.taskId);
  if (ti < 0) return list;
  const t = list[ti];
  const ai = t.agents.findIndex((a) => a.id === ev.agentId);
  if (ai < 0) return list;
  const agents = t.agents.slice();
  agents[ai] = { ...t.agents[ai], text: `${t.agents[ai].text || ""}${ev.delta}` };
  const next = list.slice();
  next[ti] = { ...t, agents };
  return next;
}

function applyBossDelta(list: Task[], ev: { taskId: string; delta: string }) {
  const ti = list.findIndex((t) => t.id === ev.taskId);
  if (ti < 0) return list;
  const t = list[ti];
  const next = list.slice();
  next[ti] = { ...t, boss: { ...t.boss, text: `${t.boss.text || ""}${ev.delta}` } };
  return next;
}

function applySessionDelta(list: Chat[], ev: { chatId: string; messageId: string; delta: string }) {
  const ci = list.findIndex((c) => c.id === ev.chatId);
  if (ci < 0) return list;
  const chat = list[ci];
  const mi = chat.messages.findIndex((m) => m.id === ev.messageId);
  // 消息还不存在（首帧丢失等）就忽略，等最终 session 事件纠正
  if (mi < 0) return list;
  const messages = chat.messages.slice();
  messages[mi] = { ...messages[mi], text: `${messages[mi].text || ""}${ev.delta}` };
  const next = list.slice();
  next[ci] = { ...chat, messages };
  return next;
}

function sameAgent(a: Task["agents"][number], b: Task["agents"][number]) {
  return (
    a.state === b.state &&
    a.text === b.text &&
    a.branch === b.branch &&
    a.worktree === b.worktree &&
    a.endedAt === b.endedAt &&
    a.spent === b.spent &&
    (a.usage?.totalTokens || 0) === (b.usage?.totalTokens || 0) &&
    sameIds(a.changedFiles || [], b.changedFiles || []) &&
    a.error === b.error
  );
}

// 窄屏断点：用 matchMedia 驱动抽屉的 aria/inert，CSS 负责实际布局
function useMediaQuery(query: string) {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return match;
}

export default function ChatApp() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [gw, setGw] = useState<any>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [count, setCount] = useState(3);
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopErr, setStopErr] = useState("");
  const [error, setError] = useState("");
  const [repoEdit, setRepoEdit] = useState(false);
  const [repoDraft, setRepoDraft] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoErr, setRepoErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // 窄屏抽屉：侧栏（<=820）与执行代理栏（<=1180）
  const [sideOpen, setSideOpen] = useState(false);
  const [railDrawer, setRailDrawer] = useState(false);
  // 桌面纯对话阶段：右栏默认收成窄条，点开才占 328px
  const [railWide, setRailWide] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const narrowSide = useMediaQuery("(max-width: 820px)");
  const narrowRail = useMediaQuery("(max-width: 1180px)");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const rafRef = useRef(0);
  const restoreSide = useRef(false);
  const restoreRail = useRef(false);
  const focusMainPending = useRef(false);
  const restored = useRef(false);

  const mergeChat = useCallback((chat: Chat) => {
    setChats((prev) => upsertChat(prev, chat));
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let ev: any;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.type === "snapshot") {
        const nextChats: Chat[] = ev.chats || [];
        setTasks(ev.tasks || []);
        setChats(nextChats);
        // 断线期间会话可能已被删掉，重连后不要停在不存在的会话上
        setCurrentId((prev) => (prev && !nextChats.some((c) => c.id === prev) ? null : prev));
      } else if (ev.type === "session") {
        setChats((prev) => upsertChat(prev, ev.chat));
      } else if (ev.type === "session-deleted") {
        setChats((prev) => {
          const next = prev.filter((c) => c.id !== ev.chatId);
          return next.length === prev.length ? prev : next;
        });
        setCurrentId((prev) => {
          if (prev !== ev.chatId) return prev;
          try {
            localStorage.removeItem(LAST_CHAT_KEY);
          } catch {
            /* ignore */
          }
          return null;
        });
      } else if (ev.type === "task") {
        setTasks((prev) => upsertTask(prev, ev.task));
      } else if (ev.type === "task-deleted") {
        setTasks((prev) => {
          const next = prev.filter((t) => t.id !== ev.taskId);
          return next.length === prev.length ? prev : next;
        });
        setViewTaskId((prev) => (prev === ev.taskId ? null : prev));
      } else if (ev.type === "agent") {
        // 只改命中的 task 与 agent；内容没变时原样返回，不新建数组
        setTasks((prev) => {
          const ti = prev.findIndex((t) => t.id === ev.taskId);
          if (ti < 0) return prev;
          const t = prev[ti];
          const ai = t.agents.findIndex((a) => a.id === ev.agent.id);
          if (ai < 0) return prev;
          const merged = { ...t.agents[ai], ...ev.agent };
          if (sameAgent(t.agents[ai], merged)) return prev;
          const agents = t.agents.slice();
          agents[ai] = merged;
          const next = prev.slice();
          next[ti] = { ...t, agents };
          return next;
        });
      } else if (ev.type === "boss") {
        setTasks((prev) => {
          const ti = prev.findIndex((t) => t.id === ev.taskId);
          if (ti < 0) return prev;
          if (prev[ti].boss === ev.boss) return prev;
          const next = prev.slice();
          next[ti] = { ...prev[ti], boss: ev.boss };
          return next;
        });
      } else if (ev.type === "agent-delta") {
        setTasks((prev) => applyAgentDelta(prev, ev));
      } else if (ev.type === "boss-delta") {
        setTasks((prev) => applyBossDelta(prev, ev));
      } else if (ev.type === "session-delta") {
        setChats((prev) => applySessionDelta(prev, ev));
      }
    };
    return () => es.close();
  }, []);

  // 网关状态轮询：15 秒一次，页面隐藏时暂停（接口契约不变）
  useEffect(() => {
    let alive = true;
    let busy = false;
    let timer = 0;

    const tick = async () => {
      if (!alive || busy) return;
      if (document.hidden) {
        timer = window.setTimeout(tick, 15_000);
        return;
      }
      busy = true;
      try {
        const r = await fetch("/api/gateway", { cache: "no-store" });
        const j = await r.json();
        if (alive) setGw(j);
      } catch {
        /* ignore */
      } finally {
        busy = false;
        if (alive) timer = window.setTimeout(tick, 15_000);
      }
    };
    const onVisible = () => {
      if (document.hidden) return;
      window.clearTimeout(timer);
      void tick();
    };

    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // 相对时间每分钟刷新一次；页面隐藏时不跑
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 60_000);
    const onVisible = () => {
      if (!document.hidden) setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // 刷新恢复：会话列表到达后，选中上次仍在的那一个；无效就停在空态
  useEffect(() => {
    if (restored.current || !chats.length) return;
    restored.current = true;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_CHAT_KEY);
    } catch {
      /* ignore */
    }
    if (last && chats.some((c) => c.id === last)) {
      setCurrentId(last);
      stick.current = true;
    }
  }, [chats]);

  useEffect(() => {
    if (!currentId) return;
    try {
      localStorage.setItem(LAST_CHAT_KEY, currentId);
    } catch {
      /* ignore */
    }
  }, [currentId]);

  const current = useMemo(() => chats.find((c) => c.id === currentId) || null, [chats, currentId]);

  // 会话的全部执行记录（按时间顺序），以及其中仍在跑的那个
  // 依赖 taskIds 引用而不是整个 current：SSE 只改 updatedAt 时不必重算
  const chatTasks = useMemo(() => {
    if (!current) return [] as Task[];
    const ids = [...(current.taskIds || [])];
    if (current.taskId && !ids.includes(current.taskId)) ids.push(current.taskId);
    return ids.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t);
  }, [current?.taskIds, current?.taskId, tasks]);

  const latestTask = chatTasks.length ? chatTasks[chatTasks.length - 1] : null;
  // 只有确实属于当前会话的历史任务才作为查看目标，避免切换会话后残留
  const activeViewTaskId =
    viewTaskId && chatTasks.some((t) => t.id === viewTaskId) ? viewTaskId : null;
  const viewedTask = activeViewTaskId
    ? chatTasks.find((t) => t.id === activeViewTaskId) || latestTask
    : latestTask;
  const liveTask = useMemo(() => chatTasks.find((t) => isLive(t.state)) || null, [chatTasks]);

  const stateInfo = latestTask ? displayState(latestTask) : null;
  const running = !!liveTask;

  const currentMessages = current?.messages;
  const lastUserText = useMemo(() => {
    if (!currentMessages) return "";
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i];
      if (m.role === "user" && m.text.trim()) return m.text;
    }
    return "";
  }, [currentMessages]);

  // 滚动跟随：用 requestAnimationFrame 合并同一帧内的多次 delta，
  // 且只在用户本来就在底部时滚；读 scrollHeight 只发生在帧回调里
  const scheduleScroll = useCallback(() => {
    if (!stick.current || rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scrollRef.current;
      if (!el || !stick.current) return;
      el.scrollTop = el.scrollHeight;
      setAwayFromBottom(false);
    });
  }, []);

  const jumpToBottom = useCallback(() => {
    stick.current = true;
    setAwayFromBottom(false);
    const el = scrollRef.current;
    if (!el) return;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // 新消息或状态变化时跟到底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stick.current = dist < 120;
      // 与跟随判定同阈值：不再跟随时就给出「回到底部」入口
      setAwayFromBottom(dist > 120);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [currentId]);

  // 切换会话时回到最新位置
  useEffect(() => {
    stick.current = true;
    setAwayFromBottom(false);
    scheduleScroll();
  }, [currentId, scheduleScroll]);

  useEffect(() => {
    scheduleScroll();
  }, [currentMessages, latestTask, viewTaskId, scheduleScroll]);

  // 抽屉焦点：打开时落进抽屉，关闭时按来源回到汉堡/执行代理按钮或会话标题
  useEffect(() => {
    if (!narrowSide) {
      restoreSide.current = false;
      focusMainPending.current = false;
      return;
    }
    if (sideOpen) {
      const el = document.getElementById("chat-side");
      if (el && !el.contains(document.activeElement)) el.focus();
      return;
    }
    if (focusMainPending.current) {
      focusMainPending.current = false;
      requestAnimationFrame(() => document.getElementById("chat-main-title")?.focus());
    } else if (restoreSide.current) {
      restoreSide.current = false;
      document.getElementById("side-toggle")?.focus();
    }
  }, [sideOpen, narrowSide]);

  useEffect(() => {
    if (!narrowRail) {
      restoreRail.current = false;
      return;
    }
    if (railDrawer) {
      const el = document.getElementById("agent-rail");
      if (el && !el.contains(document.activeElement)) el.focus();
      return;
    }
    if (restoreRail.current) {
      restoreRail.current = false;
      document.getElementById("rail-toggle")?.focus();
    }
  }, [railDrawer, narrowRail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 弹层有自己的 Escape 处理，别同时把背后的抽屉也关掉
        if (document.querySelector(".modal-overlay")) return;
        if (sideOpen) {
          restoreSide.current = true;
          setSideOpen(false);
          return;
        }
        if (railDrawer) {
          restoreRail.current = true;
          setRailDrawer(false);
          return;
        }
        setSelectedAgent(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        (document.querySelector(".compose-input") as HTMLTextAreaElement | null)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sideOpen, railDrawer]);

  // 选中代理时自动打开右栏抽屉（仅窄屏）
  const selectAgent = useCallback(
    (id: string | null) => {
      setSelectedAgent(id);
      if (id && narrowRail) {
        setSideOpen(false);
        setRailDrawer(true);
      }
    },
    [narrowRail],
  );

  const selectHistory = useCallback((id: string | null) => {
    setViewTaskId(id);
    setSelectedAgent(null);
    stick.current = true;
  }, []);

  async function toggleRecord() {
    const enabled = !(gw?.enabled ?? true);
    setGw((p: any) => ({ ...p, enabled }));
    await fetch("/api/gateway", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "record", payload: { enabled } }),
    });
  }

  async function patchChat(id: string, patch: { title?: string; repoPath?: string }): Promise<string | null> {
    try {
      const r = await fetch(`/api/chats/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return j.error || "保存失败";
      if (j.chat) mergeChat(j.chat);
      return null;
    } catch (e: any) {
      return e?.message || "请求失败";
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!current) {
        const r = await fetch("/api/chats", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, repoPath: repoPath.trim() || undefined }),
        });
        const j = await r.json();
        if (j.chat) {
          mergeChat(j.chat);
          setCurrentId(j.chat.id);
          setViewTaskId(null);
          setDraft("");
          setRepoPath("");
          setSelectedAgent(null);
        }
        if (j.error) setError(j.error);
      } else {
        const r = await fetch(`/api/chats/${current.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const j = await r.json();
        if (!r.ok) setError(j.error || "发送失败");
        else {
          setDraft("");
          if (j.chat) mergeChat(j.chat);
        }
      }
    } catch (e: any) {
      setError(e?.message || "请求失败");
    } finally {
      setBusy(false);
    }
  }

  // 确认面板里的「确认执行」：必要时先改仓库，再显式 POST run
  async function confirmRun(goal: string, agents: number, repo: string) {
    if (!current || runBusy) return;
    setRunBusy(true);
    setError("");
    try {
      const nextRepo = repo.trim() ? repo.trim() : "";
      if ((current.repoPath || "") !== nextRepo) {
        const err = await patchChat(current.id, { repoPath: nextRepo });
        if (err) {
          setError(err);
          return;
        }
      }
      setCount(agents);
      const r = await fetch(`/api/chats/${current.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agents, goal }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(r.status === 409 ? j.error || "会话还有任务在执行" : j.error || "启动失败");
        return;
      }
      if (j.chat) mergeChat(j.chat);
      setRunOpen(false);
      setViewTaskId(null);
      setSelectedAgent(null);
    } catch (e: any) {
      setError(e?.message || "启动失败");
    } finally {
      setRunBusy(false);
    }
  }

  async function confirmStop() {
    if (!liveTask || stopBusy) return;
    setStopBusy(true);
    setStopErr("");
    try {
      const r = await fetch(`/api/tasks/${liveTask.id}/cancel`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStopErr(r.status === 409 ? "任务已结束，无需停止" : j.error || "停止失败");
        return;
      }
      setStopOpen(false);
    } catch (e: any) {
      setStopErr(e?.message || "停止失败");
    } finally {
      setStopBusy(false);
    }
  }

  async function renameChat(id: string, title: string): Promise<string | null> {
    return patchChat(id, { title });
  }

  async function deleteChatById(id: string, withTasks: boolean): Promise<string | null> {
    try {
      const r = await fetch(`/api/chats/${id}${withTasks ? "?withTasks=1" : ""}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        return r.status === 409 ? j.error || "会话还有任务在执行，请先停止" : j.error || "删除失败";
      }
      setChats((prev) => prev.filter((c) => c.id !== id));
      if (currentId === id) {
        setCurrentId(null);
        setViewTaskId(null);
        setSelectedAgent(null);
        try {
          localStorage.removeItem(LAST_CHAT_KEY);
        } catch {
          /* ignore */
        }
      }
      return null;
    } catch (e: any) {
      return e?.message || "请求失败";
    }
  }

  const deleteTaskById = useCallback(async (id: string): Promise<string | null> => {
    try {
      const r = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        return r.status === 409 ? j.error || "任务还在执行，请先停止" : j.error || "删除失败";
      }
      setTasks((prev) => {
        const next = prev.filter((t) => t.id !== id);
        return next.length === prev.length ? prev : next;
      });
      setViewTaskId((prev) => (prev === id ? null : prev));
      return null;
    } catch (e: any) {
      return e?.message || "请求失败";
    }
  }, []);

  // 抽屉关闭：toMain=true 表示选完会话，焦点交给主区标题；否则回到触发按钮
  function closeSide(toMain: boolean) {
    if (toMain) focusMainPending.current = sideOpen;
    else restoreSide.current = sideOpen;
    setSideOpen(false);
  }

  function closeRail() {
    restoreRail.current = railDrawer;
    setRailDrawer(false);
  }

  // 两个抽屉互斥，避免窄屏上叠在一起
  function toggleSide() {
    setRailDrawer(false);
    setSideOpen((v) => !v);
  }

  function toggleRail() {
    setSideOpen(false);
    setRailDrawer((v) => !v);
  }

  function newChat() {
    setCurrentId(null);
    setViewTaskId(null);
    setDraft("");
    setRepoPath("");
    setSelectedAgent(null);
    setError("");
    setRepoEdit(false);
    if (narrowSide) closeSide(true);
  }

  function selectChat(id: string) {
    setCurrentId(id);
    setViewTaskId(null);
    setSelectedAgent(null);
    setError("");
    setRepoEdit(false);
    stick.current = true;
    // 选中会话后自动收起侧栏抽屉，避免遮住刚打开的对话
    if (narrowSide) closeSide(true);
  }

  function openRepoEdit() {
    if (!current) return;
    setRepoDraft(current.repoPath || "");
    setRepoErr("");
    setRepoEdit(true);
  }

  async function saveRepo() {
    if (!current || repoBusy) return;
    setRepoBusy(true);
    setRepoErr("");
    const err = await patchChat(current.id, { repoPath: repoDraft.trim() });
    setRepoBusy(false);
    if (err) setRepoErr(err);
    else setRepoEdit(false);
  }

  const canRun = !!current && !liveTask && current.messages.some((m) => m.role === "user" && m.text.trim());

  // 桌面端：有任务时右栏恢复完整宽度；纯对话阶段默认收成窄条
  const railExpanded = !!viewedTask || railWide;

  return (
    <div
      className="chat-shell"
      data-rail={railExpanded ? "wide" : "compact"}
      data-side-open={sideOpen ? "true" : "false"}
      data-rail-open={railDrawer ? "true" : "false"}
    >
      <Sidebar
        chats={chats}
        tasks={tasks}
        currentId={currentId}
        now={now}
        narrow={narrowSide}
        open={sideOpen}
        onNew={newChat}
        onSelect={selectChat}
        onRename={renameChat}
        onDelete={deleteChatById}
        onClose={() => closeSide(false)}
        connected={connected}
        gw={gw}
        onToggleRecord={toggleRecord}
      />

      <main className="chat-main">
        <header className="chat-topbar">
          <IconBtn
            id="side-toggle"
            className="nav-toggle"
            label={sideOpen ? "关闭会话列表" : "打开会话列表"}
            aria-expanded={sideOpen}
            aria-controls="chat-side"
            icon={<Icon name="menu" size={16} />}
            onClick={toggleSide}
          />
          {current ? (
            <>
              <span className="chat-title" id="chat-main-title" tabIndex={-1}>
                {current.title}
              </span>
              {repoEdit ? (
                <span className="topbar-repo-edit">
                  <input
                    className="topbar-repo-input"
                    value={repoDraft}
                    onChange={(e) => setRepoDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRepo();
                      if (e.key === "Escape") setRepoEdit(false);
                    }}
                    placeholder="留空表示默认工作区"
                    aria-label="目标仓库路径"
                    title="目标仓库路径"
                    spellCheck={false}
                    autoFocus
                  />
                  <IconBtn
                    label="保存仓库路径"
                    title="保存仓库路径"
                    icon={repoBusy ? <Spinner size={13} /> : <Icon name="check" size={14} />}
                    disabled={repoBusy}
                    onClick={() => void saveRepo()}
                  />
                  <IconBtn
                    label="取消编辑仓库路径"
                    title="取消编辑"
                    icon={<Icon name="close" size={14} />}
                    disabled={repoBusy}
                    onClick={() => setRepoEdit(false)}
                  />
                  {repoErr && <span className="topbar-repo-err">{repoErr}</span>}
                </span>
              ) : (
                <button
                  className="topbar-repo"
                  onClick={openRepoEdit}
                  aria-label={`目标仓库：${current.repoPath || "默认工作区"}，点击修改`}
                  title="点击修改目标仓库"
                >
                  <Icon name="branch" size={12} />
                  <span className="topbar-repo-text">{current.repoPath || "默认工作区"}</span>
                </button>
              )}
              <span
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  flex: "none",
                  whiteSpace: "nowrap",
                }}
              >
                <button
                  id="rail-toggle"
                  type="button"
                  className="rail-toggle"
                  aria-expanded={railDrawer}
                  aria-controls="agent-rail"
                  aria-label="执行代理面板"
                  title="执行代理面板"
                  onClick={toggleRail}
                >
                  <Icon name="panel" size={14} />
                  <span>执行代理</span>
                </button>
                <Dot tone={stateInfo ? stateInfo.tone : "neutral"} live={stateInfo ? stateInfo.live : false} />
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                  {stateInfo ? stateInfo.label : "对话中"}
                </span>
                {latestTask && (
                  <Tag tone="neutral" mono>
                    {fmt(latestTask.totalUsage)}
                  </Tag>
                )}
              </span>
            </>
          ) : (
            <>
              <span className="chat-title" id="chat-main-title" tabIndex={-1} style={{ color: "var(--ink-3)" }}>
                新建会话
              </span>
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", flex: "none" }}>
                <button
                  id="rail-toggle"
                  type="button"
                  className="rail-toggle"
                  aria-expanded={railDrawer}
                  aria-controls="agent-rail"
                  aria-label="执行代理面板"
                  title="执行代理面板"
                  onClick={toggleRail}
                >
                  <Icon name="panel" size={14} />
                  <span>执行代理</span>
                </button>
              </span>
            </>
          )}
        </header>

        <div className="transcript-scroll" ref={scrollRef}>
          {current ? (
            <Transcript
              chat={current}
              task={viewedTask}
              now={now}
              latestTaskId={latestTask?.id || null}
              viewTaskId={activeViewTaskId}
              historyTasks={chatTasks}
              onSelectHistory={selectHistory}
              onOpenAgent={selectAgent}
              onDeleteTask={deleteTaskById}
            />
          ) : (
            <div className="empty-chat">
              <div className="empty-mark">
                <BrandMark size={44} />
              </div>
              <div style={{ fontSize: 17, fontWeight: 550, letterSpacing: "-0.01em" }}>
                先和编排器聊清楚
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.7 }}>
                这里只是对话：说明目标、约束和验收方式，编排器会给出拆分与检查方案。
                确认无误后点「开始执行」，会先让你确认目标、代理数量和仓库路径，再派出执行代理。
              </div>
              <div className="example-list">
                {EXAMPLES.map((x) => (
                  <button
                    key={x}
                    className="example-chip"
                    onClick={() => setDraft(x)}
                    title="点击填入输入框，确认后再发送"
                  >
                    {x}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {awayFromBottom && (
          <button
            className="jump-bottom"
            onClick={jumpToBottom}
            aria-label="回到底部并恢复跟随"
            title="回到底部"
          >
            <Icon name="down" size={14} />
            <span>回到底部</span>
          </button>
        )}

        {error && (
          <div className="compose-error" role="alert">
            {error}
          </div>
        )}

        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          busy={busy}
          disabled={running}
          isNew={!current}
          agents={count}
          setAgents={setCount}
          repoPath={repoPath}
          setRepoPath={setRepoPath}
          canRun={canRun}
          runBusy={runBusy}
          onRun={() => {
            setError("");
            setRunOpen(true);
          }}
          running={running}
          onStop={() => {
            setStopErr("");
            setStopOpen(true);
          }}
          placeholder={
            running
              ? "任务执行中，结束后可以继续对话"
              : !current
                ? "先描述目标，和编排器确认后再执行…"
                : latestTask
                  ? "继续和编排器讨论（解释检查、返工原因、下一步建议）…"
                  : "继续和编排器讨论，或确认后点「开始执行」…"
          }
          hint={
            running
              ? "执行中不可追问，可点「停止」"
              : canRun
                ? "确认目标后点「开始执行」"
                : undefined
          }
        />
      </main>

      {viewedTask ? (
        <AgentRail
          task={viewedTask}
          selectedId={selectedAgent}
          onSelect={selectAgent}
          gw={gw}
          onToggleRecord={toggleRecord}
          open={narrowRail ? railDrawer : true}
          onClose={narrowRail ? closeRail : undefined}
        />
      ) : narrowRail || railWide ? (
        <aside
          className="agent-rail"
          id="agent-rail"
          data-open={narrowRail ? railDrawer : true}
          inert={narrowRail && !railDrawer}
          aria-hidden={narrowRail && !railDrawer ? true : undefined}
          aria-label="执行代理"
          tabIndex={-1}
        >
          <div className="rail-head">
            <span style={{ fontSize: 13, fontWeight: 600 }}>执行代理</span>
            {narrowRail ? (
              <IconBtn
                className="rail-close"
                label="关闭执行代理栏"
                icon={<Icon name="close" size={15} />}
                onClick={closeRail}
                style={{ marginLeft: "auto" }}
              />
            ) : (
              <IconBtn
                className="rail-collapse"
                label="收起执行代理栏"
                icon={<Icon name="chevron" size={14} />}
                onClick={() => setRailWide(false)}
                style={{ marginLeft: "auto" }}
              />
            )}
          </div>
          <div className="rail-scroll">
            <div className="msg-muted" style={{ padding: "8px 4px", lineHeight: 1.7 }}>
              现在还在对话阶段。点「开始执行」并确认后，这里会列出每个执行代理的状态、分支、token 与改动文件。
            </div>
          </div>
        </aside>
      ) : (
        <aside className="agent-rail agent-rail-compact" id="agent-rail" aria-label="执行代理">
          <button
            type="button"
            className="rail-compact-btn"
            aria-label="展开执行代理栏"
            title="展开执行代理栏"
            onClick={() => setRailWide(true)}
          >
            <Icon name="panel" size={16} />
            <span className="rail-compact-label">执行代理</span>
          </button>
        </aside>
      )}

      <div
        className="drawer-backdrop"
        data-backdrop="side"
        data-open={sideOpen ? "true" : "false"}
        aria-hidden="true"
        onClick={() => closeSide(false)}
      />
      <div
        className="drawer-backdrop"
        data-backdrop="rail"
        data-open={railDrawer ? "true" : "false"}
        aria-hidden="true"
        onClick={closeRail}
      />

      {runOpen && current && (
        <RunDialog
          chatTitle={current.title}
          repoPath={current.repoPath || ""}
          agents={count}
          lastUserText={lastUserText}
          taskCount={chatTasks.length}
          busy={runBusy}
          error={error}
          onClose={() => {
            if (!runBusy) setRunOpen(false);
          }}
          onSubmit={(goal, agents, repo) => void confirmRun(goal, agents, repo)}
        />
      )}

      {stopOpen && liveTask && (
        <Confirm
          title="停止执行"
          tone="danger"
          confirmLabel="停止执行"
          busy={stopBusy}
          error={stopErr}
          onConfirm={() => void confirmStop()}
          onClose={() => {
            if (!stopBusy) setStopOpen(false);
          }}
          message={
            <>
              确定停止任务 <span className="code">{liveTask.id.slice(0, 8)}</span>？
              已完成的代理改动会保留，未完成的部分不再继续。停止后可以重新执行。
            </>
          }
        />
      )}
    </div>
  );
}

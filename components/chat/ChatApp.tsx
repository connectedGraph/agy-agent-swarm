"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Task } from "@/lib/types";
import { BrandMark } from "@/components/console/Header";
import { Dot, Tag } from "@/components/ui/kit";
import { STATE_LABEL, STATE_TONE, fmt, isLive } from "@/components/console/shared";
import { Sidebar } from "./Sidebar";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { AgentRail } from "./AgentRail";

const EXAMPLES = [
  "新增 README：说明仓库用途与文件结构，并附上实际运行过的检查命令",
  "修掉 python 语法错误，先用 py_compile 复现再改，把输出写进 evidence/",
  "补一个 CLI 参数解析，用 node --check 和真实执行做验收",
];

export default function ChatApp() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [gw, setGw] = useState<any>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [count, setCount] = useState(3);
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

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
        setTasks(ev.tasks || []);
        setChats(ev.chats || []);
      } else if (ev.type === "session") {
        setChats((prev) => {
          const i = prev.findIndex((c) => c.id === ev.chat.id);
          if (i < 0) return [ev.chat, ...prev];
          const next = prev.slice();
          next[i] = ev.chat;
          return next;
        });
      } else if (ev.type === "task") {
        setTasks((prev) => {
          const i = prev.findIndex((t) => t.id === ev.task.id);
          if (i < 0) return [ev.task, ...prev];
          const next = prev.slice();
          next[i] = ev.task;
          return next;
        });
      } else if (ev.type === "agent") {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === ev.taskId
              ? { ...t, agents: t.agents.map((a) => (a.id === ev.agent.id ? { ...a, ...ev.agent } : a)) }
              : t,
          ),
        );
      } else if (ev.type === "boss") {
        setTasks((prev) => prev.map((t) => (t.id === ev.taskId ? { ...t, boss: ev.boss } : t)));
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/gateway", { cache: "no-store" });
        const j = await r.json();
        if (alive) setGw(j);
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const current = useMemo(() => chats.find((c) => c.id === currentId) || null, [chats, currentId]);
  const task = useMemo(() => (current?.taskId ? tasks.find((t) => t.id === current.taskId) || null : null), [current, tasks]);

  // 新消息或状态变化时跟到底
  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [currentId]);

  useEffect(() => {
    if (stick.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [current?.messages, task?.state, task?.boss?.text, task?.agents]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedAgent(null);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        (document.querySelector(".compose-input") as HTMLTextAreaElement | null)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
          setChats((prev) => [j.chat, ...prev.filter((c) => c.id !== j.chat.id)]);
          setCurrentId(j.chat.id);
          setDraft("");
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
        else setDraft("");
      }
    } catch (e: any) {
      setError(e?.message || "请求失败");
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!current || runBusy) return;
    setRunBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/chats/${current.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agents: count }),
      });
      const j = await r.json();
      if (!r.ok) setError(j.error || "启动失败");
    } catch (e: any) {
      setError(e?.message || "启动失败");
    } finally {
      setRunBusy(false);
    }
  }

  function newChat() {
    setCurrentId(null);
    setDraft("");
    setSelectedAgent(null);
    setError("");
  }

  const running = task ? isLive(task.state) : false;
  const canRun = !!current && !task && current.messages.some((m) => m.role === "user");
  const stateLabel = task ? STATE_LABEL[task.state] : current ? "对话中" : "";

  return (
    <div className="chat-shell">
      <Sidebar
        chats={chats}
        tasks={tasks}
        currentId={currentId}
        onNew={newChat}
        onSelect={(id) => {
          setCurrentId(id);
          setSelectedAgent(null);
          setError("");
          stick.current = true;
        }}
        connected={connected}
        gw={gw}
        onToggleRecord={toggleRecord}
      />

      <main className="chat-main">
        <header className="chat-topbar">
          {current ? (
            <>
              <span className="chat-title">{current.title}</span>
              <span className="chat-sub">{current.repoPath || "默认工作区"}</span>
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
                <Dot tone={task ? STATE_TONE[task.state] : "neutral"} live={running} />
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{stateLabel}</span>
                {task && (
                  <Tag tone="neutral" mono>
                    {fmt(task.totalUsage)}
                  </Tag>
                )}
              </span>
            </>
          ) : (
            <span className="chat-title" style={{ color: "var(--ink-3)" }}>
              新建会话
            </span>
          )}
        </header>

        <div className="transcript-scroll" ref={scrollRef}>
          {current ? (
            <Transcript chat={current} task={task} onOpenAgent={(id) => setSelectedAgent(id)} />
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
                确认无误后点「开始执行」，才会派出执行代理，在各自的 worktree 和 bubblewrap 沙箱里工作。
              </div>
              <div className="example-list">
                {EXAMPLES.map((x) => (
                  <button key={x} className="example-chip" onClick={() => setDraft(x)}>
                    {x}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

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
          onRun={run}
          placeholder={
            running
              ? "任务执行中，结束后可以继续对话"
              : !current
                ? "先描述目标，和编排器确认后再执行…"
                : task
                  ? "继续和编排器讨论（解释检查、返工原因、下一步建议）…"
                  : "继续和编排器讨论，或确认后点「开始执行」…"
          }
          hint={running ? "执行中不可追问" : canRun ? "确认目标后点「开始执行」" : undefined}
        />
      </main>

      {task ? (
        <AgentRail
          task={task}
          selectedId={selectedAgent}
          onSelect={setSelectedAgent}
          gw={gw}
          onToggleRecord={toggleRecord}
        />
      ) : (
        <aside className="agent-rail">
          <div className="rail-head">
            <span style={{ fontSize: 13, fontWeight: 600 }}>执行代理</span>
          </div>
          <div className="rail-scroll">
            <div className="msg-muted" style={{ padding: "8px 4px", lineHeight: 1.7 }}>
              现在还在对话阶段。点「开始执行」后，这里会列出每个执行代理的状态、分支、token 与改动文件。
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}

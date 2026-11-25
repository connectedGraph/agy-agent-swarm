"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@/lib/types";
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [gw, setGw] = useState<any>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [count, setCount] = useState(3);
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
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
      } else if (ev.type === "chat") {
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== ev.taskId) return t;
            const list = t.messages ? t.messages.slice() : [];
            const i = list.findIndex((m) => m.id === ev.message.id);
            if (i < 0) list.push(ev.message);
            else list[i] = ev.message;
            return { ...t, messages: list };
          }),
        );
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

  const current = useMemo(() => tasks.find((t) => t.id === currentId) || null, [tasks, currentId]);

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
  }, [current?.messages, current?.boss?.text, current?.state, current?.agents]);

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
        const r = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: text, agents: count, repoPath: repoPath.trim() || undefined }),
        });
        const j = await r.json();
        if (j.task) {
          setTasks((prev) => [j.task, ...prev.filter((t) => t.id !== j.task.id)]);
          setCurrentId(j.task.id);
          setDraft("");
          setSelectedAgent(null);
        } else {
          setError(j.error || "提交失败");
        }
      } else {
        const r = await fetch(`/api/tasks/${current.id}/messages`, {
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

  function newChat() {
    setCurrentId(null);
    setDraft("");
    setSelectedAgent(null);
    setError("");
  }

  const running = current ? isLive(current.state) : false;

  return (
    <div className="chat-shell">
      <Sidebar
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
              <span className="chat-title">{current.goal}</span>
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
                <Dot tone={STATE_TONE[current.state]} live={running} />
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{STATE_LABEL[current.state]}</span>
                <Tag tone="neutral" mono>
                  {fmt(current.totalUsage)}
                </Tag>
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
            <Transcript task={current} onOpenAgent={(id) => setSelectedAgent(id)} />
          ) : (
            <div className="empty-chat">
              <div className="empty-mark">
                <BrandMark size={44} />
              </div>
              <div style={{ fontSize: 17, fontWeight: 550, letterSpacing: "-0.01em" }}>
                把目标交给编排器
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.7 }}>
                编排器先定契约与检查命令，再派执行代理在各自 worktree 和 bubblewrap 沙箱里工作；
                合并后跑真实检查，由独立验证器复核，只把通过的结果合回主干。
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
          placeholder={
            !current
              ? "描述目标、验收方式与不允许做的事…"
              : running
                ? "任务执行中，结束后可以继续追问编排器"
                : "继续追问编排器（解释检查、返工原因、下一步建议）…"
          }
          hint={running ? "执行中不可追问" : undefined}
        />
      </main>

      {current ? (
        <AgentRail
          task={current}
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
              提交任务后，这里会列出每个执行代理：状态、分支、token 与改动文件。
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}

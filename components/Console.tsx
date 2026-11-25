"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@/lib/types";
import { Header } from "./console/Header";
import { TaskRail } from "./console/TaskRail";
import { Stage } from "./console/Stage";
import { EmptyState } from "./console/EmptyState";
import { Ledger } from "./console/Ledger";
import { GatewayCard } from "./console/GatewayCard";
import { AgentDetail } from "./console/AgentDetail";

export default function Console() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [gw, setGw] = useState<any>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    esRef.current = es;
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
        setCurrentId((id) => id || ev.tasks?.[0]?.id || null);
      } else if (ev.type === "task") {
        setTasks((prev) => {
          const i = prev.findIndex((t) => t.id === ev.task.id);
          if (i < 0) return [ev.task, ...prev];
          const next = prev.slice();
          next[i] = ev.task;
          return next;
        });
        setCurrentId((id) => id || ev.task.id);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedAgent(null);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('header input[aria-label="任务目标"]')?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = useMemo(() => tasks.find((t) => t.id === currentId) || null, [tasks, currentId]);

  async function submit() {
    const g = goal.trim();
    if (!g || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: g, agents: count }),
      });
      const j = await r.json();
      if (j.task) {
        setTasks((prev) => [j.task, ...prev.filter((t) => t.id !== j.task.id)]);
        setCurrentId(j.task.id);
        setGoal("");
        setSelectedAgent(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecord() {
    const enabled = !(gw?.enabled ?? true);
    setGw((p: any) => ({ ...p, enabled }));
    await fetch("/api/gateway", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "record", payload: { enabled } }),
    });
  }

  function selectTask(id: string) {
    setCurrentId(id);
    setSelectedAgent(null);
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header
        connected={connected}
        goal={goal}
        setGoal={setGoal}
        count={count}
        setCount={setCount}
        submit={submit}
        busy={busy}
      />

      <div className="console-grid">
        <aside
          className="console-left overflow-y-auto"
          style={{ borderRight: "1px solid var(--line)", padding: 12 }}
        >
          <TaskRail tasks={tasks} currentId={currentId} onSelect={selectTask} />
        </aside>

        <main className="overflow-y-auto" style={{ padding: "26px 30px 56px" }}>
          {!current ? (
            <EmptyState goal={goal} setGoal={setGoal} onSubmit={submit} busy={busy} />
          ) : (
            <Stage key={current.id} task={current} selectedAgent={selectedAgent} onSelect={setSelectedAgent} />
          )}
        </main>

        <aside
          className="console-right overflow-y-auto flex flex-col"
          style={{ borderLeft: "1px solid var(--line)", padding: 12, gap: 12 }}
        >
          <Ledger task={current} />
          <GatewayCard gw={gw} onToggle={toggleRecord} />
          {current && selectedAgent && (
            <AgentDetail
              agent={current.agents.find((a) => a.id === selectedAgent)!}
              onClose={() => setSelectedAgent(null)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

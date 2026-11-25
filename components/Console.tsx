"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRun, GatewayStats, Task } from "@/lib/types";

const STATE_LABEL: Record<string, string> = {
  queued: "排队",
  booting: "启动",
  working: "执行中",
  done: "完成",
  failed: "失败",
  planning: "规划中",
  running: "集群执行",
  merging: "合并中",
  verifying: "验收中",
  rework: "返工中",
  aggregating: "汇总中",
  idle: "待命",
};

const STATE_COLOR: Record<string, string> = {
  queued: "var(--ink-faint)",
  booting: "var(--cyan)",
  working: "var(--mint)",
  done: "var(--mint)",
  failed: "var(--rose)",
  planning: "var(--amber)",
  running: "var(--mint)",
  merging: "var(--violet)",
  verifying: "var(--cyan)",
  rework: "var(--rose)",
  aggregating: "var(--amber)",
};

function fmt(n?: number | null) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function dur(ms?: number | null) {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m" + Math.floor((ms % 60000) / 1000) + "s";
}

function usageTotal(a: AgentRun) {
  return a.spent || a.usage?.totalTokens || (a.usage?.inputTokens || 0) + (a.usage?.outputTokens || 0);
}

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

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="h-14 flex items-center gap-4 px-5 border-b hairline flex-none">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg grid place-items-center" style={{ background: "rgba(95,240,176,.12)", border: "1px solid rgba(95,240,176,.35)" }}>
            <div className="w-2.5 h-2.5 rounded-sm" style={{ background: "var(--mint)", boxShadow: "0 0 10px var(--mint)" }} />
          </div>
          <div>
            <div className="text-[13px] font-medium tracking-wide">SWARM</div>
            <div className="label" style={{ fontSize: 9 }}>Agent 集群编排</div>
          </div>
        </div>

        <div className="ml-6 flex items-center gap-2">
          <span className="chip">
            <span className="dot" style={{ background: connected ? "var(--mint)" : "var(--rose)" }} />
            {connected ? "事件流已连接" : "事件流断开"}
          </span>
          <span className="chip mono">包工头 · deepseek-v4.1-flash</span>
          <span className="chip mono">工人 · agy ACP</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <input
            className="input"
            style={{ width: 380 }}
            placeholder="给集群一个目标，例如：给这个仓库补一套 API 冒烟测试"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <select
            className="input mono"
            style={{ width: 92 }}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n} style={{ background: "#0d1219" }}>
                {n} 工人
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !goal.trim()}>
            {busy ? "派发中" : "派发任务"}
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: "248px 1fr 330px" }}>
        {/* 左：任务流 */}
        <aside className="border-r hairline overflow-y-auto p-3 flex flex-col gap-1.5">
          <div className="label px-2 py-2">任务流</div>
          {tasks.length === 0 && <div className="text-[11px] px-2" style={{ color: "var(--ink-faint)" }}>还没有任务</div>}
          {tasks.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setCurrentId(t.id);
                setSelectedAgent(null);
              }}
              className="text-left rounded-xl px-3 py-2.5 transition-colors"
              style={{
                background: t.id === currentId ? "rgba(95,240,176,.07)" : "transparent",
                border: `1px solid ${t.id === currentId ? "rgba(95,240,176,.28)" : "transparent"}`,
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="dot" style={{ background: STATE_COLOR[t.state] || "var(--ink-faint)" }} />
                <span className="text-[11px]" style={{ color: t.id === currentId ? "var(--ink)" : "var(--ink-dim)" }}>
                  {STATE_LABEL[t.state] || t.state}
                </span>
                <span className="ml-auto mono text-[10px]" style={{ color: "var(--ink-faint)" }}>
                  {fmt(t.totalUsage)}
                </span>
              </div>
              <div className="text-[12px] leading-snug line-clamp-2" style={{ color: t.id === currentId ? "var(--ink)" : "var(--ink-dim)" }}>
                {t.goal}
              </div>
            </button>
          ))}
        </aside>

        {/* 中：舞台 */}
        <main className="overflow-y-auto p-5">
          {!current ? (
            <EmptyStage goal={goal} setGoal={setGoal} count={count} setCount={setCount} onSubmit={submit} busy={busy} />
          ) : (
            <Stage task={current} selectedAgent={selectedAgent} onSelect={setSelectedAgent} />
          )}
        </main>

        {/* 右：账本与网关 */}
        <aside className="border-l hairline overflow-y-auto p-3 flex flex-col gap-3">
          <Ledger task={current} />
          <GatewayPanel gw={gw} onToggle={toggleRecord} />
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

/* ---------------- 空状态 ---------------- */

function EmptyStage(props: {
  goal: string;
  setGoal: (s: string) => void;
  count: number;
  setCount: (n: number) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div className="h-full grid place-items-center">
      <div className="max-w-[560px] text-center fade-in">
        <div className="label mb-4">ORCHESTRATION CONSOLE</div>
        <h1 className="text-[30px] leading-tight font-semibold tracking-tight mb-3">
          一个包工头，<span style={{ color: "var(--mint)" }}>一群工人</span>
        </h1>
        <p className="text-[13px] leading-relaxed mb-8" style={{ color: "var(--ink-dim)" }}>
          包工头把目标拆成写作用域互不重叠的子任务，派给各自独立 worktree 里的 agy 子代理。
          每一笔 token 都会落到账本上。
        </p>
        <div className="flex gap-2 justify-center">
          <input
            className="input"
            style={{ width: 380 }}
            placeholder="例如：为这个仓库补一套单元测试"
            value={props.goal}
            onChange={(e) => props.setGoal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && props.onSubmit()}
          />
          <button className="btn btn-primary" onClick={props.onSubmit} disabled={props.busy || !props.goal.trim()}>
            派发
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 舞台 ---------------- */

function Stage({ task, selectedAgent, onSelect }: { task: Task; selectedAgent: string | null; onSelect: (id: string | null) => void }) {
  const done = task.agents.filter((a) => a.state === "done").length;
  return (
    <div className="fade-in">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="dot" style={{ background: STATE_COLOR[task.state] || "var(--ink-faint)" }} />
            <span className="label">{STATE_LABEL[task.state] || task.state}</span>
            <span className="label mono">{task.agents.length} 工人 · {done} 完成</span>
          </div>
          <h2 className="text-[17px] font-medium leading-snug">{task.goal}</h2>
        </div>
        <div className="text-right">
          <div className="label mb-1">总账</div>
          <div className="mono text-[22px]" style={{ color: "var(--mint)" }}>{fmt(task.totalUsage)}</div>
          <div className="mono text-[10px]" style={{ color: "var(--ink-faint)" }}>tokens</div>
        </div>
      </div>

      <BossCard task={task} />

      <div className="flex justify-center py-1">
        <div className="connector" style={{ height: 18 }} />
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
        {task.agents.map((a) => (
          <AgentCard key={a.id} agent={a} selected={selectedAgent === a.id} onClick={() => onSelect(selectedAgent === a.id ? null : a.id)} />
        ))}
      </div>

      <ReworkPanel task={task} />
      <VerificationPanel task={task} />
      <VerifierCard task={task} />

      {task.summary && (
        <div className="panel mt-4 p-4 fade-in">
          <div className="label mb-2">包工头汇总</div>
          <div className="text-[13px] leading-relaxed" style={{ color: "var(--ink)" }}>{task.summary}</div>
        </div>
      )}
    </div>
  );
}

function ReworkPanel({ task }: { task: Task }) {
  const rounds = task.rework || [];
  if (!rounds.length) return null;
  return (
    <div className="panel mt-4 p-4 fade-in">
      <div className="flex items-center gap-2 mb-2">
        <div className="label">返工</div>
        <span className="chip mono">{rounds.length} 轮</span>
        <span className="ml-auto mono text-[10px]" style={{ color: "var(--ink-faint)" }}>
          {rounds.filter((r) => r.ok).length} 轮修复
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {rounds.map((r, i) => (
          <details key={i}>
            <summary className="flex items-center gap-2 cursor-pointer">
              <span className="mono text-[10px]" style={{ color: "var(--ink-faint)" }}>#{r.round}</span>
              <span
                className="chip"
                style={{
                  borderColor: r.target === "fixer" ? "rgba(167,139,250,.4)" : "rgba(255,107,122,.4)",
                  color: r.target === "fixer" ? "var(--violet)" : "var(--rose)",
                }}
              >
                {r.target === "fixer" ? "修复者" : "重跑工人"}
              </span>
              <span className="text-[11px]">{r.who}</span>
              <span className="text-[11px] truncate" style={{ color: "var(--ink-dim)", maxWidth: 220 }}>{r.reason}</span>
              <span className="ml-auto mono text-[10px]" style={{ color: r.ok ? "var(--mint)" : "var(--rose)" }}>
                {r.ok ? "有产出" : "无产出"} · {fmt(r.usage?.totalTokens || 0)}
              </span>
            </summary>
            <pre className="stream mt-1" style={{ maxHeight: 170, overflowY: "auto", whiteSpace: "pre-wrap" }}>
              {r.text || r.detail || "(无输出)"}
            </pre>
          </details>
        ))}
      </div>
    </div>
  );
}

function VerificationPanel({ task }: { task: Task }) {
  const v = task.verification;
  const verdict = task.verdict;
  const promote = task.promote;
  const [busy, setBusy] = useState(false);

  async function doPromote(force = false) {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/api/tasks/${task.id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!v && !verdict && !task.merge.length) return null;
  const tone = verdict ? (verdict.pass ? "var(--mint)" : "var(--rose)") : "var(--ink-dim)";
  return (
    <div className="panel mt-4 p-4 fade-in">
      <div className="flex items-center gap-2 mb-3">
        <div className="label">合并与验收</div>
        {verdict && (
          <span className="chip" style={{ borderColor: tone, color: tone }}>
            <span className="dot" style={{ background: tone }} />
            {verdict.pass ? "验收通过" : "验收未通过"}
          </span>
        )}
        {v && <span className="chip mono">{v.ok ? "自动检查通过" : "自动检查有问题"}</span>}
        <span className="ml-auto mono text-[10px] truncate" style={{ color: "var(--ink-faint)", maxWidth: 320 }}>
          {v ? v.integrationBranch : task.state === "merging" ? "合并中…" : ""}
        </span>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
        <div>
          <div className="label mb-1.5">分支合并</div>
          <div className="flex flex-col gap-1.5">
            {task.merge.length === 0 && <div className="text-[11px]" style={{ color: "var(--ink-faint)" }}>等待合并</div>}
            {task.merge.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="mono text-[10px]" style={{ color: "var(--ink-faint)" }}>{m.branch || "—"}</span>
                <span className="text-[11px]" style={{ color: "var(--ink-dim)" }}>{m.name}</span>
                <span
                  className="chip ml-auto"
                  style={{
                    borderColor: m.status === "merged" ? "rgba(95,240,176,.4)" : m.status === "conflict" ? "rgba(255,107,122,.4)" : "var(--line)",
                    color: m.status === "merged" ? "var(--mint)" : m.status === "conflict" ? "var(--rose)" : "var(--ink-faint)",
                  }}
                >
                  {m.status === "merged" ? "已合入" : m.status === "conflict" ? "冲突" : "跳过"}
                </span>
              </div>
            ))}
          </div>
          {v?.diffStat && (
            <details className="mt-2">
              <summary className="text-[10px] cursor-pointer" style={{ color: "var(--ink-faint)" }}>合并后差异</summary>
              <pre className="stream mt-1" style={{ whiteSpace: "pre-wrap" }}>{v.diffStat}</pre>
            </details>
          )}
        </div>

        <div>
          <div className="label mb-1.5">真实验收</div>
          <div className="flex flex-col gap-1.5">
            {v && v.checks.length === 0 && (
              <div className="text-[11px]" style={{ color: "var(--ink-faint)" }}>没有可识别的自动检查</div>
            )}
            {(v?.checks || []).map((c, i) => (
              <details key={i}>
                <summary className="flex items-center gap-2 cursor-pointer">
                  <span style={{ color: c.ok ? "var(--mint)" : "var(--rose)" }}>{c.ok ? "PASS" : "FAIL"}</span>
                  <span className="text-[11px]" style={{ color: "var(--ink-dim)" }}>{c.name}</span>
                  <span className="ml-auto mono text-[10px]" style={{ color: "var(--ink-faint)" }}>
                    exit {c.exitCode} · {c.ms}ms
                  </span>
                </summary>
                <pre className="stream mt-1" style={{ maxHeight: 160, overflowY: "auto", whiteSpace: "pre-wrap" }}>
                  {c.output || "(无输出)"}
                </pre>
              </details>
            ))}
          </div>
        </div>
      </div>

      {verdict && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px dashed rgba(120,150,180,.14)" }}>
          <div className="label mb-1.5">包工头判定</div>
          <div className="flex flex-col gap-1">
            {(verdict.reasons.length ? verdict.reasons : ["无理由"]).map((r, i) => (
              <div key={i} className="text-[12px] leading-relaxed" style={{ color: "var(--ink)" }}>· {r}</div>
            ))}
          </div>
        </div>
      )}

      {v && (
        <div className="mt-3 pt-3 flex flex-wrap items-center gap-2" style={{ borderTop: "1px dashed rgba(120,150,180,.14)" }}>
          <div className="label">主干</div>
          {promote?.ok ? (
            <span className="chip" style={{ borderColor: "var(--mint)", color: "var(--mint)" }}>
              已合入 {promote.target}
              {promote.commit ? ` @${promote.commit}` : ""}
            </span>
          ) : (
            <>
              <button
                className="btn"
                style={{ height: 26, padding: "0 10px", fontSize: 11 }}
                disabled={busy || !verdict?.pass}
                onClick={() => doPromote(false)}
              >
                {busy ? "合入中…" : `合入 ${promote?.target || "main"}`}
              </button>
              {verdict && !verdict.pass && (
                <button
                  className="btn"
                  style={{ height: 26, padding: "0 10px", fontSize: 11, color: "var(--rose)" }}
                  disabled={busy}
                  onClick={() => doPromote(true)}
                >
                  强制合入
                </button>
              )}
              <span className="text-[11px]" style={{ color: "var(--ink-faint)" }}>
                {verdict?.pass ? "验收通过后可一键合回主干" : "验收未通过，只能强制"}
              </span>
            </>
          )}
          {promote && !promote.ok && (
            <span className="text-[11px]" style={{ color: "var(--rose)" }}>{promote.detail}</span>
          )}
        </div>
      )}
    </div>
  );
}

function VerifierCard({ task }: { task: Task }) {
  const v = task.verifier;
  if (!v) return null;
  const tone = v.state === "done" ? "var(--mint)" : v.state === "failed" ? "var(--rose)" : "var(--cyan)";
  return (
    <div className="panel mt-4 p-4 fade-in">
      <div className="flex items-center gap-2 mb-2">
        <span className="chip" style={{ borderColor: tone, color: tone }}>独立验证者</span>
        <span className="chip mono">agy · 合并后完整代码</span>
        <span className="chip">
          <span className="dot" style={{ background: tone }} />
          {v.state === "done" ? "已完成" : v.state === "failed" ? "失败" : "验证中"}
        </span>
        <span className="ml-auto mono text-[10px]" style={{ color: "var(--ink-faint)" }}>
          {fmt(v.usage?.totalTokens || 0)} tokens
        </span>
      </div>
      <div className="stream" style={{ maxHeight: 200, overflowY: "auto" }}>
        {v.text || "验证者正在自己决定怎么验证…"}
      </div>
      {v.error && <div className="text-[11px] mt-2" style={{ color: "var(--rose)" }}>{v.error}</div>}
    </div>
  );
}

function BossCard({ task }: { task: Task }) {
  const boss = task.boss;
  const active = boss.state === "planning" || boss.state === "aggregating";
  return (
    <div className={`panel p-4 relative ${active ? "pulse-ring" : ""}`} style={{ borderColor: active ? "rgba(255,184,107,.35)" : undefined }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="chip" style={{ borderColor: "rgba(255,184,107,.35)", color: "var(--amber)" }}>包工头</span>
        <span className="chip mono">deepseek-v4.1-flash</span>
        <span className="chip">
          <span className="dot" style={{ background: STATE_COLOR[boss.state] || "var(--ink-faint)" }} />
          {STATE_LABEL[boss.state] || boss.state}
        </span>
        <span className="ml-auto mono text-[10px]" style={{ color: "var(--ink-faint)" }}>
          {fmt((boss.usage?.totalTokens || 0) + (boss.summaryUsage?.totalTokens || 0))} tokens
        </span>
      </div>
      {boss.planList?.length ? (
        <div className="flex flex-col gap-1.5">
          {boss.planList.map((p, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="mono text-[10px]" style={{ color: "var(--ink-faint)" }}>{String(i + 1).padStart(2, "0")}</span>
              <span className="text-[11px]" style={{ color: "var(--mint)" }}>{p.name}</span>
              <span className="text-[11px] truncate" style={{ color: "var(--ink-dim)" }}>
                {p.task.replace(/\s+/g, " ").slice(0, 110)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="stream" style={{ maxHeight: 74, overflow: "hidden" }}>
          {boss.text ? boss.text.slice(-420) : "等待拆解目标…"}
        </div>
      )}
      {boss.contract && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: "1px dashed rgba(120,150,180,.14)" }}>
          <span className="label" style={{ fontSize: 9 }}>共享契约</span>
          {(boss.contract.stack || []).slice(0, 3).map((x: string, i: number) => (
            <span key={i} className="chip mono">{x}</span>
          ))}
          <span className="chip">{(boss.contract.interfaces || []).length} 条接口</span>
          <span className="chip">{(boss.contract.dod || []).length} 条完成定义</span>
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent, selected, onClick }: { agent: AgentRun; selected: boolean; onClick: () => void }) {
  const total = usageTotal(agent);
  const input = agent.usage?.inputTokens || 0;
  const cached = agent.usage?.cachedReadTokens || 0;
  const out = (agent.usage?.outputTokens || 0) + (agent.usage?.thoughtTokens || 0);
  const max = Math.max(input + cached + out, 1);
  const elapsed = agent.startedAt ? (agent.endedAt || Date.now()) - agent.startedAt : 0;

  return (
    <button
      onClick={onClick}
      className={`agent-card panel text-left p-3.5 flex flex-col is-${agent.state}`}
      style={{
        minHeight: 196,
        borderColor: selected ? "rgba(95,240,176,.55)" : undefined,
        background: selected ? "rgba(95,240,176,.05)" : undefined,
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="mono text-[10px]" style={{ color: "var(--ink-faint)" }}>#{agent.index + 1}</span>
        <span className="text-[13px] font-medium">{agent.name}</span>
        <span className="chip ml-auto">
          <span className="dot" />
          {STATE_LABEL[agent.state] || agent.state}
        </span>
      </div>

      <div className="text-[11px] leading-snug mb-2 line-clamp-2" style={{ color: "var(--ink-dim)" }}>
        {agent.task || "等待包工头分配"}
      </div>

      <div className="stream flex-1 mb-2" style={{ maxHeight: 72, overflow: "hidden" }}>
        {agent.text ? agent.text.slice(-320) : agent.state === "queued" ? "…" : ""}
      </div>

      <div className="mt-auto">
        <div className="flex items-center justify-between mono text-[10px] mb-1.5" style={{ color: "var(--ink-faint)" }}>
          <span>{fmt(total)} tok</span>
          <span>{elapsed ? dur(elapsed) : ""}</span>
        </div>
        <div className="stat-bar flex">
          <i style={{ width: `${(cached / max) * 100}%`, background: "var(--cyan)", opacity: 0.55 }} />
          <i style={{ width: `${(input / max) * 100}%`, background: "var(--mint)" }} />
          <i style={{ width: `${(out / max) * 100}%`, background: "var(--amber)" }} />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="mono text-[9px]" style={{ color: "var(--ink-faint)" }}>{agent.branch || "—"}</span>
          <span className="mono text-[9px]" style={{ color: "var(--ink-faint)" }}>
            {agent.changedFiles.length ? `${agent.changedFiles.length} 文件` : ""}
          </span>
        </div>
      </div>
    </button>
  );
}

/* ---------------- 账本 ---------------- */

function Ledger({ task }: { task: Task | null }) {
  if (!task) {
    return (
      <div className="panel p-4">
        <div className="label mb-3">账本</div>
        <div className="text-[11px]" style={{ color: "var(--ink-faint)" }}>暂无数据</div>
      </div>
    );
  }
  const bossPlan = task.boss.usage?.totalTokens || 0;
  const bossSum = task.boss.summaryUsage?.totalTokens || 0;
  const workers = task.agents.map((a) => ({ name: a.name, tokens: usageTotal(a) }));
  const verifierTokens = task.verifier?.usage?.totalTokens || 0;
  const fixerTokens = (task.rework || [])
    .filter((r) => r.target === "fixer")
    .reduce((n, r) => n + (r.usage?.totalTokens || 0), 0);
  const total = bossPlan + bossSum + workers.reduce((n, w) => n + w.tokens, 0) + verifierTokens + fixerTokens;

  return (
    <div className="panel p-4">
      <div className="label mb-3">账本</div>
      <div className="flex items-end gap-2 mb-3">
        <div className="mono text-[26px] leading-none" style={{ color: "var(--mint)" }}>{fmt(total)}</div>
        <div className="text-[10px] mb-0.5" style={{ color: "var(--ink-faint)" }}>tokens</div>
      </div>

      <div className="flex h-2 rounded-full overflow-hidden mb-4" style={{ background: "rgba(120,150,180,.12)" }}>
        {bossPlan > 0 && <i style={{ width: `${(bossPlan / Math.max(total, 1)) * 100}%`, background: "var(--amber)" }} />}
        {bossSum > 0 && <i style={{ width: `${(bossSum / Math.max(total, 1)) * 100}%`, background: "rgba(255,184,107,.55)" }} />}
        {workers.map((w, i) => (
          <i key={i} style={{ width: `${(w.tokens / Math.max(total, 1)) * 100}%`, background: `rgba(95,240,176,${0.85 - i * 0.12})` }} />
        ))}
        {verifierTokens > 0 && <i style={{ width: `${(verifierTokens / Math.max(total, 1)) * 100}%`, background: "var(--violet)" }} />}
        {fixerTokens > 0 && <i style={{ width: `${(fixerTokens / Math.max(total, 1)) * 100}%`, background: "var(--rose)", opacity: 0.7 }} />}
      </div>

      <div className="ledger-row">
        <span className="text-[11px]" style={{ color: "var(--ink-dim)" }}>包工头 · 规划</span>
        <span className="mono text-[11px]">{fmt(bossPlan)}</span>
      </div>
      <div className="ledger-row">
        <span className="text-[11px]" style={{ color: "var(--ink-dim)" }}>包工头 · 汇总</span>
        <span className="mono text-[11px]">{fmt(bossSum)}</span>
      </div>
      {verifierTokens > 0 && (
        <div className="ledger-row">
          <span className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--ink-dim)" }}>
            <span className="dot" style={{ background: "var(--violet)" }} />
            验证者
          </span>
          <span className="mono text-[11px]">{fmt(verifierTokens)}</span>
        </div>
      )}
      {fixerTokens > 0 && (
        <div className="ledger-row">
          <span className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--ink-dim)" }}>
            <span className="dot" style={{ background: "var(--rose)" }} />
            返工修复
          </span>
          <span className="mono text-[11px]">{fmt(fixerTokens)}</span>
        </div>
      )}
      {workers.map((w, i) => (
        <div key={i} className="ledger-row">
          <span className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--ink-dim)" }}>
            <span className="dot" style={{ background: `rgba(95,240,176,${0.85 - i * 0.12})` }} />
            {w.name}
          </span>
          <span className="mono text-[11px]">{fmt(w.tokens)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 网关 ---------------- */

function GatewayPanel({ gw, onToggle }: { gw: any; onToggle: () => void }) {
  const offline = !gw || gw.offline;
  const stats: GatewayStats | undefined = gw?.stats;
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="label">API 网关</div>
        <span className="chip ml-auto">
          <span className="dot" style={{ background: offline ? "var(--ink-faint)" : "var(--mint)" }} />
          {offline ? "未启动" : "在线"}
        </span>
      </div>

      {offline ? (
        <div className="text-[11px] leading-relaxed" style={{ color: "var(--ink-faint)" }}>
          运行 <span className="mono">pnpm gateway</span> 启动录制网关，再把子代理的
          <span className="mono"> GOOGLE_GEMINI_BASE_URL </span>指向它。
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px]" style={{ color: "var(--ink-dim)" }}>录制完整 API 报文</span>
            <div className={`toggle ${gw.enabled ? "on" : ""}`} onClick={onToggle} />
          </div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="rounded-lg p-2" style={{ background: "rgba(0,0,0,.22)" }}>
              <div className="label mb-0.5">调用</div>
              <div className="mono text-[15px]">{stats?.totalCalls ?? 0}</div>
            </div>
            <div className="rounded-lg p-2" style={{ background: "rgba(0,0,0,.22)" }}>
              <div className="label mb-0.5">上游 token</div>
              <div className="mono text-[15px]">{fmt(stats?.totalTokens || 0)}</div>
            </div>
          </div>
          <div className="mono text-[9px] mb-2 truncate" style={{ color: "var(--ink-faint)" }}>
            {gw.upstream}
          </div>
          <div className="flex flex-col gap-1">
            {(stats?.recent || []).slice(-5).reverse().map((c, i) => (
              <div key={i} className="flex items-center gap-2 mono text-[10px]" style={{ color: "var(--ink-dim)" }}>
                <span style={{ color: c.status < 400 ? "var(--mint)" : "var(--rose)" }}>{c.status}</span>
                <span className="truncate flex-1">{c.model}</span>
                <span>{fmt(c.totalTokens)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- 代理详情 ---------------- */

function AgentDetail({ agent, onClose }: { agent: AgentRun; onClose: () => void }) {
  return (
    <div className="panel p-4 fade-in">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[13px] font-medium">{agent.name}</span>
        <span className="chip">
          <span className="dot" />
          {STATE_LABEL[agent.state]}
        </span>
        <button className="ml-auto btn" style={{ height: 24, padding: "0 8px", fontSize: 11 }} onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="text-[11px] mb-2" style={{ color: "var(--ink-dim)" }}>{agent.task}</div>
      {agent.scope?.length > 0 && (
        <>
          <div className="label mb-1">允许改动</div>
          <div className="mono text-[10px] mb-2" style={{ color: "var(--ink-dim)" }}>{agent.scope.join(" · ")}</div>
        </>
      )}
      {agent.acceptance?.length > 0 && (
        <>
          <div className="label mb-1">验收标准</div>
          <div className="text-[10px] mb-2 flex flex-col gap-0.5" style={{ color: "var(--ink-dim)" }}>
            {agent.acceptance.map((x, i) => <span key={i}>· {x}</span>)}
          </div>
        </>
      )}
      <div className="label mb-1">工作目录</div>
      <div className="mono text-[10px] mb-2 break-all" style={{ color: "var(--ink-faint)" }}>{agent.worktree || "—"}</div>
      <div className="label mb-1">改动</div>
      <div className="mono text-[10px] mb-2" style={{ color: "var(--ink-faint)" }}>
        {agent.changedFiles.length ? agent.changedFiles.join(" · ") : "无"}
      </div>
      <div className="label mb-1">输出</div>
      <div className="stream" style={{ maxHeight: 220, overflowY: "auto" }}>{agent.text || "—"}</div>
    </div>
  );
}

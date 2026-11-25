"use client";

import type { Task } from "@/lib/types";
import { Dot } from "@/components/ui/kit";
import { AgentCard } from "./AgentCard";
import { BossCard } from "./BossCard";
import { ReworkSection } from "./ReworkSection";
import { VerificationSection } from "./VerificationSection";
import { VerifierCard } from "./VerifierCard";
import { SummaryCard } from "./SummaryCard";
import { STATE_LABEL, STATE_TONE, dur, fmt, isLive } from "./shared";

export function Stage({
  task,
  selectedAgent,
  onSelect,
}: {
  task: Task;
  selectedAgent: string | null;
  onSelect: (id: string | null) => void;
}) {
  const done = task.agents.filter((a) => a.state === "done").length;
  const failed = task.agents.filter((a) => a.state === "failed").length;
  const failedVerdict = !!task.verdict && !task.verdict.pass;
  const elapsed = task.createdAt ? (task.finishedAt || Date.now()) - task.createdAt : 0;
  const n = task.agents.length;

  const cols =
    n <= 1
      ? "minmax(0, 420px)"
      : n === 2
        ? "repeat(2, minmax(0, 1fr))"
        : "repeat(auto-fit, minmax(230px, 1fr))";

  return (
    <div className="fade-up" style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div className="flex items-start" style={{ gap: 24, marginBottom: 18 }}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center flex-wrap" style={{ gap: 8, marginBottom: 6 }}>
            <span
              className="flex items-center gap-1.5"
              style={{ fontSize: 11.5, color: "var(--ink-2)" }}
            >
              <Dot tone={failedVerdict ? "bad" : STATE_TONE[task.state] || "neutral"} live={isLive(task.state)} />
              {failedVerdict ? "验收未通过" : STATE_LABEL[task.state] || task.state}
            </span>
            <span style={{ color: "var(--ink-4)", fontSize: 11 }}>
              {n} 个工人
              {done > 0 && done < n ? ` · ${done} 完成` : ""}
              {failed ? ` · ${failed} 失败` : ""}
            </span>
            {elapsed > 0 && (
              <span className="mono" style={{ color: "var(--ink-4)", fontSize: 10.5 }}>
                {dur(elapsed)}
              </span>
            )}
          </div>
          <h1 className="title" style={{ color: "var(--ink)" }}>
            {task.goal}
          </h1>
        </div>

        <div className="flex-none text-right" style={{ paddingTop: 4 }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 1 }}>总账</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
            {fmt(task.totalUsage)}
          </div>
          <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>tokens</div>
        </div>
      </div>

      <div className="flex flex-col" style={{ gap: 14 }}>
        <BossCard task={task} />

        {n > 0 && (
          <div className="grid" style={{ gridTemplateColumns: cols, gap: 12 }}>
            {task.agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                selected={selectedAgent === a.id}
                onClick={() => onSelect(selectedAgent === a.id ? null : a.id)}
              />
            ))}
          </div>
        )}

        <ReworkSection task={task} />
        <VerificationSection task={task} />
        <VerifierCard task={task} />
        <SummaryCard task={task} />

        {task.error && (
          <div
            className="card-flat"
            style={{ padding: 14, color: "var(--bad)", fontSize: 12, lineHeight: 1.7 }}
          >
            {task.error}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { Dot } from "@/components/ui/kit";
import type { Task } from "@/lib/types";
import { STATE_LABEL, STATE_TONE, clock, fmt, isLive } from "./shared";

export function TaskRail({
  tasks,
  currentId,
  onSelect,
}: {
  tasks: Task[];
  currentId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 12 }}>
      <div className="flex items-center justify-between" style={{ padding: "0 2px" }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.04em",
            color: "var(--ink-3)",
          }}
        >
          任务
        </span>
        <span className="code">{tasks.length}</span>
      </div>

      {tasks.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--ink-4)", padding: "0 2px" }}>还没有任务</div>
      ) : (
        <div className="flex flex-col" style={{ gap: 4 }}>
          {tasks.map((task) => {
            const selected = task.id === currentId;
            const failedVerdict = !!task.verdict && !task.verdict.pass;
            const tone = failedVerdict ? "bad" : STATE_TONE[task.state] || "neutral";
            const live = isLive(task.state);

            return (
              <button
                key={task.id}
                type="button"
                onClick={() => onSelect(task.id)}
                aria-pressed={selected}
                className={[
                  "group w-full text-left border rounded-[12px] p-3",
                  selected
                    ? "bg-[var(--surface)] [[data-theme=dark]_&]:bg-[var(--surface-3)] shadow-[var(--shadow-1)] [[data-theme=dark]_&]:shadow-none border-[var(--line)]"
                    : "bg-transparent border-transparent hover:bg-[var(--hover)]",
                ].join(" ")}
                style={{
                  transition:
                    "background-color 120ms var(--ease), border-color 120ms var(--ease), box-shadow 120ms var(--ease)",
                }}
              >
                <div className="flex items-center" style={{ gap: 6 }}>
                  <Dot tone={tone} live={live} />
                  <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                    {failedVerdict ? "未通过" : STATE_LABEL[task.state] || task.state}
                  </span>
                  <span
                    className="num ml-auto"
                    style={{ fontSize: 10.5, color: "var(--ink-4)" }}
                  >
                    {fmt(task.totalUsage)}
                  </span>
                </div>

                <div
                  className="line-clamp-2"
                  style={{
                    marginTop: 6,
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: selected ? "var(--ink)" : "var(--ink-2)",
                  }}
                >
                  {task.goal}
                </div>

                <div
                  className={[
                    "flex items-center justify-between",
                    selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
                    "transition-opacity duration-[120ms]",
                  ].join(" ")}
                  style={{ marginTop: 6, fontSize: 10.5, color: "var(--ink-4)" }}
                >
                  <span className="num">{clock(task.createdAt)}</span>
                  <span className="num">{task.agents.length} 代理</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

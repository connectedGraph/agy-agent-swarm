"use client";

import { Dot, Icon, Meter } from "@/components/ui/kit";
import type { AgentRun } from "@/lib/types";
import { STATE_LABEL, STATE_TONE, dur, fmt, isLive, preview, usageTotal } from "./shared";

export function AgentCard({
  agent,
  selected,
  onClick,
}: {
  agent: AgentRun;
  selected: boolean;
  onClick: () => void;
}) {
  const total = usageTotal(agent);
  const input = agent.usage?.inputTokens || 0;
  const cached = agent.usage?.cachedReadTokens || 0;
  const out = (agent.usage?.outputTokens || 0) + (agent.usage?.thoughtTokens || 0);
  const sum = Math.max(input + cached + out, 1);
  const elapsed = agent.startedAt ? (agent.endedAt || Date.now()) - agent.startedAt : 0;
  const state = agent.state;
  const tone = STATE_TONE[state] || "neutral";
  const live = isLive(state);

  const border =
    state === "failed"
      ? "var(--bad)"
      : selected
        ? "color-mix(in srgb, var(--accent) 45%, transparent)"
        : live
          ? "var(--accent-line)"
          : "var(--line)";

  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className="text-left flex flex-col group"
      style={{
        background: selected ? "var(--surface)" : "var(--surface)",
        border: `1px solid ${border}`,
        borderRadius: "var(--r-xl)",
        padding: 16,
        minHeight: 212,
        boxShadow: selected ? "var(--shadow-2)" : "var(--shadow-1)",
        transition:
          "transform var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow = "var(--shadow-2)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "";
        e.currentTarget.style.boxShadow = selected ? "var(--shadow-2)" : "var(--shadow-1)";
      }}
    >
      <div className="flex items-center gap-2">
        <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
          {String(agent.index + 1).padStart(2, "0")}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.01em" }}>{agent.name}</span>
        <span className="ml-auto flex items-center gap-1.5" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          <Dot tone={tone} live={live} />
          {STATE_LABEL[state] || state}
        </span>
      </div>

      <div
        className="line-clamp-2"
        style={{ fontSize: 12, lineHeight: 1.55, color: "var(--ink-2)", marginTop: 8, minHeight: 37 }}
      >
        {agent.task || <span style={{ color: "var(--ink-4)" }}>等待包工头分配</span>}
      </div>

      <div
        className="stream flex-1"
        style={{
          marginTop: 10,
          maxHeight: 44,
          overflow: "hidden",
          color: agent.text ? "var(--ink-2)" : "var(--ink-4)",
        }}
      >
        {agent.text ? preview(agent.text, 260, live) : live ? "连接中…" : ""}
      </div>

      <div style={{ marginTop: "auto", paddingTop: 12 }}>
        <div className="flex items-center justify-between" style={{ fontSize: 10.5 }}>
          <span style={{ color: "var(--ink-3)" }}>
            <span className="num" style={{ fontSize: 11.5, color: "var(--ink-2)", fontWeight: 500 }}>
              {fmt(total)}
            </span>{" "}
            tokens
          </span>
          <span className="mono" style={{ color: "var(--ink-4)" }}>
            {elapsed ? dur(elapsed) : ""}
          </span>
        </div>

        <div style={{ marginTop: 7 }}>
          <Meter
            height={3}
            segments={[
              { value: cached / sum, color: "var(--ink-4)", label: `缓存读取 ${fmt(cached)}` },
              { value: input / sum, color: "var(--ink-3)", label: `输入 ${fmt(input)}` },
              { value: out / sum, color: "var(--accent)", label: `输出 ${fmt(out)}` },
            ]}
          />
        </div>

        <div className="flex items-center justify-between" style={{ marginTop: 8, gap: 8 }}>
          <span className="flex items-center gap-1 min-w-0" style={{ color: "var(--ink-4)" }}>
            <Icon name="branch" size={11} />
            <span className="code truncate">{agent.branch || "—"}</span>
          </span>
          <span className="code flex-none">{agent.changedFiles.length ? `${agent.changedFiles.length} 个文件` : ""}</span>
        </div>
      </div>
    </button>
  );
}

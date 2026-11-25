"use client";

import type { Task } from "@/lib/types";
import { Dot, Tag } from "@/components/ui/kit";
import { AgentDetail } from "@/components/console/AgentDetail";
import { Ledger } from "@/components/console/Ledger";
import { GatewayCard } from "@/components/console/GatewayCard";
import { STATE_LABEL, STATE_TONE, fmt, isLive, preview, usageTotal } from "@/components/console/shared";

export function AgentRail({
  task,
  selectedId,
  onSelect,
  gw,
  onToggleRecord,
}: {
  task: Task;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  gw: any;
  onToggleRecord: () => void;
}) {
  const selected = task.agents.find((a) => a.id === selectedId) || null;

  return (
    <aside className="agent-rail">
      <div className="rail-head">
        <span style={{ fontSize: 13, fontWeight: 600 }}>执行代理</span>
        <Tag tone="neutral" mono>
          {task.agents.length}
        </Tag>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)" }}>
          {fmt(task.agents.reduce((n, a) => n + usageTotal(a), 0))} tokens
        </span>
      </div>

      <div className="rail-scroll">
        {selected && <AgentDetail agent={selected} onClose={() => onSelect(null)} />}

        {task.agents.map((a) => {
          const tone = STATE_TONE[a.state] || "neutral";
          return (
            <button
              key={a.id}
              className="rail-agent"
              data-active={a.id === selectedId}
              onClick={() => onSelect(a.id === selectedId ? null : a.id)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 550 }}>{a.name}</span>
                <span
                  style={{
                    marginLeft: "auto",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    color: "var(--ink-3)",
                  }}
                >
                  <Dot tone={tone} live={isLive(a.state)} />
                  {STATE_LABEL[a.state] || a.state}
                </span>
              </div>
              <div className="rail-agent-line">
                {a.branch || "等待分配"}
                {a.changedFiles?.length ? ` · ${a.changedFiles.length} 个文件` : ""}
              </div>
              <div className="rail-agent-text">{preview(a.text, 90, isLive(a.state)) || a.error || "—"}</div>
              <div className="rail-agent-meta">{fmt(usageTotal(a))} tokens</div>
            </button>
          );
        })}

        {!task.agents.length && <div className="msg-muted" style={{ padding: "8px 4px" }}>还没有派出代理。</div>}

        <div style={{ marginTop: 6 }}>
          <Ledger task={task} />
        </div>
        <GatewayCard gw={gw} onToggle={onToggleRecord} />
      </div>
    </aside>
  );
}

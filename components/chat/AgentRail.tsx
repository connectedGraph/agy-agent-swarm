"use client";

import { memo, useCallback } from "react";
import type { AgentRun, Task } from "@/lib/types";
import { Dot, Icon, IconBtn, Tag } from "@/components/ui/kit";
import { AgentDetail } from "@/components/console/AgentDetail";
import { Ledger } from "@/components/console/Ledger";
import { GatewayCard } from "@/components/console/GatewayCard";
import { STATE_LABEL, STATE_TONE, fmt, isLive, preview, usageTotal } from "@/components/console/shared";

// AgentDetail 内部要重新解析 Markdown，任务推流时不该跟着重渲染
const MemoAgentDetail = memo(AgentDetail);

// 单个代理卡：只有它自己的 agent 对象或选中态变化时才重渲染
const AgentCard = memo(function AgentCard({
  agent,
  active,
  onSelect,
}: {
  agent: AgentRun;
  active: boolean;
  onSelect: (id: string | null) => void;
}) {
  const tone = STATE_TONE[agent.state] || "neutral";
  const stateLabel = STATE_LABEL[agent.state] || agent.state;
  const files = agent.changedFiles?.length || 0;

  return (
    <button
      className="rail-agent"
      data-active={active}
      aria-pressed={active}
      aria-label={`${agent.name}：${stateLabel}${agent.branch ? `，分支 ${agent.branch}` : ""}`}
      title={`${agent.name} · ${stateLabel}${agent.branch ? ` · ${agent.branch}` : ""}`}
      onClick={() => onSelect(active ? null : agent.id)}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 550 }}>{agent.name}</span>
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
          <Dot tone={tone} live={isLive(agent.state)} />
          {stateLabel}
        </span>
      </div>
      <div className="rail-agent-line">
        {agent.branch || "等待分配"}
        {files ? ` · ${files} 个文件` : ""}
      </div>
      <div className="rail-agent-text">{preview(agent.text, 90, isLive(agent.state)) || agent.error || "—"}</div>
      <div className="rail-agent-meta">{fmt(usageTotal(agent))} tokens</div>
    </button>
  );
});

export function AgentRail({
  task,
  selectedId,
  onSelect,
  gw,
  onToggleRecord,
  open = true,
  onClose,
}: {
  task: Task;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  gw: any;
  onToggleRecord: () => void;
  // 窄屏抽屉：默认收起，展开时由外层加遮罩并管理焦点
  open?: boolean;
  onClose?: () => void;
}) {
  const selected = task.agents.find((a) => a.id === selectedId) || null;
  const closeDetail = useCallback(() => onSelect(null), [onSelect]);

  return (
    <aside
      className="agent-rail"
      id="agent-rail"
      data-open={open}
      inert={!open}
      aria-hidden={!open ? true : undefined}
      aria-label="执行代理"
      tabIndex={-1}
    >
      <div className="rail-head">
        <span style={{ fontSize: 13, fontWeight: 600 }}>执行代理</span>
        <Tag tone="neutral" mono>
          {task.agents.length}
        </Tag>
        <span
          style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)" }}
          title="含编排器、验证器与返工的总用量；单个代理的用量见下方列表"
        >
          全部 {fmt(task.totalUsage)} tokens
        </span>
        {onClose && (
          <IconBtn
            className="rail-close"
            label="关闭执行代理栏"
            icon={<Icon name="close" size={15} />}
            onClick={onClose}
          />
        )}
      </div>

      <div className="rail-scroll">
        {selected && <MemoAgentDetail agent={selected} onClose={closeDetail} />}

        {task.agents.map((a) => (
          <AgentCard key={a.id} agent={a} active={a.id === selectedId} onSelect={onSelect} />
        ))}

        {!task.agents.length && (
          <div className="msg-muted" style={{ padding: "8px 4px" }}>
            还没有派出代理。
          </div>
        )}

        <div style={{ marginTop: 6 }}>
          <Ledger task={task} />
        </div>
        <GatewayCard gw={gw} onToggle={onToggleRecord} />
      </div>
    </aside>
  );
}

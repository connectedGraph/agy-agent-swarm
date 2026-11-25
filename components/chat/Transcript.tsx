"use client";

import type { Task } from "@/lib/types";
import { Dot, Spinner, Tag } from "@/components/ui/kit";
import { RichText } from "@/components/console/RichText";
import { VerificationSection } from "@/components/console/VerificationSection";
import { ReworkSection } from "@/components/console/ReworkSection";
import { VerifierCard } from "@/components/console/VerifierCard";
import { STATE_LABEL, STATE_TONE, clock, fmt, isLive, preview, usageTotal } from "@/components/console/shared";

function Meta({ label, live = false }: { label: string; live?: boolean }) {
  return (
    <div className="msg-meta">
      <span>{label}</span>
      {live && <Spinner size={11} />}
    </div>
  );
}

export function Transcript({ task, onOpenAgent }: { task: Task; onOpenAgent: (id: string) => void }) {
  const usage = task.agents.reduce((n, a) => n + usageTotal(a), 0);
  const followups = (task.messages || []).filter((m) => m.kind !== "goal");
  const plan = task.boss.planList || [];
  const planning = task.state === "planning" || task.boss.state === "planning";

  return (
    <div className="transcript">
      <div className="msg-row">
        <div className="msg-user">{task.goal}</div>
        <div className="msg-time">{clock(task.createdAt)}</div>
      </div>

      <div className="msg-boss">
        <Meta
          label={`编排器 · ${planning ? "规划中" : plan.length ? `已拆成 ${plan.length} 个任务` : STATE_LABEL[task.state] || task.state}`}
          live={planning}
        />
        {plan.length > 0 ? (
          <>
            <div style={{ color: "var(--ink-2)" }}>
              契约已定，按依赖分批执行；每个代理在独立 worktree 与 bubblewrap 沙箱里工作。
            </div>
            <div className="plan-list">
              {plan.map((p, i) => (
                <div className="plan-row" key={i}>
                  <div className="plan-idx">{String(i + 1).padStart(2, "0")}</div>
                  <div className="plan-body">
                    <div className="plan-name">{p.name}</div>
                    <div className="plan-task">{preview(p.task, 160)}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : planning ? (
          <div className="msg-muted">
            {task.boss.text ? preview(task.boss.text, 240, true) : "正在生成任务契约…"}
          </div>
        ) : (
          <div className="msg-muted">没有拿到可用的任务拆分。</div>
        )}
      </div>

      {task.agents.length > 0 && (
        <div className="msg-boss">
          <Meta label="执行" />
          <button className="work-line" onClick={() => onOpenAgent(task.agents[0].id)}>
            <span>
              {task.agents.length} 个执行代理 · {fmt(usage)} tokens
            </span>
            <span className="work-link">查看执行详情</span>
          </button>
        </div>
      )}

      {task.verification && <VerificationSection task={task} />}
      {task.rework?.length > 0 && <ReworkSection task={task} />}
      {task.verifier && task.verifier.text && <VerifierCard task={task} />}

      {task.summary && (
        <div className="msg-boss">
          <Meta label="编排器 · 汇总" />
          <RichText text={task.summary} />
        </div>
      )}

      {task.error && !task.summary && (
        <div className="msg-boss">
          <Meta label="编排器 · 失败" />
          <div style={{ color: "var(--bad)" }}>{task.error}</div>
        </div>
      )}

      {followups.map((m) => (
        <div
          key={m.id}
          className="msg-row"
          style={m.role === "user" ? { alignItems: "flex-end" } : undefined}
        >
          {m.role === "user" ? (
            <div className="msg-user">{m.text}</div>
          ) : (
            <div className="msg-boss" style={{ width: "100%" }}>
              <Meta label="编排器" live={!m.text} />
              {m.text ? (
                <RichText text={m.text} />
              ) : (
                <div className="msg-muted">
                  <Spinner size={12} /> 正在回复…
                </div>
              )}
              {m.error && <Tag tone="bad">会话失败</Tag>}
            </div>
          )}
          <div className="msg-time">{clock(m.at)}</div>
        </div>
      ))}

      {isLive(task.state) && task.state !== "planning" && (
        <div className="msg-boss">
          <Meta label={`${STATE_LABEL[task.state] || task.state}…`} live />
          <div className="msg-muted">
            <Dot tone={STATE_TONE[task.state]} live />
            <span style={{ marginLeft: 8 }}>
              {task.state === "running"
                ? "执行代理正在各自的工作区里跑。"
                : task.state === "merging"
                  ? "正在把各分支合进 integration。"
                  : task.state === "verifying"
                    ? "正在执行检查命令并派独立验证器复核。"
                    : task.state === "rework"
                      ? "检查未过，正在按层返工。"
                      : "正在汇总。"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { memo, useMemo, useState } from "react";
import type { Chat, Task } from "@/lib/types";
import { Btn, Dot, Icon, Spinner, Tag } from "@/components/ui/kit";
import { RichText } from "@/components/console/RichText";
import { VerificationSection } from "@/components/console/VerificationSection";
import { ReworkSection } from "@/components/console/ReworkSection";
import { VerifierCard } from "@/components/console/VerifierCard";
import {
  STATE_LABEL,
  STATE_TONE,
  displayState,
  fmt,
  fullTime,
  isLive,
  preview,
  relTime,
  sysText,
  usageTotal,
} from "@/components/console/shared";
import { Confirm } from "./Confirm";
import { TaskDiff } from "./TaskDiff";

function Meta({ label, live = false }: { label: string; live?: boolean }) {
  return (
    <div className="msg-meta">
      <span>{label}</span>
      {live && <Spinner size={11} />}
    </div>
  );
}

// 历史执行切换：默认只看最近一次，展开后可选旧任务只读查看
// memo：SSE 每次推 chat 都会重渲染父级，历史列表本身只在任务集合变化时才需要更新
const HistoryBar = memo(function HistoryBar({
  tasks,
  activeId,
  now,
  onSelect,
}: {
  tasks: Task[];
  activeId: string;
  now: number;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const latestId = tasks[tasks.length - 1]?.id;

  return (
    <div className="history-bar">
      <button
        className="history-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`查看历史执行，共 ${tasks.length} 次`}
        title="查看这次会话的历史执行"
      >
        <Icon name="branch" size={13} />
        <span>历史执行 {tasks.length} 次</span>
        <Icon name="chevron" size={12} className="diff-chevron" />
      </button>
      {open && (
        <div className="history-list">
          {tasks
            .map((t, i) => ({ t, i }))
            .reverse()
            .map(({ t, i }) => {
              const ds = displayState(t);
              const active = activeId === t.id;
              return (
                <button
                  key={t.id}
                  className="history-item"
                  data-active={active}
                  onClick={() => onSelect(t.id === latestId ? null : t.id)}
                  aria-label={`查看第 ${i + 1} 次执行：${ds.label}`}
                  title={`${ds.label} · ${fullTime(t.createdAt)}`}
                >
                  <span className="code flex-none">#{i + 1}</span>
                  <Dot tone={ds.tone} live={ds.live} />
                  <span className="truncate" style={{ minWidth: 0 }}>
                    {ds.label}
                    {t.id === latestId ? "（最近一次）" : ""}
                  </span>
                  <span className="code ml-auto flex-none" title={fullTime(t.createdAt)}>
                    {relTime(t.createdAt, now)}
                  </span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
});

// 计划行：计划列表在一次执行里基本不变，单独 memo 避免任务状态更新时重渲染
const PlanRow = memo(function PlanRow({
  index,
  name,
  task,
}: {
  index: number;
  name: string;
  task: string;
}) {
  return (
    <div className="plan-row">
      <div className="plan-idx">{String(index + 1).padStart(2, "0")}</div>
      <div className="plan-body">
        <div className="plan-name">{name}</div>
        <div className="plan-task">{preview(task, 160)}</div>
      </div>
    </div>
  );
});

const TaskBlocks = memo(function TaskBlocks({
  task,
  now,
  isHistory,
  onOpenAgent,
  onDeleteTask,
}: {
  task: Task;
  now: number;
  isHistory: boolean;
  onOpenAgent: (id: string) => void;
  onDeleteTask: (id: string) => Promise<string | null>;
}) {
  const usage = task.agents.reduce((n, a) => n + usageTotal(a), 0);
  const plan = task.boss.planList || [];
  const planning = task.state === "planning" || task.boss.state === "planning";
  const ds = displayState(task);

  const [delOpen, setDelOpen] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");

  async function doDelete() {
    if (delBusy) return;
    setDelBusy(true);
    setDelErr("");
    const err = await onDeleteTask(task.id);
    setDelBusy(false);
    if (err) setDelErr(err);
    else setDelOpen(false);
  }

  return (
    <>
      <div className="task-head">
        <Dot tone={ds.tone} live={ds.live} />
        <span className="task-head-state">{ds.label}</span>
        {isHistory && <Tag tone="neutral">历史执行</Tag>}
        <span className="task-head-time code" title={fullTime(task.createdAt)}>
          {relTime(task.createdAt, now)}
        </span>
        <Btn
          className="task-head-del"
          variant="danger-ghost"
          size="sm"
          icon={<Icon name="trash" size={12} />}
          disabled={isLive(task.state)}
          onClick={() => {
            setDelErr("");
            setDelOpen(true);
          }}
          aria-label="删除这次执行"
          title={isLive(task.state) ? "执行中不能删除，请先停止" : "删除这次执行"}
        >
          删除本次执行
        </Btn>
      </div>

      <div className="msg-boss">
        <Meta
          label={`编排器 · ${planning ? "规划中" : plan.length ? `已拆成 ${plan.length} 个任务` : ds.label}`}
          live={planning}
        />
        {plan.length > 0 ? (
          <>
            <div style={{ color: "var(--ink-2)" }}>
              契约已定，按依赖分批执行；每个代理在独立 worktree 与 bubblewrap 沙箱里工作。
            </div>
            <div className="plan-list">
              {plan.map((p, i) => (
                <PlanRow key={i} index={i} name={p.name} task={p.task} />
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
          <TaskDiff taskId={task.id} />
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

      {/* summary 与 error 同时存在时也照样显示错误，不能把失败藏起来 */}
      {task.error && (
        <div className="msg-boss">
          <Meta label={task.summary ? "编排器 · 错误" : "编排器 · 失败"} />
          <div style={{ color: "var(--bad)", whiteSpace: "pre-wrap" }}>{sysText(task.error)}</div>
        </div>
      )}

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

      {delOpen && (
        <Confirm
          title="删除这次执行"
          tone="danger"
          confirmLabel="删除"
          busy={delBusy}
          error={delErr}
          onConfirm={() => void doDelete()}
          onClose={() => setDelOpen(false)}
          message={
            <>
              确定删除任务 <span className="code">{task.id.slice(0, 8)}</span>？任务记录、worktree 与运行目录会被清理，此操作不可撤销。
            </>
          }
        />
      )}
    </>
  );
});

// 单条消息：SSE 推流时 ChatApp 会把未变化的消息对象复用（见 reconcileChat），
// 所以这里 memo 后只有真正追加/变化的那一条会重新渲染与解析 Markdown。
const Message = memo(function Message({
  m,
  now,
}: {
  m: Chat["messages"][number];
  now: number;
}) {
  // 系统事件（开始/取消/失败）居中低对比显示，错误用 --bad
  if (m.role === "system") {
    return (
      <div className="msg-system" data-error={m.kind === "error" ? "true" : undefined}>
        <span className="msg-system-text">{sysText(m.text)}</span>
        <span className="msg-system-time" title={fullTime(m.at)}>
          {relTime(m.at, now)}
        </span>
      </div>
    );
  }

  return (
    <div className="msg-row" style={m.role === "user" ? { alignItems: "flex-end" } : undefined}>
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
      <div className="msg-time" title={fullTime(m.at)}>
        {relTime(m.at, now)}
      </div>
    </div>
  );
});

export function Transcript({
  chat,
  task,
  now,
  latestTaskId,
  viewTaskId,
  historyTasks,
  onSelectHistory,
  onOpenAgent,
  onDeleteTask,
}: {
  chat: Chat;
  task: Task | null;
  now: number;
  latestTaskId: string | null;
  viewTaskId: string | null;
  historyTasks: Task[];
  onSelectHistory: (id: string | null) => void;
  onOpenAgent: (id: string) => void;
  onDeleteTask: (id: string) => Promise<string | null>;
}) {
  // 执行开始后的追问排在任务块之后，保持时间顺序；
  // 查看历史任务时只显示到下一次执行开始前，避免把后来的任务内容混进来
  const { before, after, isHistory } = useMemo(() => {
    const cut = task ? task.createdAt : Number.POSITIVE_INFINITY;
    const idx = task ? historyTasks.findIndex((t) => t.id === task.id) : -1;
    const nextAt =
      idx >= 0 && idx < historyTasks.length - 1
        ? historyTasks[idx + 1].createdAt
        : Number.POSITIVE_INFINITY;
    return {
      before: chat.messages.filter((m) => m.at <= cut),
      after: chat.messages.filter((m) => m.at > cut && m.at < nextAt),
      isHistory: !!task && !!latestTaskId && task.id !== latestTaskId,
    };
  }, [chat.messages, task, historyTasks, latestTaskId]);

  return (
    <div className="transcript">
      {before.map((m) => (
        <Message key={m.id} m={m} now={now} />
      ))}
      {historyTasks.length > 1 && (
        <HistoryBar
          tasks={historyTasks}
          activeId={viewTaskId || latestTaskId || ""}
          now={now}
          onSelect={onSelectHistory}
        />
      )}
      {task && (
        <TaskBlocks
          key={task.id}
          task={task}
          now={now}
          isHistory={isHistory}
          onOpenAgent={onOpenAgent}
          onDeleteTask={onDeleteTask}
        />
      )}
      {after.map((m) => (
        <Message key={m.id} m={m} now={now} />
      ))}
    </div>
  );
}

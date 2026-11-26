"use client";

import { useState } from "react";
import { Btn, Spinner } from "@/components/ui/kit";
import { Modal } from "./Confirm";

// 执行前确认：目标可编辑，代理数与仓库路径都可改，确认后才真正 POST run
export function RunDialog({
  chatTitle,
  repoPath,
  agents,
  lastUserText,
  taskCount,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  chatTitle: string;
  repoPath: string;
  agents: number;
  lastUserText: string;
  taskCount: number;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (goal: string, agents: number, repoPath: string) => void;
}) {
  const [goal, setGoal] = useState(lastUserText);
  const [count, setCount] = useState(agents);
  const [repo, setRepo] = useState(repoPath);
  const [local, setLocal] = useState("");

  const trimmed = goal.trim();
  const changed = trimmed !== lastUserText.trim();

  function submit() {
    if (busy) return;
    if (!trimmed) {
      setLocal("执行目标不能为空");
      return;
    }
    setLocal("");
    onSubmit(trimmed, count, repo.trim());
  }

  return (
    <Modal
      title="确认执行"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Btn size="sm" variant="ghost" onClick={onClose} disabled={busy} aria-label="取消执行" title="取消执行">
            取消
          </Btn>
          <Btn
            size="sm"
            variant="primary"
            onClick={submit}
            disabled={busy || !trimmed}
            icon={busy ? <Spinner size={12} /> : undefined}
            aria-label="确认执行"
            title="确认执行"
          >
            确认执行
          </Btn>
        </>
      }
    >
      <div className="modal-field">
        <label className="modal-label" htmlFor="run-goal">
          执行目标
        </label>
        <textarea
          id="run-goal"
          className="modal-textarea"
          rows={5}
          maxLength={4000}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="描述这次要交给执行代理完成的目标"
          spellCheck={false}
        />
        <div className="modal-hint">
          已预填最后一条用户消息{changed ? "；修改后会作为一条新消息记入会话" : ""}
        </div>
      </div>

      <div className="modal-grid">
        <div className="modal-field">
          <label className="modal-label" htmlFor="run-agents">
            执行代理数量
          </label>
          <select
            id="run-agents"
            className="modal-input"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            aria-label="执行代理数量"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n} 个代理
              </option>
            ))}
          </select>
        </div>
        <div className="modal-field">
          <label className="modal-label" htmlFor="run-repo">
            目标仓库
          </label>
          <input
            id="run-repo"
            className="modal-input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="留空则使用默认工作区"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="run-summary">
        <div className="run-summary-row">
          <span>会话</span>
          <span className="truncate">{chatTitle}</span>
        </div>
        <div className="run-summary-row">
          <span>仓库</span>
          <span className="truncate">{repo.trim() || "默认工作区（执行时新建临时仓库）"}</span>
        </div>
        <div className="run-summary-row">
          <span>本次规模</span>
          <span>
            {count} 个执行代理{taskCount > 0 ? ` · 该会话已执行 ${taskCount} 次` : ""}
          </span>
        </div>
        <div className="run-summary-note">
          执行代理会在各自的 worktree 与 bubblewrap 沙箱里工作，合并后再统一检查与裁决。
          执行会消耗 token，确认后可在任务卡片上停止。
        </div>
      </div>

      {(local || error) && (
        <div className="modal-error" role="alert">
          {local || error}
        </div>
      )}
    </Modal>
  );
}

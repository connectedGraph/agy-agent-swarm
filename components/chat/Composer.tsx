"use client";

import { useEffect, useRef } from "react";
import { Icon, Spinner } from "@/components/ui/kit";

export function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  disabled,
  placeholder,
  isNew,
  agents,
  setAgents,
  repoPath,
  setRepoPath,
  hint,
  canRun = false,
  runBusy = false,
  onRun,
  running = false,
  onStop,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder: string;
  isNew: boolean;
  agents: number;
  setAgents: (n: number) => void;
  repoPath: string;
  setRepoPath: (v: string) => void;
  hint?: string;
  canRun?: boolean;
  runBusy?: boolean;
  onRun?: () => void;
  running?: boolean;
  onStop?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [value]);

  const send = () => {
    if (!value.trim() || busy || disabled) return;
    onSubmit();
  };

  return (
    <div className="compose-wrap">
      <div className="compose-box">
        {isNew && (
          <input
            className="compose-repo"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="目标仓库路径（可选，留空则新建临时仓库）"
            aria-label="目标仓库路径"
            title="目标仓库路径（可选）"
            spellCheck={false}
          />
        )}
        <textarea
          ref={ref}
          className="compose-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="compose-foot">
          <span className="compose-hint">
            {hint || (isNew ? "契约与检查命令由编排器生成" : "Shift + Enter 换行")}
          </span>
          {canRun && (
            <button
              className="compose-run"
              onClick={onRun}
              disabled={runBusy || busy}
              aria-label="开始执行（会先确认目标与代理数量）"
              title="开始执行"
            >
              {runBusy ? <Spinner size={13} /> : null}
              开始执行
            </button>
          )}
          {running && onStop && (
            <button
              className="compose-stop"
              onClick={onStop}
              aria-label="停止执行"
              title="停止执行"
            >
              <Icon name="stop" size={12} />
              停止
            </button>
          )}
          {(isNew || canRun) && (
            <select
              className="compose-select"
              value={agents}
              onChange={(e) => setAgents(Number(e.target.value))}
              title="执行代理数量"
              aria-label="执行代理数量"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>
                  {n} 代理
                </option>
              ))}
            </select>
          )}
          <button
            className="compose-send"
            onClick={send}
            disabled={busy || disabled || !value.trim()}
            aria-label="发送消息"
            title="发送消息"
          >
            {busy ? <Spinner size={15} /> : <Icon name="send" size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}

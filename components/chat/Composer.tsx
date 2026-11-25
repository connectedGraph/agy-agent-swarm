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
          {isNew && (
            <select
              className="compose-select"
              value={agents}
              onChange={(e) => setAgents(Number(e.target.value))}
              title="执行代理数量"
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
            aria-label={isNew ? "提交任务" : "发送"}
            title={isNew ? "提交任务" : "发送"}
          >
            {busy ? <Spinner size={15} /> : <Icon name={isNew ? "chevron" : "check"} size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}

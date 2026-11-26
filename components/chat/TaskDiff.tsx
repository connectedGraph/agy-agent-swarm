"use client";

import { memo, useEffect, useState } from "react";
import { Icon, Spinner } from "@/components/ui/kit";

type DiffAgent = {
  id: string;
  name: string;
  branch: string;
  worktree: string;
  files: string[];
  stat: string;
  untracked: { count: number; files: string[] };
};

// 改动展开：只拉只读快照（stat + 文件清单 + untracked），不做逐行 diff
// memo：只依赖 taskId，任务状态推流不应把已展开的快照重新渲染一遍
export const TaskDiff = memo(function TaskDiff({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [agents, setAgents] = useState<DiffAgent[]>([]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/tasks/${taskId}/diff`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || "读取改动失败");
        return;
      }
      setAgents(Array.isArray(j.agents) ? j.agents : []);
      setLoaded(true);
    } catch (e: any) {
      setError(e?.message || "读取改动失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && !loaded && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const totalFiles = agents.reduce((n, a) => n + a.files.length, 0);

  return (
    <div className="diff-block">
      <button
        className="diff-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="展开改动文件"
        title="查看各执行代理的改动文件"
      >
        <Icon name="branch" size={13} />
        <span>改动</span>
        {loaded && totalFiles > 0 && <span className="code">{totalFiles} 个文件</span>}
        <Icon name="chevron" size={12} className="diff-chevron" />
      </button>

      {open && (
        <div className="diff-panel">
          {loading && (
            <div className="diff-loading">
              <Spinner size={12} /> 正在读取改动…
            </div>
          )}
          {!loading && error && (
            <div className="diff-error">
              <span>{error}</span>
              <button
                className="diff-retry"
                onClick={() => void load()}
                aria-label="重新读取改动"
                title="重新读取改动"
              >
                重试
              </button>
            </div>
          )}
          {!loading && !error && loaded && agents.length === 0 && (
            <div className="diff-empty">这次执行没有派出执行代理。</div>
          )}
          {!loading &&
            !error &&
            agents.map((a) => (
              <div className="diff-agent" key={a.id}>
                <div className="diff-agent-head">
                  <span className="diff-agent-name">{a.name}</span>
                  {a.branch && <span className="code truncate">{a.branch}</span>}
                  <span className="diff-agent-count">
                    {a.files.length} 个文件
                    {a.untracked.count > 0 ? ` · ${a.untracked.count} 个未跟踪` : ""}
                  </span>
                </div>
                {a.worktree && (
                  <div className="diff-worktree">
                    <span className="diff-worktree-label">worktree</span>
                    <code className="path-code">{a.worktree}</code>
                  </div>
                )}
                {a.stat.trim() && <pre className="diff-stat mono">{a.stat.trim()}</pre>}
                {a.files.length > 0 && (
                  <div className="diff-files">
                    {a.files.map((f) => (
                      <code className="path-code diff-file" key={f} title={f}>
                        {f}
                      </code>
                    ))}
                  </div>
                )}
                {a.untracked.files.length > 0 && (
                  <div className="diff-untracked">
                    未跟踪：
                    {a.untracked.files.map((f) => (
                      <code className="path-code" key={f} title={f}>
                        {f}
                      </code>
                    ))}
                  </div>
                )}
                {!a.stat.trim() && a.files.length === 0 && (
                  <div className="diff-empty">没有检测到改动（worktree 可能已被回收）。</div>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
});

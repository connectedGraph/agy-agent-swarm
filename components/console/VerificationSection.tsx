"use client";

import { useState, type CSSProperties } from "react";
import { Btn, Card, Disclosure, Divider, Dot, Spinner, Tag } from "@/components/ui/kit";
import type { MergeResult, Task } from "@/lib/types";

const LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: "var(--ink-3)",
  letterSpacing: "0.04em",
};

const MERGE_STATUS: Record<
  MergeResult["status"],
  { tone: "ok" | "bad" | "neutral"; label: string; color: string }
> = {
  merged: { tone: "ok", label: "已合入", color: "var(--ok)" },
  conflict: { tone: "bad", label: "冲突", color: "var(--bad)" },
  skipped: { tone: "neutral", label: "跳过", color: "var(--ink-3)" },
};

export function VerificationSection({ task }: { task: Task }) {
  const v = task.verification;
  const verdict = task.verdict;
  const promote = task.promote;
  const [busy, setBusy] = useState(false);

  async function doPromote(force = false) {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/api/tasks/${task.id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!v && !verdict && !task.merge.length) return null;

  return (
    <Card style={{ padding: 18 }}>
      <div className="flex items-center gap-2 min-w-0">
        <div className="subtitle flex-none">合并与验收</div>
        {verdict && <Tag tone={verdict.pass ? "ok" : "bad"}>{verdict.pass ? "通过" : "未通过"}</Tag>}
        <div className="ml-auto min-w-0 flex justify-end">
          {v ? (
            <span className="code truncate" style={{ maxWidth: 320 }}>
              {v.integrationBranch}
            </span>
          ) : task.state === "merging" ? (
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>合并中…</span>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-5 min-[900px]:grid-cols-2" style={{ marginTop: 16 }}>
        {/* 分支合并 */}
        <div>
          <div style={LABEL}>分支合并</div>
          <div className="flex flex-col" style={{ marginTop: 8, gap: 6 }}>
            {task.merge.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--ink-4)", height: 30, display: "flex", alignItems: "center" }}>
                等待合并
              </div>
            )}
            {task.merge.map((m, i) => {
              const s = MERGE_STATUS[m.status];
              return (
                <div key={i} className="flex items-center gap-2" style={{ height: 30, minWidth: 0 }}>
                  <Dot tone={s.tone} />
                  <span className="code truncate flex-none" style={{ maxWidth: 150 }}>
                    {m.branch || "—"}
                  </span>
                  <span className="truncate" style={{ fontSize: 12, color: "var(--ink-2)", minWidth: 0 }}>
                    {m.name}
                  </span>
                  <span className="ml-auto flex-none" style={{ fontSize: 11, color: s.color }}>
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>

          {v?.diffStat && (
            <Disclosure
              className="rounded-[8px] px-1.5 py-1 transition-colors duration-[120ms] hover:bg-[var(--hover)]"
              summary={
                <span style={{ ...LABEL, fontWeight: 400 }}>合并后差异</span>
              }
            >
              <pre
                className="stream mono"
                style={{ marginTop: 8, maxHeight: 180, overflow: "auto" }}
              >
                {v.diffStat}
              </pre>
            </Disclosure>
          )}
        </div>

        {/* 真实验收 */}
        <div>
          <div style={LABEL}>真实验收</div>
          <div className="flex flex-col" style={{ marginTop: 8, gap: 6 }}>
            {!v && (
              <div style={{ fontSize: 11, color: "var(--ink-4)", height: 30, display: "flex", alignItems: "center" }}>
                等待验收
              </div>
            )}
            {v && v.checks.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--ink-4)", height: 30, display: "flex", alignItems: "center" }}>
                没有可识别的自动检查
              </div>
            )}
            {(v?.checks || []).map((c, i) => (
              <Disclosure
                key={i}
                defaultOpen={!c.ok}
                className="rounded-[8px] px-1.5 py-1 transition-colors duration-[120ms] hover:bg-[var(--hover)]"
                summary={
                  <>
                    <span
                      className="flex-none"
                      style={{ fontSize: 11, fontWeight: 600, color: c.ok ? "var(--ok)" : "var(--bad)" }}
                    >
                      {c.ok ? "PASS" : "FAIL"}
                    </span>
                    <span className="truncate flex-1" style={{ fontSize: 12, color: "var(--ink-2)", minWidth: 0 }}>
                      {c.name}
                    </span>
                    <span className="code flex-none" style={{ color: "var(--ink-4)" }}>
                      exit <span className="num">{c.exitCode}</span> · <span className="num">{c.ms}</span>ms
                    </span>
                  </>
                }
              >
                <pre className="stream mono" style={{ marginTop: 8, maxHeight: 180, overflow: "auto" }}>
                  {c.output || "(无输出)"}
                </pre>
              </Disclosure>
            ))}
          </div>
        </div>
      </div>

      {verdict && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: "var(--r-lg)",
            background: "var(--surface-2)",
          }}
        >
          <div style={LABEL}>判定理由</div>
          <div className="flex flex-col" style={{ marginTop: 6, gap: 2 }}>
            {(verdict.reasons.length ? verdict.reasons : ["无理由"]).map((r, i) => (
              <div key={i} className="flex" style={{ gap: 8 }}>
                <span
                  className="flex-none"
                  style={{
                    width: 3,
                    height: 3,
                    borderRadius: 999,
                    background: "var(--ink-4)",
                    marginTop: 8,
                  }}
                />
                <span style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--ink)" }}>{r}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Divider className="mt-4" />

      <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 12 }}>
        <span style={{ ...LABEL, flex: "none" }}>主干</span>
        {promote?.ok ? (
          <Tag tone="ok">
            已合入 {promote.target}
            {promote.commit && (
              <span className="code" style={{ color: "inherit" }}>
                @{promote.commit}
              </span>
            )}
          </Tag>
        ) : (
          <>
            <Btn
              size="sm"
              disabled={busy || !verdict?.pass}
              icon={busy ? <Spinner size={12} /> : undefined}
              onClick={() => doPromote(false)}
            >
              合入 {promote?.target || "main"}
            </Btn>
            {verdict && !verdict.pass && (
              <Btn
                variant="danger-ghost"
                size="sm"
                disabled={busy}
                onClick={() => doPromote(true)}
              >
                强制合入
              </Btn>
            )}
            <span className="ml-auto" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {verdict
                ? verdict.pass
                  ? "验收通过，可合回主干"
                  : "验收未通过，只能强制合入"
                : "等待判定"}
            </span>
          </>
        )}
      </div>

      {promote && !promote.ok && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--bad)" }}>{promote.detail}</div>
      )}
    </Card>
  );
}

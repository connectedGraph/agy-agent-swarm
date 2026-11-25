"use client";

import { useState, type CSSProperties } from "react";
import { Btn, Card, Disclosure, Divider, Dot, Spinner, Tag } from "@/components/ui/kit";
import type { MergeResult, Task } from "@/lib/types";
import { sysText } from "./shared";

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

/* 从检查输出里挑出最能说明问题的一行；挑不到就取第一行非空内容 */
function firstProblem(output: string) {
  const lines = (output || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const hit =
    lines.find((l) => /error|exception|traceback|fail|expected|no such file|not found|missing|denied/i.test(l)) ||
    lines[0];
  return hit.length > 180 ? hit.slice(0, 180) + "…" : hit;
}

type DiffRow = { path: string; total: number; plusChars: number; minusChars: number };

function parseDiff(text: string) {
  const rows: DiffRow[] = [];
  let summary = "";
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    if (/files? changed/.test(line)) {
      summary = line.trim();
      const im = /(\d+) insertions?/.exec(line);
      const dm = /(\d+) deletions?/.exec(line);
      insertions = im ? Number(im[1]) : 0;
      deletions = dm ? Number(dm[1]) : 0;
      continue;
    }
    const m = /^\s*(.+?)\s*\|\s*(.*)$/.exec(line);
    if (!m) continue;
    const path = m[1].trim();
    const rest = m[2].trim();
    const num = /^(\d+)\s*(.*)$/.exec(rest);
    if (!num) {
      // 二进制文件（Bin 0 -> 123 bytes）或无法解析的统计
      rows.push({ path, total: 0, plusChars: 0, minusChars: 0 });
      continue;
    }
    const bar = num[2].trim();
    rows.push({
      path,
      total: Number(num[1]),
      plusChars: (bar.match(/\+/g) || []).length,
      minusChars: (bar.match(/-/g) || []).length,
    });
  }
  return rows.length ? { rows, summary, insertions, deletions } : null;
}

function diffTone(rows: DiffRow[]) {
  const plusOnly = rows.every((r) => r.minusChars === 0);
  const minusOnly = rows.every((r) => r.plusChars === 0);
  const total = rows.reduce((n, r) => n + r.total, 0);
  return {
    label: plusOnly ? `+${total}` : minusOnly ? `−${total}` : `${total} 行`,
    color: plusOnly ? "var(--ok)" : minusOnly ? "var(--bad)" : "var(--ink-2)",
  };
}

function DiffStat({ text }: { text: string }) {
  const diff = parseDiff(text);
  if (!diff) {
    return (
      <pre className="stream mono" style={{ marginTop: 8, maxHeight: 180, overflow: "auto" }}>
        {text}
      </pre>
    );
  }
  const maxTotal = Math.max(...diff.rows.map((r) => r.total), 1);
  return (
    <div style={{ marginTop: 8 }}>
      {diff.rows.map((r) => {
        const allPlus = r.minusChars === 0;
        const allMinus = r.plusChars === 0;
        const label = allPlus ? `+${r.total}` : allMinus ? `−${r.total}` : `${r.total} 行`;
        const color = allPlus ? "var(--ok)" : allMinus ? "var(--bad)" : "var(--ink-2)";
        const ratio = r.plusChars + r.minusChars ? r.plusChars / (r.plusChars + r.minusChars) : 1;
        return (
          <div key={r.path} className="flex items-center" style={{ gap: 10, height: 26 }}>
            <span
              className="code truncate"
              title={r.path}
              style={{ flex: 1, minWidth: 0, color: "var(--ink-2)" }}
            >
              {r.path}
            </span>
            <span
              aria-hidden
              style={{
                display: "flex",
                width: 72,
                height: 4,
                borderRadius: 999,
                overflow: "hidden",
                background: "var(--surface-3)",
                flex: "none",
              }}
            >
              <i
                style={{
                  display: "flex",
                  width: `${(r.total / maxTotal) * 100}%`,
                  height: "100%",
                  minWidth: r.total ? 2 : 0,
                }}
              >
                <i style={{ width: `${ratio * 100}%`, background: "var(--ok)" }} />
                <i style={{ flex: 1, background: "var(--bad)" }} />
              </i>
            </span>
            <span
              className="num"
              style={{ width: 44, textAlign: "right", fontSize: 11, color, flex: "none" }}
            >
              {r.total ? label : "bin"}
            </span>
          </div>
        );
      })}
      {diff.summary && (
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--ink-3)" }}>
          {[diff.insertions ? `${diff.insertions} 行新增` : "", diff.deletions ? `${diff.deletions} 行删除` : ""]
            .filter(Boolean)
            .join(" · ") || diff.summary}
        </div>
      )}
    </div>
  );
}

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

  const checks = v?.checks || [];
  const failedChecks = checks.filter((c) => !c.ok);
  const diff = v?.diffStat ? parseDiff(v.diffStat) : null;
  const firstFail = failedChecks.length ? firstProblem(failedChecks[0].output) : "";

  return (
    <Card style={{ padding: 18 }}>
      <div className="flex items-center gap-2 min-w-0">
        <div className="subtitle flex-none">合并与验证</div>
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

      {failedChecks.length > 0 && (
        <div style={{ marginTop: 14, borderLeft: "2px solid var(--bad)", paddingLeft: 12 }}>
          <div className="flex flex-wrap items-baseline" style={{ gap: "2px 10px" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>
              {failedChecks.length} 项检查未通过
            </span>
            <span style={{ fontSize: 11.5, color: "var(--ink-2)" }}>
              {failedChecks.map((c) => sysText(c.name)).join(" · ")}
            </span>
          </div>
          {firstFail && (
            <div
              className="mono truncate"
              title={firstFail}
              style={{ marginTop: 3, fontSize: 10.5, color: "var(--bad)" }}
            >
              {firstFail}
            </div>
          )}
        </div>
      )}

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
                <div key={i} style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-2" style={{ height: 30, minWidth: 0 }}>
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
                  {m.status !== "merged" && m.detail && (
                    <div
                      style={{
                        paddingLeft: 14,
                        marginTop: -4,
                        marginBottom: 2,
                        fontSize: 11,
                        lineHeight: 1.6,
                        color: m.status === "conflict" ? "var(--bad)" : "var(--ink-3)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {m.detail}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {v?.diffStat && (
            <Disclosure
              className="rounded-[8px] px-1.5 py-1 transition-colors duration-[120ms] hover:bg-[var(--hover)]"
              summary={
                <span className="flex items-baseline" style={{ gap: 8 }}>
                  <span style={{ ...LABEL, fontWeight: 400 }}>合并后差异</span>
                  {diff && (
                    <span className="code flex-none">
                      {diff.rows.length} 个文件 ·{" "}
                      <span style={{ color: diffTone(diff.rows).color }}>{diffTone(diff.rows).label}</span>
                    </span>
                  )}
                </span>
              }
            >
              <DiffStat text={v.diffStat} />
            </Disclosure>
          )}
        </div>

        {/* 自动检查 */}
        <div>
          <div style={LABEL}>自动检查</div>
          <div className="flex flex-col" style={{ marginTop: 8, gap: 6 }}>
            {!v && (
              <div style={{ fontSize: 11, color: "var(--ink-4)", height: 30, display: "flex", alignItems: "center" }}>
                等待验证
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
                      {sysText(c.name)}
                    </span>
                    <span className="code flex-none" style={{ color: "var(--ink-4)" }}>
                      exit <span className="num">{c.exitCode}</span> · <span className="num">{c.ms}</span>ms
                    </span>
                  </>
                }
              >
                {c.command && (
                  <div
                    className="code"
                    style={{ marginTop: 8, overflowWrap: "anywhere", whiteSpace: "normal" }}
                  >
                    {c.command}
                  </div>
                )}
                <pre
                  className="stream mono"
                  style={{ marginTop: c.command ? 6 : 8, maxHeight: 180, overflow: "auto" }}
                >
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
          <div style={LABEL}>裁决理由</div>
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
                <span style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--ink)" }}>{sysText(r)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Divider className="mt-4" />

      <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 12 }}>
        <span style={{ ...LABEL, flex: "none" }}>主干分支</span>
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
              合入 {promote?.target || task.baseBranch || "main"}
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
                  ? "验证通过，可合回主干"
                  : "验证未通过，只能强制合入"
                : "等待判定"}
            </span>
          </>
        )}
      </div>

      {promote && !promote.ok && (
        <div
          style={{
            marginTop: 10,
            borderLeft: "2px solid var(--bad)",
            paddingLeft: 10,
            fontSize: 11.5,
            lineHeight: 1.6,
            color: "var(--bad)",
          }}
        >
          {sysText(promote.detail)}
        </div>
      )}
    </Card>
  );
}

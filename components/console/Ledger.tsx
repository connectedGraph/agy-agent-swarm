"use client";

import { Card, Meter } from "@/components/ui/kit";
import type { Task } from "@/lib/types";
import { fmt, usageTotal } from "./shared";

const WORKER_OPACITY = [0.9, 0.7, 0.5, 0.35, 0.25];

type Row = {
  key: string;
  label: string;
  color: string;
  opacity?: number;
  value: number;
};

export function Ledger({ task }: { task: Task | null }) {
  if (!task) {
    return (
      <Card style={{ padding: 18 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.01em" }}>账本</div>
        <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 10 }}>还没有任务</div>
      </Card>
    );
  }

  const bossPlan = task.boss.usage?.totalTokens || 0;
  const bossSum = task.boss.summaryUsage?.totalTokens || 0;
  const workers = task.agents.map((a) => ({ name: a.name, tokens: usageTotal(a) }));
  const verifierTokens = task.verifier?.usage?.totalTokens || 0;
  const fixerTokens = (task.rework || [])
    .filter((r) => r.target === "fixer")
    .reduce((n, r) => n + (r.usage?.totalTokens || 0), 0);

  const total =
    bossPlan + bossSum + workers.reduce((n, w) => n + w.tokens, 0) + verifierTokens + fixerTokens;
  const denom = Math.max(total, 1);

  const rows: Row[] = [
    { key: "plan", label: "包工头 · 规划", color: "var(--ink-3)", value: bossPlan },
    { key: "sum", label: "包工头 · 汇总", color: "var(--ink-4)", value: bossSum },
    ...workers.map((w, i) => ({
      key: `worker-${i}`,
      label: w.name,
      color: "var(--accent)",
      opacity: WORKER_OPACITY[i] ?? 0.25,
      value: w.tokens,
    })),
  ];
  if (verifierTokens > 0) {
    rows.push({ key: "verifier", label: "验证者", color: "var(--ink-2)", value: verifierTokens });
  }
  if (fixerTokens > 0) {
    rows.push({ key: "fixer", label: "返工修复", color: "var(--bad)", opacity: 0.8, value: fixerTokens });
  }

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.01em" }}>账本</div>

      <div className="flex items-baseline" style={{ gap: 6, marginTop: 10 }}>
        <span
          className="num"
          style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.02em", color: "var(--ink)" }}
        >
          {fmt(total)}
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-4)" }}>tokens</span>
      </div>

      <div style={{ marginTop: 14 }}>
        <Meter
          height={6}
          segments={rows.map((r) => ({
            value: r.value / denom,
            color: r.color,
            opacity: r.opacity,
            label: `${r.label} ${fmt(r.value)}`,
          }))}
        />
      </div>

      <div style={{ marginTop: 10 }}>
        {rows.map((r, i) => (
          <div
            key={r.key}
            className="flex items-center"
            style={{
              height: 28,
              gap: 8,
              borderBottom: i < rows.length - 1 ? "1px solid var(--line)" : "none",
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: r.color,
                opacity: r.opacity,
                flex: "none",
              }}
            />
            <span className="truncate" style={{ fontSize: 12, color: "var(--ink-2)", minWidth: 0 }}>
              {r.label}
            </span>
            <span
              className="num"
              style={{ fontSize: 12, color: "var(--ink)", marginLeft: "auto", flex: "none" }}
            >
              {fmt(r.value)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

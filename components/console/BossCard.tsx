"use client";

import { Card, Dot, Tag } from "@/components/ui/kit";
import type { BossRun, Task } from "@/lib/types";
import { STATE_LABEL, STATE_TONE, fmt, isLive, preview } from "./shared";

const BOSS_MODEL = "deepseek-v4.1-flash";
const MAX_PLAN_ROWS = 6;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function BossCard({ task }: { task: Task }) {
  const boss: BossRun = task.boss;
  const active = boss.state === "planning" || boss.state === "aggregating";
  const tone = STATE_TONE[boss.state] || "neutral";
  const live = isLive(boss.state);
  const tokens = (boss.usage?.totalTokens || 0) + (boss.summaryUsage?.totalTokens || 0);

  const plan = Array.isArray(boss.planList) ? boss.planList : [];
  const contract = boss.contract as Record<string, unknown> | null;
  const stack = asArray(contract?.stack).map(String).slice(0, 3);
  const interfaceCount = asArray(contract?.interfaces).length;
  const dodCount = asArray(contract?.dod).length;

  return (
    <Card
      style={{
        padding: 18,
        borderColor: active ? "color-mix(in srgb, var(--warn) 30%, transparent)" : undefined,
      }}
    >
      <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
        <Tag>编排器</Tag>
        <span className="code truncate">{BOSS_MODEL}</span>
        <span
          className="flex items-center flex-none"
          style={{ gap: 6, fontSize: 11, color: "var(--ink-3)" }}
        >
          <Dot tone={tone} live={live} />
          {STATE_LABEL[boss.state] || boss.state}
        </span>
        <span className="ml-auto flex-none" style={{ fontSize: 10.5 }}>
          <span className="num" style={{ color: "var(--ink-2)" }}>
            {fmt(tokens)}
          </span>{" "}
          <span className="code">tokens</span>
        </span>
      </div>

      {plan.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          {plan.slice(0, MAX_PLAN_ROWS).map((item, i) => (
            <div
              key={i}
              className="flex items-center"
              style={{
                height: 32,
                gap: 10,
                borderTop: i > 0 ? "1px solid var(--line)" : undefined,
              }}
            >
              <span
                className="code flex-none"
                style={{ width: 18, color: "var(--ink-4)" }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span
                className="truncate"
                style={{
                  flex: "0 1 auto",
                  maxWidth: "42%",
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "var(--ink)",
                }}
              >
                {item.name}
              </span>
              <span
                className="truncate"
                style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--ink-2)" }}
              >
                {(item.task || "").replace(/\s+/g, " ")}
              </span>
            </div>
          ))}
          {plan.length > MAX_PLAN_ROWS && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--ink-4)" }}>
              还有 {plan.length - MAX_PLAN_ROWS} 项
            </div>
          )}
        </div>
      ) : (
        <div className="flex" style={{ gap: 8, marginTop: 12 }}>
          {boss.state === "planning" && (
            <span className="flex-none" style={{ paddingTop: 5 }}>
              <Dot tone="warn" live />
            </span>
          )}
          <div
            className="stream"
            style={{
              flex: 1,
              minWidth: 0,
              maxHeight: 60,
              overflow: "hidden",
              color: boss.text ? "var(--ink-2)" : "var(--ink-4)",
              maskImage:
                "linear-gradient(180deg, transparent 0, #000 10px, #000 calc(100% - 10px), transparent 100%)",
              WebkitMaskImage:
                "linear-gradient(180deg, transparent 0, #000 10px, #000 calc(100% - 10px), transparent 100%)",
            }}
          >
            {boss.text ? preview(boss.text, 420, live) : "正在生成任务契约…"}
          </div>
        </div>
      )}

      {contract && (
        <>
          <div style={{ height: 1, background: "var(--line)", margin: "14px 0 12px" }} />
          <div className="flex flex-wrap items-center" style={{ gap: "6px 12px" }}>
            {stack.map((item, i) => (
              <span key={i} className="code">
                {item}
              </span>
            ))}
            <span className="tag tag-quiet">{interfaceCount} 条接口</span>
            <span className="tag tag-quiet">{dodCount} 条完成定义</span>
          </div>
        </>
      )}
    </Card>
  );
}

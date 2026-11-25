"use client";

import { Card, Disclosure, Tag } from "@/components/ui/kit";
import type { Task } from "@/lib/types";
import { RichText } from "./RichText";
import { fmt } from "./shared";

export function ReworkSection({ task }: { task: Task }) {
  const rounds = task.rework || [];
  if (!rounds.length) return null;

  const fixed = rounds.filter((r) => r.ok).length;

  return (
    <Card style={{ padding: 18 }}>
      <div className="flex items-center gap-2">
        <div className="subtitle flex-none">返工</div>
        <Tag>
          <span className="num">{rounds.length}</span> 轮
        </Tag>
        <span className="ml-auto" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          <span className="num">{fixed}</span> 轮修复
        </span>
      </div>

      <div className="flex flex-col" style={{ marginTop: 12, gap: 6 }}>
        {rounds.map((r, i) => {
          const tokens = r.usage?.totalTokens || 0;
          const isFixer = r.target === "fixer";
          return (
            <div
              key={i}
              className="rounded-[8px] transition-colors duration-[120ms] hover:bg-[var(--hover)]"
              style={{ padding: "4px 6px" }}
            >
              <Disclosure
                summary={
                  <>
                    <span className="code flex-none">#{r.round}</span>
                    <Tag className="flex-none">
                      {isFixer ? "修复者" : "重跑工人"}
                    </Tag>
                    {!isFixer && (
                      <span
                        className="truncate flex-none"
                        style={{ fontSize: 12, color: "var(--ink-2)", maxWidth: 130 }}
                      >
                        {r.who}
                      </span>
                    )}
                    <span className="truncate flex-1" style={{ fontSize: 12, color: "var(--ink-3)", minWidth: 0 }}>
                      {r.reason}
                    </span>
                    <span className="flex items-center gap-2 flex-none">
                      <span style={{ fontSize: 11, color: r.ok ? "var(--ok)" : "var(--bad)" }}>
                        {r.ok ? "有产出" : "无产出"}
                      </span>
                      <span className="code">{fmt(tokens)}</span>
                    </span>
                  </>
                }
              >
                <div style={{ marginTop: 8, maxHeight: 220, overflow: "auto" }}>
                  {r.text || r.detail ? (
                    <RichText text={r.text || r.detail} />
                  ) : (
                    <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>无输出</span>
                  )}
                </div>
              </Disclosure>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

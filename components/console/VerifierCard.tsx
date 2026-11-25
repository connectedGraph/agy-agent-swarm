"use client";

import { useState } from "react";
import { Btn, Card, Dot, Icon, Tag } from "@/components/ui/kit";
import type { Task } from "@/lib/types";
import { RichText } from "./RichText";
import { fmt, isLive } from "./shared";

const STATE_LABEL: Record<string, string> = {
  idle: "待命",
  working: "验证中",
  done: "已完成",
  failed: "失败",
};

const STATE_TONE: Record<string, "neutral" | "accent" | "ok" | "bad"> = {
  idle: "neutral",
  working: "accent",
  done: "ok",
  failed: "bad",
};

const CLAMP = 280;

export function VerifierCard({ task }: { task: Task }) {
  const v = task.verifier;
  const [open, setOpen] = useState(false);
  if (!v) return null;

  const tone = STATE_TONE[v.state] || "neutral";
  const total = v.usage?.totalTokens || 0;
  const long = (v.text || "").length > CLAMP;

  return (
    <Card style={{ padding: 18 }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Tag className="flex-none">独立验证者</Tag>
        <span className="flex items-center gap-1.5 flex-none" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          <span className="code">agy</span>
          <span aria-hidden style={{ color: "var(--ink-4)" }}>
            ·
          </span>
          <span>合并后完整代码</span>
        </span>
        <span className="flex items-center gap-1.5 flex-none" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          <Dot tone={tone} live={isLive(v.state)} />
          {STATE_LABEL[v.state] || v.state}
        </span>
        <span className="ml-auto" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          <span className="num" style={{ fontSize: 11.5, color: "var(--ink-2)", fontWeight: 500 }}>
            {fmt(total)}
          </span>{" "}
          tokens
        </span>
      </div>

      <div style={{ position: "relative", marginTop: 12 }}>
        <div
          style={{
            maxHeight: !open && long ? 260 : undefined,
            overflow: !open && long ? "hidden" : undefined,
            color: v.text ? undefined : "var(--ink-4)",
          }}
        >
          {v.text ? <RichText text={v.text} /> : "验证者正在自己决定怎么验证…"}
        </div>
        {!open && long && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 56,
              background: "linear-gradient(180deg, transparent, var(--surface))",
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      {long && (
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => setOpen((s) => !s)}
          style={{ marginTop: 4, marginLeft: -9, color: "var(--accent)" }}
          icon={
            <Icon
              name="chevron"
              size={11}
              className={`transition-transform duration-200 ${open ? "-rotate-90" : "rotate-90"}`}
            />
          }
        >
          {open ? "收起" : "展开全文"}
        </Btn>
      )}

      {v.error && <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--bad)" }}>{v.error}</div>}
    </Card>
  );
}

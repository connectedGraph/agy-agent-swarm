"use client";

import { Dot, Spinner, ThemeToggle, Btn } from "@/components/ui/kit";

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: "var(--ink)",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 3,
        padding: 6,
        flex: "none",
      }}
    >
      <i style={{ borderRadius: 999, background: "var(--canvas)" }} />
      <i style={{ borderRadius: 999, background: "var(--canvas)", opacity: 0.55 }} />
      <i style={{ borderRadius: 999, background: "var(--canvas)", opacity: 0.55 }} />
      <i style={{ borderRadius: 999, background: "var(--accent)" }} />
    </div>
  );
}

export function Header({
  connected,
  goal,
  setGoal,
  count,
  setCount,
  submit,
  busy,
}: {
  connected: boolean;
  goal: string;
  setGoal: (v: string) => void;
  count: number;
  setCount: (v: number) => void;
  submit: () => void;
  busy: boolean;
}) {
  const disabled = busy || !goal.trim();

  return (
    <header
      className="flex items-center gap-3 px-4 flex-none"
      style={{ height: 56, borderBottom: "1px solid var(--line)" }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <BrandMark />
        <div className="leading-none">
          <div style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.01em" }}>Swarm</div>
          <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 3 }}>Agent 集群编排</div>
        </div>
      </div>

      <div className="flex items-center gap-2 ml-3">
        <span
          className="flex items-center gap-1.5"
          style={{ fontSize: 11.5, color: connected ? "var(--ink-2)" : "var(--bad)" }}
        >
          <Dot tone={connected ? "ok" : "bad"} />
          {connected ? "事件流已连接" : "事件流断开"}
        </span>
        <span className="hidden xl:inline" style={{ width: 1, height: 14, background: "var(--line)" }} />
        <span className="hidden xl:inline" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
          包工头 deepseek-v4.1-flash · 工人 agy ACP
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <span style={{ width: 1, height: 16, background: "var(--line)" }} />
        <div className="relative" style={{ width: "clamp(200px, 26vw, 360px)" }}>
          <input
            className="input"
            style={{ paddingRight: 30 }}
            placeholder="给集群一个目标，例如：补一套 API 冒烟测试"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            aria-label="任务目标"
          />
          {goal.trim() && !busy && (
            <span
              className="mono"
              style={{
                position: "absolute",
                right: 10,
                top: "50%",
                transform: "translateY(-50%)",
                fontSize: 10,
                color: "var(--ink-4)",
                pointerEvents: "none",
              }}
            >
              ↵
            </span>
          )}
        </div>
        <select
          className="select"
          style={{ width: 86 }}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          aria-label="工人数量"
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n} 工人
            </option>
          ))}
        </select>
        <Btn variant="primary" onClick={submit} disabled={disabled} icon={busy ? <Spinner /> : undefined}>
          {busy ? "派发中" : "派发"}
        </Btn>
      </div>
    </header>
  );
}

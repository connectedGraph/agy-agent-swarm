"use client";

import { Btn, Spinner } from "@/components/ui/kit";
import { BrandMark } from "./Header";

const EXAMPLES = ["补一套单元测试", "修一个明确缺陷", "写一份使用说明"];

export function EmptyState({
  goal,
  setGoal,
  onSubmit,
  busy,
}: {
  goal: string;
  setGoal: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const hasGoal = goal.trim().length > 0;

  return (
    <div className="h-full grid place-items-center" style={{ padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 460, textAlign: "center" }}>
        <div className="flex justify-center" style={{ marginBottom: 18 }}>
          <BrandMark size={36} />
        </div>

        <h2
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            lineHeight: 1.35,
            color: "var(--ink)",
          }}
        >
          约束式多代理编排
        </h2>

        <p
          style={{
            margin: "10px auto 24px",
            maxWidth: 420,
            fontSize: 12.5,
            lineHeight: 1.75,
            color: "var(--ink-3)",
          }}
        >
          编排器先产出任务契约、写入范围与验收命令，执行代理在 bubblewrap 沙箱中并行实现；合并后由真实命令和独立验证器裁决。
        </p>

        <div className="flex items-center justify-center" style={{ gap: 8 }}>
          <div className="relative" style={{ width: 320 }}>
            <input
              className="input"
              style={{ paddingRight: hasGoal ? 30 : 12 }}
              placeholder="输入目标，契约与验收标准由编排器生成"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSubmit();
              }}
              aria-label="任务目标"
            />
            {hasGoal && (
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
          <Btn
            variant="primary"
            onClick={onSubmit}
            disabled={busy || !hasGoal}
            icon={busy ? <Spinner /> : undefined}
          >
            {busy ? "提交中" : "提交任务"}
          </Btn>
        </div>

        <div
          className="flex flex-wrap items-center justify-center"
          style={{ gap: 6, marginTop: 16 }}
        >
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="tag hover:bg-[var(--surface-3)]"
              style={{
                height: 28,
                padding: "0 10px",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "background-color 120ms var(--ease)",
              }}
              onClick={() => setGoal(example)}
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

"use client";

import { Card, Dot, Toggle } from "@/components/ui/kit";
import type { GatewayStats } from "@/lib/types";
import { fmt } from "./shared";

export function GatewayCard({ gw, onToggle }: { gw: any; onToggle: () => void }) {
  const offline = !gw || gw.offline;
  const stats: GatewayStats | undefined = gw?.stats;
  const upstream: string = gw?.upstream || stats?.upstream || "—";
  const recent = (stats?.recent || []).slice(-5).reverse();

  return (
    <Card style={{ padding: 18 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.01em" }}>API 网关</span>
        <span
          className="flex items-center flex-none"
          style={{ gap: 6, marginLeft: "auto", fontSize: 11, color: "var(--ink-3)" }}
        >
          <Dot tone={offline ? "neutral" : "ok"} />
          {offline ? "未启动" : "在线"}
        </span>
      </div>

      {offline ? (
        <div style={{ fontSize: 11.5, lineHeight: 1.7, color: "var(--ink-3)", marginTop: 10 }}>
          运行 <span className="code">pnpm gateway</span> 启动录制网关，再把子代理的{" "}
          <span className="code">GOOGLE_GEMINI_BASE_URL</span> 指向它。
        </div>
      ) : (
        <>
          <div className="flex items-center" style={{ gap: 8, marginTop: 12 }}>
            <span style={{ fontSize: 12, color: "var(--ink-2)" }}>录制完整 API 报文</span>
            <span style={{ marginLeft: "auto", flex: "none" }}>
              <Toggle checked={!!gw.enabled} onChange={() => onToggle()} label="录制完整 API 报文" />
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginTop: 12,
            }}
          >
            <div style={{ background: "var(--surface-2)", borderRadius: 14, padding: 12 }}>
              <div style={{ fontSize: 11, color: "var(--ink-3)" }}>调用</div>
              <div
                className="num"
                style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.2, marginTop: 4 }}
              >
                {stats?.totalCalls ?? 0}
              </div>
            </div>
            <div style={{ background: "var(--surface-2)", borderRadius: 14, padding: 12 }}>
              <div style={{ fontSize: 11, color: "var(--ink-3)" }}>上游 token</div>
              <div
                className="num"
                style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.2, marginTop: 4 }}
              >
                {fmt(stats?.totalTokens || 0)}
              </div>
            </div>
          </div>

          <div
            className="code"
            title={upstream}
            style={{
              marginTop: 12,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {upstream}
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.02em" }}>最近调用</div>
            {recent.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 6 }}>暂无调用</div>
            ) : (
              <div style={{ marginTop: 4 }}>
                {recent.map((c, i) => (
                  <div key={i} className="flex items-center" style={{ height: 24, gap: 8 }}>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        flex: "none",
                        minWidth: 24,
                        color: c.status < 400 ? "var(--ok)" : "var(--bad)",
                      }}
                    >
                      {c.status}
                    </span>
                    <span
                      className="truncate"
                      style={{ fontSize: 12, color: "var(--ink-2)", flex: 1, minWidth: 0 }}
                    >
                      {c.model}
                    </span>
                    <span className="code" style={{ flex: "none" }}>
                      {fmt(c.totalTokens)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
